// Package ws is a minimal RFC 6455 WebSocket server (+ test Dial client), stdlib only.
//
// Scope: single-frame or fragmented text/binary messages, client-masked frames,
// server ping/pong/close control handling. No extensions (no permessage-deflate),
// no proxy support in Dial. Sized for small signaling frames, not bulk transfer.
package ws

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// Opcodes.
const (
	OpText   = 0x1
	OpBinary = 0x2
	OpClose  = 0x8
	OpPing   = 0x9
	OpPong   = 0xA
)

// Close codes we send.
const (
	CloseNormal        = 1000
	CloseGoingAway     = 1001
	CloseTooBig        = 1009
	ClosePolicy        = 1008
	CloseDuplicatePeer = 4400 // app: second sender
	CloseInternal      = 1011
	// CloseProtocolError is 1002 (RFC 6455: the peer violated the protocol).
	CloseProtocolError = 1002
)

// closeCodeValidOnWire reports whether code may be sent in a close frame.
// 1005/1006/1015 are never sent on the wire by anyone (they are local-only
// sentinels), and 1016-2999 are unassigned/reserved.
func closeCodeValidOnWire(code int) bool {
	switch {
	case code >= 3000 && code <= 4999: // registered application codes
		return true
	case code >= 1000 && code <= 1003:
		return true
	case code == 1007 || code == 1008 || code == 1009 || code == 1010 || code == 1011:
		return true
	default:
		return false
	}
}

var (
	ErrTooBig      = errors.New("ws: message exceeds limit")
	ErrProtocol    = errors.New("ws: protocol violation")
	ErrCleanClose  = errors.New("ws: clean close")
	ErrUncleanPeer = errors.New("ws: peer went away")
)

// Conn is one WebSocket connection. Safe for one concurrent reader and one
// concurrent writer (typical pump pair).
type Conn struct {
	conn      net.Conn
	br        *bufio.Reader
	bw        *bufio.Writer
	client    bool // Dial side: masks outbound, accepts unmasked inbound
	maxMsg    int
	writeMu   sync.Mutex
	closeOnce sync.Once
	closed    atomic.Bool // no further data frames may be written
	closeSent atomic.Bool // a close frame has already gone out
}

// AcceptKey is exported for tests.
func AcceptKey(key string) string {
	h := sha1.Sum([]byte(key + guid))
	return base64.StdEncoding.EncodeToString(h[:])
}

// ServeWS upgrades w/r to WebSocket and returns the Conn. Caller owns pumps.
func ServeWS(w http.ResponseWriter, r *http.Request, maxMsg int) (*Conn, error) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return nil, ErrProtocol
	}
	if !headerHas(r.Header, "Upgrade", "websocket") || !headerHas(r.Header, "Connection", "upgrade") {
		http.Error(w, "not a websocket handshake", http.StatusBadRequest)
		return nil, ErrProtocol
	}
	if v := r.Header.Get("Sec-WebSocket-Version"); v != "" && v != "13" {
		http.Error(w, "unsupported version", http.StatusBadRequest)
		return nil, ErrProtocol
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "missing key", http.StatusBadRequest)
		return nil, ErrProtocol
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return nil, ErrProtocol
	}
	nc, rw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + AcceptKey(key) + "\r\n\r\n"
	if _, err := rw.WriteString(resp); err != nil {
		nc.Close()
		return nil, err
	}
	if err := rw.Flush(); err != nil {
		nc.Close()
		return nil, err
	}
	c := &Conn{conn: nc, br: rw.Reader, bw: rw.Writer, maxMsg: maxMsg}
	return c, nil
}

func headerHas(h http.Header, name, want string) bool {
	for _, part := range strings.Split(h.Get(name), ",") {
		if strings.EqualFold(strings.TrimSpace(part), want) {
			return true
		}
	}
	return false
}

// ReadMessage returns the next complete data message (opcode, payload).
// Control frames are handled inline (ping→pong). Returns ErrCleanClose after
// a close handshake, or a *CloseError-ish plain error on protocol violations.
func (c *Conn) ReadMessage() (byte, []byte, error) {
	var msg []byte
	var msgOp byte
	var started bool
	for {
		fin, op, payload, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch op {
		case OpPing:
			_ = c.WriteControl(OpPong, payload)
			continue
		case OpPong:
			continue
		case OpClose:
			// RFC 6455 5.5.1: a close payload is either empty or at least the
			// 2-byte code. A 1-byte payload is malformed, so do not echo it back
			// verbatim (that would emit a malformed close of our own).
			code := CloseNormal
			echo := []byte(nil)
			if len(payload) >= 2 {
				code = int(payload[0])<<8 | int(payload[1])
				// Never propagate a code the RFC forbids on the wire (1005
				// never-sent, 1006 abnormal, 1015 TLS failure) or a reserved
				// 1016-2999; report the close as a plain normal one instead.
				if !closeCodeValidOnWire(code) {
					code = CloseNormal
					echo = nil
				} else {
					echo = payload
				}
			}
			if echo != nil {
				_ = c.WriteControl(OpClose, echo) // locked: writer pump may be active
			}
			c.closed.Store(true)
			return 0, nil, fmt.Errorf("%w (code %d)", ErrCleanClose, code)
		case OpText, OpBinary:
			if started {
				_ = c.closeLocked(CloseProtocolError, "interleaved message")
				return 0, nil, fmt.Errorf("%w: new message before FIN", ErrProtocol)
			}
			started, msgOp, msg = true, op, payload
		case 0x0: // continuation
			if !started {
				_ = c.closeLocked(CloseProtocolError, "stray continuation")
				return 0, nil, fmt.Errorf("%w: stray continuation", ErrProtocol)
			}
			if len(msg)+len(payload) > c.maxMsg {
				_ = c.closeLocked(CloseTooBig, "too big")
				return 0, nil, ErrTooBig
			}
			msg = append(msg, payload...)
		default:
			_ = c.closeLocked(CloseProtocolError, "bad opcode")
			return 0, nil, fmt.Errorf("%w: bad opcode %d", ErrProtocol, op)
		}
		if fin {
			return msgOp, msg, nil
		}
	}
}

func (c *Conn) readFrame() (fin bool, op byte, payload []byte, err error) {
	var hdr [2]byte
	if _, err = io.ReadFull(c.br, hdr[:]); err != nil {
		return false, 0, nil, err
	}
	fin = hdr[0]&0x80 != 0
	rsv := hdr[0] & 0x70
	op = hdr[0] & 0x0F
	masked := hdr[1]&0x80 != 0
	n := int64(hdr[1] & 0x7F)
	// Server side expects masked inbound; Dial side expects unmasked.
	if masked == c.client {
		// An unmasked client frame is a PROTOCOL violation (RFC 6455 §5.1), so it
		// gets 1002. This used to send 1008 (policy violation), which is a
		// different condition and told the peer the wrong thing.
		_ = c.closeLocked(CloseProtocolError, "unmasked frame")
		return false, 0, nil, fmt.Errorf("%w: wrong masking", ErrProtocol)
	}
	if rsv != 0 {
		// We negotiate no extensions, so any reserved bit is a violation. Say so
		// with 1002 — returning a bare error made Close() emit 1000 (a normal
		// closure), which told the peer nothing was wrong.
		_ = c.closeLocked(CloseProtocolError, "rsv bits set")
		return false, 0, nil, fmt.Errorf("%w: extensions unsupported", ErrProtocol)
	}
	switch n {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		n = int64(ext[0])<<8 | int64(ext[1])
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		n = 0
		for _, b := range ext {
			n = n<<8 | int64(b)
		}
		if n < 0 {
			return false, 0, nil, fmt.Errorf("%w: bad length", ErrProtocol)
		}
	}
	isControl := op >= 0x8
	if isControl && !fin {
		_ = c.closeLocked(CloseProtocolError, "fragmented control")
		return false, 0, nil, fmt.Errorf("%w: fragmented control frame", ErrProtocol)
	}
	if isControl && n > 125 {
		_ = c.closeLocked(CloseProtocolError, "control too big")
		return false, 0, nil, fmt.Errorf("%w: control frame payload %d > 125", ErrProtocol, n)
	}
	if !isControl && (op == 0x3 || op == 0x4 || op == 0x5 || op == 0x6 || op == 0x7 || op == 0xB || op == 0xC || op == 0xD || op == 0xE || op == 0xF) {
		_ = c.closeLocked(CloseProtocolError, "bad opcode")
		return false, 0, nil, fmt.Errorf("%w: bad opcode %d", ErrProtocol, op)
	}
	if n > int64(c.maxMsg) {
		// Drain-free reject: close immediately (peer must go away).
		_ = c.closeLocked(CloseTooBig, "too big")
		return false, 0, nil, ErrTooBig
	}
	var mask [4]byte
	if masked {
		if _, err = io.ReadFull(c.br, mask[:]); err != nil {
			return false, 0, nil, err
		}
	}
	payload = make([]byte, n)
	if _, err = io.ReadFull(c.br, payload); err != nil {
		return false, 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return fin, op, payload, nil
}

// WriteMessage writes one unfragmented data frame.
func (c *Conn) WriteMessage(op byte, p []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed.Load() {
		return ErrCleanClose
	}
	return c.writeFrame(op, p)
}

// WriteControl writes a control frame immediately (deadline-guarded).
//
// The deadline is set while writeMu is held and released to zero on the way
// out, which is safe because no other writer can be mid-write: the whole
// critical section is serialized. The bug this replaces was setting the
// deadline BEFORE taking the lock, which let a concurrent WriteControl zero it
// out from under an in-flight data write.
func (c *Conn) WriteControl(op byte, p []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed.Load() {
		return ErrCleanClose
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	defer c.conn.SetWriteDeadline(time.Time{})
	return c.writeFrame(op, p)
}

func (c *Conn) writeFrame(op byte, p []byte) error {
	n := len(p)
	var hdr [10]byte
	hdr[0] = 0x80 | op
	maskBit := byte(0)
	if c.client {
		maskBit = 0x80
	}
	switch {
	case n <= 125:
		hdr[1] = maskBit | byte(n)
		if _, err := c.bw.Write(hdr[:2]); err != nil {
			return err
		}
	case n <= 65535:
		hdr[1] = maskBit | 126
		hdr[2], hdr[3] = byte(n>>8), byte(n)
		if _, err := c.bw.Write(hdr[:4]); err != nil {
			return err
		}
	default:
		hdr[1] = maskBit | 127
		for i := 0; i < 8; i++ {
			hdr[2+i] = byte(n >> (56 - 8*i))
		}
		if _, err := c.bw.Write(hdr[:10]); err != nil {
			return err
		}
	}
	if c.client {
		var key [4]byte
		if _, err := rand.Read(key[:]); err != nil {
			return err
		}
		if _, err := c.bw.Write(key[:]); err != nil {
			return err
		}
		masked := make([]byte, n)
		for i := range p {
			masked[i] = p[i] ^ key[i%4]
		}
		p = masked
	}
	if _, err := c.bw.Write(p); err != nil {
		return err
	}
	return c.bw.Flush()
}

// closeWriteTimeout bounds every close-frame write. The close path holds
// writeMu, so a peer that has stopped reading must not be able to pin the
// writer pump and this goroutine indefinitely — that leak was two goroutines
// and a socket per connection.
const closeWriteTimeout = 5 * time.Second

func (c *Conn) writeClose(code int, reason string) error {
	// A close payload is the 2-byte code plus a UTF-8 reason, and RFC 6455 caps
	// the control-frame payload at 125 bytes, so the reason is truncated to
	// fit rather than silently clipped by a fixed 4-byte slot.
	if len(reason) > 123 {
		reason = reason[:123]
	}
	p := make([]byte, 2, 2+len(reason))
	p[0], p[1] = byte(code>>8), byte(code)
	p = append(p, reason...)
	// Set the deadline here, not in the caller: every close path funnels here.
	_ = c.conn.SetWriteDeadline(time.Now().Add(closeWriteTimeout))
	err := c.writeFrame(OpClose, p)
	_ = c.conn.SetWriteDeadline(time.Time{})
	c.closeSent.Store(true)
	return err
}

// closeLocked serializes error closes against the writer pump, and marks the
// connection closed so no data frame can follow the Close.
//
// The flag matters: without it the writer pump (which gates only on c.closed)
// kept emitting data frames after the server had already sent a Close, which
// RFC 6455 5.5.2 forbids.
func (c *Conn) closeLocked(code int, reason string) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.closed.Store(true)
	return c.writeClose(code, reason)
}

// Close sends a close frame once and closes the TCP connection.
// Serialized against the writer pump via writeMu (may wait for in-flight write).
func (c *Conn) Close() error {
	c.closeOnce.Do(func() {
		c.writeMu.Lock()
		defer c.writeMu.Unlock()
		c.closed.Store(true)
		// Skip the frame if a Close was already sent (the peer's close was
		// echoed by ReadMessage). RFC 6455 5.5.2: after sending and receiving
		// a Close, no further data may be sent — emitting two close frames is a
		// protocol violation, not a harmless duplicate.
		if !c.closeSent.Load() {
			_ = c.writeClose(CloseNormal, "")
		}
		_ = c.conn.Close()
	})
	return nil
}

// CloseWith sends code+reason then closes.
func (c *Conn) CloseWith(code int, reason string) error {
	c.closeOnce.Do(func() {
		c.writeMu.Lock()
		defer c.writeMu.Unlock()
		c.closed.Store(true)
		_ = c.writeClose(code, reason)
		_ = c.conn.Close()
	})
	return nil
}

// SetDeadline proxies to the underlying conn (used for read timeouts).
func (c *Conn) SetDeadline(t time.Time) error      { return c.conn.SetDeadline(t) }
func (c *Conn) SetReadDeadline(t time.Time) error  { return c.conn.SetReadDeadline(t) }
func (c *Conn) SetWriteDeadline(t time.Time) error { return c.conn.SetWriteDeadline(t) }

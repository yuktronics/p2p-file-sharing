package ws

import (
	"crypto/rand"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func echoServer(t *testing.T, maxMsg int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := ServeWS(w, r, maxMsg)
		if err != nil {
			return
		}
		defer c.Close()
		for {
			op, p, err := c.ReadMessage()
			if err != nil {
				return
			}
			if err := c.WriteMessage(op, p); err != nil {
				return
			}
		}
	}))
}

func wsURL(s *httptest.Server) string {
	return "ws" + strings.TrimPrefix(s.URL, "http")
}

func TestEchoTextAndBinary(t *testing.T) {
	s := echoServer(t, 1<<20)
	defer s.Close()
	c, err := Dial(wsURL(s), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.WriteMessage(OpText, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	op, p, err := c.ReadMessage()
	if err != nil || op != OpText || string(p) != "hello" {
		t.Fatalf("echo = %d %q %v", op, p, err)
	}
	big := make([]byte, 200000)
	for i := range big {
		big[i] = byte(i)
	}
	if err := c.WriteMessage(OpBinary, big); err != nil {
		t.Fatal(err)
	}
	op, p, err = c.ReadMessage()
	if err != nil || op != OpBinary || len(p) != len(big) || p[7] != 7 {
		t.Fatalf("binary echo failed: %d %d %v", op, len(p), err)
	}
}

func TestPingPong(t *testing.T) {
	s := echoServer(t, 1<<20)
	defer s.Close()
	c, err := Dial(wsURL(s), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	// Ping is answered at frame level (never surfaces as a message):
	// prove liveness by echoing text right after a ping.
	if err := c.WriteControl(OpPing, []byte("p")); err != nil {
		t.Fatal(err)
	}
	if err := c.WriteMessage(OpText, []byte("after-ping")); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	op, p, err := c.ReadMessage()
	if err != nil || op != OpText || string(p) != "after-ping" {
		t.Fatalf("echo = %d %q %v", op, p, err)
	}
}

// writeFragment writes one client-masked frame with an explicit FIN bit. The
// server has no exported fragmented-write path (WriteMessage is always FIN),
// and the fragmentation defences can only be tested by producing real fragments.
func writeFragment(c *Conn, op byte, payload []byte, fin bool) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed.Load() {
		return ErrCleanClose
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	defer c.conn.SetWriteDeadline(time.Time{})
	n := len(payload)
	var hdr [14]byte
	h := 2
	hdr[0] = op
	if fin {
		hdr[0] |= 0x80
	}
	// Length encoding must match the real framing rules, or the server
	// misparses the frame and reports a protocol error instead of the condition
	// under test: 126 means a 2-byte extended length, 127 a 8-byte one.
	switch {
	case n <= 125:
		hdr[1] = 0x80 | byte(n)
	case n <= 65535:
		hdr[1] = 0x80 | 126
		hdr[2], hdr[3] = byte(n>>8), byte(n)
		h = 4
	default:
		hdr[1] = 0x80 | 127
		for i := 0; i < 8; i++ {
			hdr[2+i] = byte(uint64(n) >> (56 - 8*i))
		}
		h = 10
	}
	var key [4]byte
	if _, err := rand.Read(key[:]); err != nil {
		return err
	}
	copy(hdr[h:h+4], key[:])
	if _, err := c.bw.Write(hdr[:h+4]); err != nil {
		return err
	}
	masked := make([]byte, n)
	for i := range payload {
		masked[i] = payload[i] ^ key[i%4]
	}
	if _, err := c.bw.Write(masked); err != nil {
		return err
	}
	return c.bw.Flush()
}

func TestTooBigCloses(t *testing.T) {
	s := echoServer(t, 64)
	defer s.Close()
	c, err := Dial(wsURL(s), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.WriteMessage(OpText, make([]byte, 1000))
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _, err = c.ReadMessage()
	if err == nil {
		t.Fatal("expected close after oversize")
	}
	// The close CODE is the diagnostic a client sees and what operators read in
	// the logs; the old version only asserted err != nil, so 1009 could have
	// become 1000 (a normal closure) and this would still have passed. Dial-side,
	// so this observes the close frame rather than the server's ErrTooBig.
	if !strings.Contains(err.Error(), "code 1009") {
		t.Errorf("oversize closed with %v, want close code 1009 (too big)", err)
	}
}

// The fragment accumulator is the memory-exhaustion defence: a peer that sends
// 32 KB fragments forever must be cut off, not allowed to grow msg without bound.
// The per-frame cap alone does not cover this — the accumulator is what has to
// refuse. Nothing tested it.
func TestFragmentAccumulatorIsCapped(t *testing.T) {
	s := echoServer(t, 4096) // total-message cap
	defer s.Close()
	c, err := Dial(wsURL(s), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	// 200 fragments of 1 KB each: 200 KB against a 4 KB cap, sent as real
	// fragmented frames (FIN=0 text, then continuations).
	frag := make([]byte, 1024)
	_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	for i := 0; i < 200; i++ {
		op := byte(0x0) // continuation
		if i == 0 {
			op = OpText
		}
		if err := writeFragment(c, op, frag, i == 199); err != nil {
			break // the server already closed on us
		}
	}
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _, err = c.ReadMessage()
	if err == nil {
		t.Fatal("expected a close once the accumulated message passed the cap")
	}
	if !errors.Is(err, ErrTooBig) && !strings.Contains(err.Error(), "code 1009") {
		t.Errorf("fragment overflow read = %v, want ErrTooBig or close 1009", err)
	}
}

// Protocol violations must be reported as 1002 (protocol error), not as a normal
// closure. The old code returned a bare error for RSV bits, a bad opcode, an
// oversized control frame, a fragmented control frame and a stray continuation,
// so the caller sent 1000 and the peer was told nothing was wrong. These are the
// two memory-safety defences (control-frame limits, opcode validity), so they
// need to be pinned.
func TestProtocolViolationsCloseWith1002(t *testing.T) {
	for _, tc := range []struct {
		name  string
		bytes []byte
	}{
		{"rsv1 bit set", []byte{0xC1, 0x80, 0x00, 0x00, 0x00, 0x00}},
		{"bad opcode 3", []byte{0x83, 0x80, 0x00, 0x00, 0x00, 0x00}},
		{"control frame too big (126)", append([]byte{0x89, 0x80 | 126, 0x01, 0x00, 0x00, 0x00, 0x00}, make([]byte, 1)...)},
		{"fragmented control frame", []byte{0x09, 0x80, 0x00, 0x00, 0x00, 0x00}},
		{"stray continuation", []byte{0x80, 0x80, 0x00, 0x00, 0x00, 0x00}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := echoServer(t, 1<<20)
			defer s.Close()
			raw, err := dialRawTCP(t, s.URL)
			if err != nil {
				t.Fatal(err)
			}
			defer raw.Close()
			_ = raw.SetReadDeadline(time.Now().Add(3 * time.Second))
			if _, err := raw.Write(tc.bytes); err != nil {
				t.Fatal(err)
			}
			buf := make([]byte, 64)
			n, rerr := raw.Read(buf)
			if n < 4 {
				t.Fatalf("expected a close frame, got n=%d err=%v", n, rerr)
			}
			if buf[0] != 0x88 {
				t.Fatalf("expected a close frame, got opcode %#x", buf[0])
			}
			if code := int(buf[2])<<8 | int(buf[3]); code != CloseProtocolError {
				t.Errorf("closed with %d, want %d (1002, protocol error)", code, CloseProtocolError)
			}
		})
	}
}

func TestBadHandshakeRejected(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = ServeWS(w, r, 1024)
	}))
	defer s.Close()
	if _, err := Dial(wsURL(s)+"/x", 1024); err == nil {
		// Dial always handshakes correctly; force a bad one via raw GET.
		t.Log("dial ok (expected); raw bad handshake covered below")
	}
	// Raw request without Upgrade must be 400.
	resp, err := http.Get(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestUnmaskedClientFrameRejected(t *testing.T) {
	s := echoServer(t, 1<<20)
	defer s.Close()
	// Raw TCP: complete handshake, then send an UNMASKED text frame (protocol violation).
	raw, err := dialRawTCP(t, s.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	// "hi" unmasked: 0x81 0x02 'h' 'i'
	if _, err := raw.Write([]byte{0x81, 0x02, 'h', 'i'}); err != nil {
		t.Fatal(err)
	}
	_ = raw.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 16)
	n, err := raw.Read(buf)
	if n < 2 {
		t.Fatalf("expected a server close frame, got n=%d err=%v", n, err)
	}
	// 0x88 is FIN|opcode 8 (close). This was `if !errors.Is(err, nil)` — which is
	// `err == nil`, so the branch asserted nothing in either direction.
	if buf[0] != 0x88 {
		t.Fatalf("expected opcode 8 with FIN (0x88), got %#x", buf[0])
	}
	// Frame layout: [0] = FIN|opcode, [1] = payload length, [2:4] = close code.
	// (An earlier version read the code from [1:3], mistaking the length byte
	// for the high byte.)
	if int(buf[1]) < 2 {
		t.Fatalf("close frame payload is %d bytes; a close payload is empty or >= 2", buf[1])
	}
	code := int(buf[2])<<8 | int(buf[3])
	if code != CloseProtocolError {
		t.Errorf("unmasked client frame closed with %d, want %d (RFC 6455 protocol error)", code, CloseProtocolError)
	}
}

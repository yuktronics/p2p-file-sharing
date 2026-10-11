package server

import (
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"signal/internal/rooms"
	"signal/internal/ws"
)

// maxUpgradeBody bounds how much of an upgrade request's body is drained. An
// upgrade carries no body; anything present is either a client bug or a probe.
// Draining a bounded amount is enough to keep the bytes out of the frame stream.
const maxUpgradeBody = 4 << 10 // 4 KB

// handleWS upgrades and pumps one peer: reader routes frames, writer drains
// the peer send channel. Channel close (bye/delete/expire) ends the writer,
// which sends bye and hangs up.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("id")
	_, roomOK := s.store.Get(roomID)
	if !roomOK {
		// Disabled rooms upgrade-then-close with 4401 (browsers can't read
		// HTTP error statuses from a WS handshake — WIRE-PROTOCOL.md).
		if reason, dis := s.store.Disabled(roomID); dis {
			if c, err := ws.ServeWS(w, r, s.cfg.MaxMsg); err == nil {
				closeDisabled(c, reason)
			}
			return
		}
		http.Error(w, "not_found", http.StatusNotFound)
		return
	}
	role := r.URL.Query().Get("role")
	if role != "sender" && role != "receiver" {
		http.Error(w, "role must be sender|receiver", http.StatusBadRequest)
		return
	}
	peerID := r.URL.Query().Get("peer")
	if peerID == "" || len(peerID) > 64 {
		if role == "sender" {
			peerID = "sender"
		} else {
			peerID = "rx-" + randPeer(8)
		}
	}
	// Drain and cap the request body BEFORE hijacking. Hijack hands the raw
	// bufio.Reader to the frame parser, so any unread body bytes are read as if
	// they were WebSocket frames: a request carrying Content-Length and a body
	// completed the upgrade and then died with close 1008 ("extensions
	// unsupported") as the first body byte was parsed as a frame header. Every
	// other JSON handler on this server is capped; this one was not.
	capBody(w, r)
	_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, maxUpgradeBody))
	c, err := ws.ServeWS(w, r, s.cfg.MaxMsg)
	if err != nil {
		return // ServeWS already wrote the HTTP error
	}
	send := make(chan []byte, 16) // small on purpose: bounds per-peer memory (see BENCHMARKS.md)
	_, displaced, err := s.store.Join(roomID, peerID, role, send)
	if err != nil {
		switch err {
		case rooms.ErrDuplicatePeer:
			c.CloseWith(ws.CloseDuplicatePeer, "duplicate_sender")
		case rooms.ErrRoomFull:
			c.CloseWith(ws.ClosePolicy, "room_full")
		default:
			c.CloseWith(ws.CloseInternal, "join failed")
		}
		return
	}
	// Join displaced an entry it had been told was dead — a reconnect over a
	// socket the OS already killed (the mobile freeze). Closing that peer's send
	// channel is what ends the old writer pump: it writes bye and hangs up, so
	// the id is served by exactly one connection instead of two racing for it.
	for _, ch := range displaced {
		close(ch)
	}
	s.wsConns.Add(1)
	defer s.wsConns.Add(-1)

	// Writer pump: queued frames + server pings; channel close → bye + hang up.
	writeDone := make(chan struct{})
	go func() {
		defer close(writeDone)
		s.writePump(c, send, peerID, roomID)
	}()

	// Announce presence to the room (best effort), then replay any cached
	// offer to late-joining receivers (sender offers at its own join time).
	if pf, ok := s.store.Presence(roomID); ok {
		s.store.Broadcast(roomID, pf)
	}
	if role == "receiver" {
		s.store.ReplayOffer(roomID, peerID)
	}

	// Reader pump with idle deadline: any frame refreshes it.
	_ = c.SetReadDeadline(time.Now().Add(2*s.cfg.PingInterval + 10*time.Second))
	for {
		op, payload, err := c.ReadMessage()
		if err != nil {
			break
		}
		_ = c.SetReadDeadline(time.Now().Add(2*s.cfg.PingInterval + 10*time.Second))
		if op != ws.OpText {
			continue
		}
		var f rooms.Frame
		if err := json.Unmarshal(payload, &f); err != nil {
			continue // malformed frame ignored, connection survives
		}
		if f.From == "" {
			f.From = peerID
		}
		if f.From != peerID {
			continue // no spoofing other peers
		}
		if f.Kind == "ping" {
			continue // keepalive, nothing to route
		}
		// Live manifest update: the sender removed/added files after the link went
		// live. Mutates the room and pushes the new list to every receiver so a
		// deleted file disappears from an open receiver page immediately.
		if f.Kind == "files" {
			s.framesIn.Add(1)
			var upd struct {
				Files []rooms.FileMeta `json:"files"`
			}
			if err := json.Unmarshal([]byte(f.Payload), &upd); err != nil {
				s.routeErrors.Add(1)
				continue
			}
			// The live manifest is the ONLY way a filename can change after the
			// room was created, and it is sender-controlled — the sender is
			// exactly the party validFileMeta exists to constrain. Without this
			// check a name the REST path rejects (traversal, bidi, a reserved
			// Windows device) is accepted here and becomes the name the receiver
			// saves to disk. Verified live: "../../etc/passwd" is a 400 on
			// POST /api/rooms but was served to receivers via this frame.
			if !validManifest(upd.Files) {
				s.routeErrors.Add(1)
				continue
			}
			if _, err := s.store.UpdateManifest(roomID, peerID, upd.Files); err != nil {
				s.routeErrors.Add(1)
				continue
			}
			continue
		}
		s.framesIn.Add(1)
		if _, rerr := s.store.Route(roomID, f); rerr != nil {
			// Unknown target / closed room / spoof: drop silently (counted in store).
			s.routeErrors.Add(1)
			continue
		}
	}
	// Leave returns this peer's send channel so the writer pump can finish.
	// Closing it here is what unblocks the pump: without the close it would sit
	// in select forever, because once the peer is out of the map nothing else
	// can reach its channel. Then the pump writes the bye, and we wait for it
	// so the connection's goroutines are gone before this handler returns.
	//
	// Passing send makes Leave identity-checked, so a socket that was displaced
	// by a reconnect cannot unregister the connection that replaced it.
	for _, ch := range s.store.Leave(roomID, peerID, send) {
		close(ch)
	}
	if pf, ok := s.store.Presence(roomID); ok {
		s.store.Broadcast(roomID, pf)
	}
	// Bound the wait: if the pump cannot finish (a wedged socket write), the
	// handler must still return. c.Close below has already closed the
	// underlying conn, which is what normally wakes the pump.
	select {
	case <-writeDone:
	case <-time.After(2 * time.Second):
		s.writeErrors.Add(1)
	}
	c.Close()
}

// wsWriter is the slice of *ws.Conn the writer pump uses. It is an interface so
// the pump can be driven by a stub in tests: a write failure is what proves a
// socket dead, and on a real httptest connection the reader always notices the
// break first, so the MarkDead branch was unreachable and therefore untested —
// while being the branch the entire mobile reconnect depends on.
type wsWriter interface {
	WriteMessage(op byte, p []byte) error
	WriteControl(op byte, p []byte) error
	SetWriteDeadline(t time.Time) error
	Close() error
}

// writePump drains a peer's send channel and keeps the connection alive.
//
// A failed write is the ONLY proof the server has that a socket is gone, and the
// reader cannot always supply it: a frozen mobile tab sends nothing, so the
// reader sits on its deadline for a full 2*PingInterval+10s while the ping here
// fails at once. Marking the peer dead on that failure is what lets the tab's
// reconnect displace its own entry instead of being refused as a duplicate.
func (s *Server) writePump(c wsWriter, send chan []byte, peerID, roomID string) {
	t := time.NewTicker(s.cfg.PingInterval)
	defer t.Stop()
	for {
		select {
		case msg, ok := <-send:
			if !ok {
				bye, _ := json.Marshal(rooms.Frame{From: "server", To: peerID, Kind: "bye"})
				_ = c.WriteMessage(ws.OpText, bye)
				c.Close()
				return
			}
			_ = c.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.WriteMessage(ws.OpText, msg); err != nil {
				s.writeErrors.Add(1)
				s.store.MarkDead(roomID, peerID, send)
				return
			}
		case <-t.C:
			// A failed ping means the socket is gone. Returning (rather than
			// swallowing the error) is what stopped this pump from looping
			// forever on a dead connection.
			if err := c.WriteControl(ws.OpPing, nil); err != nil {
				s.writeErrors.Add(1)
				s.store.MarkDead(roomID, peerID, send)
				return
			}
		}
	}
}

func randPeer(n int) string {
	const a = "0123456789abcdefghijklmnopqrstuvwxyz"
	out := make([]byte, n)
	// crypto/rand read; fall back deterministically only on total failure.
	if _, err := rand.Read(out); err != nil {
		for i := range out {
			out[i] = a[time.Now().UnixNano()%int64(len(a))]
		}
		return string(out)
	}
	for i := range out {
		out[i] = a[int(out[i])%len(a)]
	}
	return string(out)
}

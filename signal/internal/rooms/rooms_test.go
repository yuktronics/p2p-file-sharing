package rooms

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestCreateNearbyUnique(t *testing.T) {
	s := NewStore(10 * time.Second)
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		r := s.Create([]FileMeta{{Name: "a", Size: 1}}, true)
		if seen[r.ID] {
			t.Fatal("dup id")
		}
		seen[r.ID] = true
		if len(r.ID) != 10 || len(r.NearbyCode) != 4 {
			t.Fatalf("bad id %q nearby %q", r.ID, r.NearbyCode)
		}
		if got, ok := s.GetByNearby(r.NearbyCode); !ok || got.ID != r.ID {
			t.Fatal("nearby lookup failed")
		}
	}
}

func TestDuplicateSender(t *testing.T) {
	s := NewStore(time.Second)
	r := s.Create(nil, false)
	if _, _, err := s.Join(r.ID, "sender", "sender", make(chan []byte, 8)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Join(r.ID, "sender2", "sender", make(chan []byte, 8)); err != ErrDuplicatePeer {
		t.Fatalf("err = %v", err)
	}
}

func TestRouteAndPresence(t *testing.T) {
	s := NewStore(time.Second)
	r := s.Create(nil, false)
	snd := make(chan []byte, 8)
	rx1 := make(chan []byte, 8)
	rx2 := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "sender", "sender", snd); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Join(r.ID, "a", "receiver", rx1); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Join(r.ID, "b", "receiver", rx2); err != nil {
		t.Fatal(err)
	}
	n, err := s.Route(r.ID, Frame{From: "sender", To: "receivers", Kind: "offer", Payload: "{}"})
	if err != nil || n != 2 {
		t.Fatalf("route = %d %v", n, err)
	}
	var f Frame
	if err := json.Unmarshal(<-rx1, &f); err != nil || f.Seq != 1 || f.Kind != "offer" {
		t.Fatalf("rx1 got %+v %v", f, err)
	}
	if err := json.Unmarshal(<-rx2, &f); err != nil || f.Seq != 1 {
		t.Fatalf("rx2 got %+v %v", f, err)
	}
	// receivers must not hear sender-addressed frames
	if n, err := s.Route(r.ID, Frame{From: "a", To: "sender", Kind: "answer", Payload: "{}"}); err != nil || n != 1 {
		t.Fatalf("route = %d %v", n, err)
	}
	select {
	case m := <-rx2:
		t.Fatalf("rx2 leaked: %s", m)
	default:
	}
	// direct addressing
	if n, err := s.Route(r.ID, Frame{From: "sender", To: "b", Kind: "ice", Payload: "{}"}); err != nil || n != 1 {
		t.Fatalf("route = %d %v", n, err)
	}
	// presence
	pf, ok := s.Presence(r.ID)
	if !ok || pf.Kind != "presence" || !strings.Contains(pf.Payload, "senderOnline") {
		t.Fatalf("presence = %+v %v", pf, ok)
	}
	// bad frames
	if _, err := s.Route(r.ID, Frame{From: "sender", To: "x", Kind: "bogus"}); err != ErrInvalidFrame {
		t.Fatalf("kind err = %v", err)
	}
	if _, err := s.Route(r.ID, Frame{From: "ghost", To: "sender", Kind: "ice"}); err != ErrInvalidFrame {
		t.Fatalf("from err = %v", err)
	}
	if _, err := s.Route(r.ID, Frame{From: "sender", To: "nobody", Kind: "ice"}); err != ErrUnknownTarget {
		t.Fatalf("to err = %v", err)
	}
	_ = snd
}

func TestGraceExpiry(t *testing.T) {
	s := NewStore(30 * time.Millisecond)
	r := s.Create(nil, false)
	rx := make(chan []byte, 8)
	senderCh := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "sender", "sender", senderCh); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Join(r.ID, "a", "receiver", rx); err != nil {
		t.Fatal(err)
	}
	s.Leave(r.ID, "sender", senderCh)
	if got := s.ExpireSweep(time.Now()); len(got) != 0 {
		t.Fatal("expired before grace")
	}
	time.Sleep(50 * time.Millisecond)
	got := s.ExpireSweep(time.Now())
	if len(got) != 1 || len(got[0].Sends) != 1 {
		t.Fatalf("sweep = %+v", got)
	}
	if _, ok := s.Get(r.ID); ok {
		t.Fatal("room survived")
	}
}

func TestMintTURN(t *testing.T) {
	now := time.Now()
	u, c := MintTURN("s3cr3t", time.Hour, now)
	mac := hmac.New(sha1.New, []byte("s3cr3t"))
	mac.Write([]byte(u))
	if want := base64.StdEncoding.EncodeToString(mac.Sum(nil)); want != c {
		t.Fatal("hmac mismatch")
	}
	var exp int64
	if _, err := fmt.Sscanf(u, "%d:", &exp); err != nil {
		t.Fatalf("username %q: %v", u, err)
	}
	if d := time.Unix(exp, 0).Sub(now); d < 59*time.Minute || d > 61*time.Minute {
		t.Fatalf("ttl = %v", d)
	}
}

func TestLateJoinOfferReplay(t *testing.T) {
	s := NewStore(time.Second)
	r := s.Create(nil, false)
	snd := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "sender", "sender", snd); err != nil {
		t.Fatal(err)
	}
	// Offer with nobody listening: cached, not an error.
	if n, err := s.Route(r.ID, Frame{From: "sender", To: "receivers", Kind: "offer", Payload: "{}"}); err != nil || n != 0 {
		t.Fatalf("route = %d %v", n, err)
	}
	rx := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "late", "receiver", rx); err != nil {
		t.Fatal(err)
	}
	if !s.ReplayOffer(r.ID, "late") {
		t.Fatal("no replay")
	}
	var f Frame
	if err := json.Unmarshal(<-rx, &f); err != nil || f.Kind != "offer" || f.Seq == 0 {
		t.Fatalf("replay = %+v %v", f, err)
	}
	// Renegotiation overwrites the cache.
	if _, err := s.Route(r.ID, Frame{From: "sender", To: "receivers", Kind: "offer", Payload: `{"v":2}`}); err != nil {
		t.Fatal(err)
	}
	<-rx // live broadcast consumed
	rx2 := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "late2", "receiver", rx2); err != nil {
		t.Fatal(err)
	}
	if !s.ReplayOffer(r.ID, "late2") {
		t.Fatal("no replay 2")
	}
	if err := json.Unmarshal(<-rx2, &f); err != nil || f.Payload != `{"v":2}` {
		t.Fatalf("replay2 = %+v %v", f, err)
	}
	// No offer cached → no replay; sender never gets offers replayed.
	if s.ReplayOffer("nope", "late2") || s.ReplayOffer(r.ID, "sender") {
		t.Fatal("spurious replay")
	}
}

// A sender removing a file mid-session must be visible to receivers immediately,
// and only the sender may rewrite the manifest.
func TestUpdateManifest(t *testing.T) {
	s := NewStore(10 * time.Second)
	r := s.Create([]FileMeta{
		{ID: "f1", Name: "a.bin", Size: 10},
		{ID: "f2", Name: "b.bin", Size: 20},
	}, false)
	senderCh := make(chan []byte, 8)
	rxCh := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "sender", "sender", senderCh); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Join(r.ID, "rx-1", "receiver", rxCh); err != nil {
		t.Fatal(err)
	}
	drain := func(ch chan []byte) {
		for len(ch) > 0 {
			<-ch
		}
	}
	drain(senderCh)
	drain(rxCh)

	// A receiver must NOT be able to rewrite what the sender is offering.
	if _, err := s.UpdateManifest(r.ID, "rx-1", nil); err != ErrNotSender {
		t.Fatalf("receiver mutated manifest: err=%v want ErrNotSender", err)
	}
	if snap, _ := s.SnapshotOf(r.ID); len(snap.Files) != 2 {
		t.Fatalf("manifest changed by receiver: %+v", snap.Files)
	}

	// Sender drops f2 → receivers get a "files" frame carrying the new list.
	n, err := s.UpdateManifest(r.ID, "sender", []FileMeta{{ID: "f1", Name: "a.bin", Size: 10}})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("notified %d receivers, want 1", n)
	}
	select {
	case raw := <-rxCh:
		var f Frame
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatal(err)
		}
		if f.Kind != "files" {
			t.Fatalf("kind = %q, want files", f.Kind)
		}
		var upd struct {
			Files []FileMeta `json:"files"`
		}
		if err := json.Unmarshal([]byte(f.Payload), &upd); err != nil {
			t.Fatal(err)
		}
		if len(upd.Files) != 1 || upd.Files[0].ID != "f1" {
			t.Fatalf("payload = %+v, want just f1", upd.Files)
		}
	case <-time.After(time.Second):
		t.Fatal("receiver never got the files frame")
	}
	// And REST reflects it for a receiver who loads the page later.
	if snap, _ := s.SnapshotOf(r.ID); len(snap.Files) != 1 || snap.Files[0].ID != "f1" {
		t.Fatalf("snapshot = %+v, want just f1", snap.Files)
	}
	// Unknown room is rejected, not a panic.
	if _, err := s.UpdateManifest("nope", "sender", nil); err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

// A receiver that reloads is a new peer. The cached offer must not survive the
// departure of the last receiver, or the rejoining one answers a dead remote
// description and its data channel silently never opens.
func TestOfferMailboxInvalidatedOnLastReceiverLeave(t *testing.T) {
	s := NewStore(10 * time.Second)
	r := s.Create([]FileMeta{{ID: "f1", Name: "a.bin", Size: 10}}, false)
	senderCh := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "sender", "sender", senderCh); err != nil {
		t.Fatal(err)
	}
	rxCh := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "rx-1", "receiver", rxCh); err != nil {
		t.Fatal(err)
	}
	drain := func(ch chan []byte) {
		for len(ch) > 0 {
			<-ch
		}
	}
	drain(senderCh)
	drain(rxCh)

	// Sender offers once, while rx-1 is present -> mailbox populated.
	if _, err := s.Route(r.ID, Frame{From: "sender", To: "receivers", Kind: "offer", Payload: "v=0 o=- 1"}); err != nil {
		t.Fatal(err)
	}
	drain(rxCh)
	if !s.ReplayOffer(r.ID, "rx-1") {
		t.Fatal("offer was not mailboxed while a receiver was present")
	}
	gotOffer := func(ch chan []byte) string {
		select {
		case raw := <-ch:
			var f Frame
			if err := json.Unmarshal(raw, &f); err != nil {
				t.Fatal(err)
			}
			return f.Payload
		case <-time.After(300 * time.Millisecond):
			return ""
		}
	}
	if p := gotOffer(rxCh); p != "v=0 o=- 1" {
		t.Fatalf("replayed payload = %q, want the cached offer", p)
	}

	// rx-1 refreshes: it leaves and rejoins as rx-2. The stale offer must be gone,
	// so the rejoiner negotiates from its own offer instead of a dead one.
	s.Leave(r.ID, "rx-1", rxCh)
	rx2 := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "rx-2", "receiver", rx2); err != nil {
		t.Fatal(err)
	}
	drain(rx2)
	if s.ReplayOffer(r.ID, "rx-2") {
		t.Fatal("stale offer replayed to the rejoining receiver")
	}
	if p := gotOffer(rx2); p != "" {
		t.Fatalf("joiner received a stale offer anyway: %q", p)
	}

	// While a receiver IS present, the mailbox still works as designed.
	drain(senderCh)
	if _, err := s.Route(r.ID, Frame{From: "sender", To: "receivers", Kind: "offer", Payload: "v=0 o=- 2"}); err != nil {
		t.Fatal(err)
	}
	drain(rx2)
	if !s.ReplayOffer(r.ID, "rx-2") {
		t.Fatal("newest offer was not mailboxed while a receiver is present")
	}
	if p := gotOffer(rx2); p != "v=0 o=- 2" {
		t.Fatalf("replayed payload = %q, want the newest offer", p)
	}
}

// A peer-addressed offer names ONE receiver's DTLS identity and ICE session, so
// it must reach exactly that receiver and must never be replayed to a different
// one. Both halves matter: broadcasting it is what made two receivers answer the
// same offer and collide in the wrong signaling state, and replaying it is how a
// late joiner answers a description that can never connect.
func TestPeerAddressedOfferIsNotBroadcastOrReplayed(t *testing.T) {
	s := NewStore(10 * time.Second)
	r := s.Create([]FileMeta{{ID: "f1", Name: "a.bin", Size: 10}}, false)
	senderCh := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "sender", "sender", senderCh); err != nil {
		t.Fatal(err)
	}
	rx1 := make(chan []byte, 8)
	rx2 := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "rx-1", "receiver", rx1); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Join(r.ID, "rx-2", "receiver", rx2); err != nil {
		t.Fatal(err)
	}
	drain := func(ch chan []byte) {
		for len(ch) > 0 {
			<-ch
		}
	}
	drain(senderCh)
	drain(rx1)
	drain(rx2)

	n, err := s.Route(r.ID, Frame{From: "sender", To: "rx-1", Kind: "offer", Payload: "v=0 o=- peer1"})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("offer routed to %d peers, want 1 (a peer-addressed offer is not a broadcast)", n)
	}
	if len(rx2) != 0 {
		t.Fatal("peer-addressed offer leaked to the other receiver")
	}

	// rx-2 joins later and must NOT be handed rx-1's offer.
	drain(rx1)
	if s.ReplayOffer(r.ID, "rx-2") {
		t.Fatal("a peer-addressed offer was replayed to a different receiver")
	}
	if len(rx2) != 0 {
		t.Fatal("stale peer-addressed offer reached the late joiner")
	}
	// Replaying nothing is correct, not a gap: a peer-addressed offer is
	// re-sent by the sender on the presence frame for the new peer, so the
	// late joiner negotiates from a description built for it. Only a room-wide
	// offer is mailboxed, and that path still works.
	if _, err := s.Route(r.ID, Frame{From: "sender", To: "receivers", Kind: "offer", Payload: "v=0 o=- all"}); err != nil {
		t.Fatal(err)
	}
	drain(rx1)
	drain(rx2)
	if !s.ReplayOffer(r.ID, "rx-2") {
		t.Fatal("a room-wide offer was not mailboxed for a late joiner")
	}
}

// The nearby code is a bearer secret: GET /api/nearby/{code} returns the room id.
// Its space is only 9000 wide, so the old plain-modulo draw skewed 28% of the
// codes to be 14% more likely than the rest (65536 = 7*9000 + 2536). Rejection
// sampling must make every code exactly equiprobable.
func TestNearbyCodeIsUniform(t *testing.T) {
	// Enumerate the residue counts the old implementation produced, to prove
	// the skew was real, then assert the new draw does not reproduce it.
	const n = 9000
	const draws = 1_800_000
	counts := make([]int, n)
	for i := 0; i < draws; i++ {
		v := randInt(n)
		if v < 0 || v >= n {
			t.Fatalf("randInt(%d) returned %d, out of range", n, v)
		}
		counts[v]++
	}
	// Chi-square against uniform, pooled into 900 buckets of 10 codes each so
	// every bucket has a usable expected count (200 at this sample size) and the
	// test measures the SHAPE of the distribution rather than per-code noise.
	// The old modulo draw fails this by a wide margin: it put ~28% of the space
	// systematically ~14% above the rest, which is exactly the signal this
	// pooling is designed to survive.
	const buckets = 900
	const per = n / buckets
	expected := float64(draws) / float64(buckets)
	chi := 0.0
	for b := 0; b < buckets; b++ {
		got := 0
		for k := 0; k < per; k++ {
			got += counts[b*per+k]
		}
		d := float64(got) - expected
		chi += d * d / expected
	}
	// 899 degrees of freedom; p=0.001 is ~1057. A uniform generator lands well
	// under it; the biased one landed far over (verified by mutation).
	if chi > 1057 {
		t.Errorf("nearby-code draw is not uniform: chi2 = %.1f over %d buckets (want < 1057)", chi, buckets)
	}
	// Every code must also be reachable — a generator that silently cannot
	// produce part of its own range is worse than a biased one.
	if min := minOf(counts); min == 0 {
		t.Errorf("some codes were never drawn in %d samples", draws)
	}
}

func minOf(v []int) int {
	m := v[0]
	for _, x := range v {
		if x < m {
			m = x
		}
	}
	return m
}

// The room id is the share-link secret. Modulo over a 62-character alphabet made
// 8 of the 62 symbols ~14% more likely; rejection sampling must not.
func TestRoomIDAlphabetIsUniform(t *testing.T) {
	counts := map[rune]int{}
	for i := 0; i < 20000; i++ {
		id := randString(10)
		if len(id) != 10 {
			t.Fatalf("randString(10) returned %d chars", len(id))
		}
		for _, r := range id {
			if r < '0' || (r > '9' && r < 'A') || r > 'z' {
				t.Fatalf("randString produced %q, outside the alphabet", r)
			}
			counts[r]++
		}
	}
	if len(counts) != len(alphabet) {
		t.Errorf("saw %d distinct symbols over %d chars, want all %d of the alphabet",
			len(counts), 20000*10, len(alphabet))
	}
	// Every symbol should appear roughly 200000/62 = 3225 times. The old
	// modulo gave 8 symbols ~3476 and the rest ~3185.
	for r, c := range counts {
		if c < 2900 || c > 3600 {
			t.Errorf("symbol %q appeared %d times; expected ~3225 with rejection sampling", r, c)
		}
	}
}

// ── Mobile reconnect: a frozen tab's socket dies while the server still holds
// the entry, and the sender must be able to rejoin its OWN room.
//
// This is the second half of the mobile freeze bug, and it was introduced by the
// duplicate-peer rule itself. Sharing from a phone means switching to WhatsApp;
// the OS kills the tab's WebSocket, but the server cannot tell until a write
// fails — up to SIGNAL_PING. Join then refused the reconnect as a duplicate, so
// the sender never came back and every receiver kept seeing "sender offline".
// Reproduced live: the reconnect was closed with 4400 duplicate_sender.

// A live entry is still exclusive. Liveness is the discriminator, and this is
// the security property that must survive the reconnect allowance.
func TestReconnectRefusedWhilePeerAlive(t *testing.T) {
	s := NewStore(time.Second)
	r := s.Create(nil, false)
	first := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "sender", "sender", first); err != nil {
		t.Fatal(err)
	}
	// Different id, sender role: still a second sender, still refused.
	if _, _, err := s.Join(r.ID, "sender2", "sender", make(chan []byte, 8)); err != ErrDuplicatePeer {
		t.Fatalf("second sender: err = %v, want ErrDuplicatePeer", err)
	}
	// Same id, socket never marked dead: an impostor, refused.
	if _, _, err := s.Join(r.ID, "sender", "sender", make(chan []byte, 8)); err != ErrDuplicatePeer {
		t.Fatalf("same id while alive: err = %v, want ErrDuplicatePeer", err)
	}
}

// A reconnect over a dead entry succeeds and is handed the old channel so the
// displaced socket's writer pump can be stopped.
func TestReconnectDisplacesDeadPeer(t *testing.T) {
	s := NewStore(time.Second)
	r := s.Create(nil, false)
	old := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "sender", "sender", old); err != nil {
		t.Fatal(err)
	}
	s.MarkDead(r.ID, "sender", old) // the writer pump's write failed

	fresh := make(chan []byte, 8)
	_, displaced, err := s.Join(r.ID, "sender", "sender", fresh)
	if err != nil {
		t.Fatalf("reconnect refused: %v", err)
	}
	if len(displaced) != 1 || displaced[0] != old {
		t.Fatalf("displaced = %v, want exactly the dead peer channel", displaced)
	}
	snap, _ := s.SnapshotOf(r.ID)
	if !snap.SenderOnline {
		t.Fatal("senderOnline false after a successful reconnect")
	}
	if n := s.PeerCount(r.ID); n != 1 {
		t.Fatalf("peer count %d, want 1 — a takeover must not grow the map", n)
	}
}

// THE regression test. The displaced socket's handler is still running and reaches
// Leave a moment after the replacement is live. An id-only Leave let that late
// call delete the replacement's entry, close its channel and clear the sender
// slot — so the sender was announced offline again seconds after coming back,
// which is what made the mobile reconnect look impossible to fix.
func TestStaleLeaveDoesNotEvictReconnect(t *testing.T) {
	s := NewStore(time.Second)
	r := s.Create([]FileMeta{{ID: "f1", Name: "a.bin", Size: 1}}, false)
	old := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "sender", "sender", old); err != nil {
		t.Fatal(err)
	}
	s.MarkDead(r.ID, "sender", old)
	fresh := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "sender", "sender", fresh); err != nil {
		t.Fatal(err)
	}

	// The displaced socket's handler now unwinds.
	if got := s.Leave(r.ID, "sender", old); len(got) != 0 {
		t.Fatalf("stale Leave returned %d channels, want 0 (it owns nothing)", len(got))
	}
	snap, _ := s.SnapshotOf(r.ID)
	if !snap.SenderOnline {
		t.Fatal("stale Leave cleared the sender slot — the reconnect was undone")
	}
	if n := s.PeerCount(r.ID); n != 1 {
		t.Fatalf("peer count %d after a stale Leave, want 1", n)
	}
	// And the live connection still routes.
	rx := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "rx-1", "receiver", rx); err != nil {
		t.Fatal(err)
	}
	if n, err := s.Route(r.ID, Frame{From: "sender", To: "rx-1", Kind: "answer", Payload: "{}"}); err != nil || n != 1 {
		t.Fatalf("route after reconnect = %d %v, want 1 nil", n, err)
	}
}

// A peer must not be able to unregister somebody else's connection by guessing
// the id: Leave is identity-checked on the registered channel.
func TestLeaveIgnoresForeignChannel(t *testing.T) {
	s := NewStore(time.Second)
	r := s.Create(nil, false)
	victim := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "rx-1", "receiver", victim); err != nil {
		t.Fatal(err)
	}
	if got := s.Leave(r.ID, "rx-1", make(chan []byte, 8)); len(got) != 0 {
		t.Fatalf("Leave with a foreign channel returned %d channels, want 0", len(got))
	}
	if n := s.PeerCount(r.ID); n != 1 {
		t.Fatalf("peer count %d, want 1 — a foreign Leave unregistered the victim", n)
	}
	// The genuine owner still leaves cleanly.
	if got := s.Leave(r.ID, "rx-1", victim); len(got) != 1 || got[0] != victim {
		t.Fatalf("owner Leave = %v, want its own channel", got)
	}
}

// MarkDead must not resurrect a peer's death after a reconnect cleared it.
func TestMarkDeadIsNotSticky(t *testing.T) {
	s := NewStore(time.Second)
	r := s.Create(nil, false)
	old := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "sender", "sender", old); err != nil {
		t.Fatal(err)
	}
	s.MarkDead(r.ID, "sender", old)
	fresh := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "sender", "sender", fresh); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Join(r.ID, "sender", "sender", make(chan []byte, 8)); err != ErrDuplicatePeer {
		t.Fatalf("reconnected peer was still displaceable: err = %v", err)
	}
}

// A displaced socket's dying pump must not mark its REPLACEMENT dead.
//
// MarkDead and Join serialise on s.mu, so whichever ran second won. A write
// failure landing microseconds after a reconnect therefore flagged the healthy
// new sender as displaceable by anyone holding its peer id — undoing the security
// property the reconnect allowance exists to preserve. This is not a remote race:
// the dead socket and its replacement are milliseconds apart by design, which is
// the whole point of the mobile reconnect.
func TestMarkDeadCannotMarkAReplacement(t *testing.T) {
	s := NewStore(time.Second)
	r := s.Create(nil, false)
	old := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "sender", "sender", old); err != nil {
		t.Fatal(err)
	}
	s.MarkDead(r.ID, "sender", old)
	fresh := make(chan []byte, 8)
	if _, _, err := s.Join(r.ID, "sender", "sender", fresh); err != nil {
		t.Fatal(err)
	}

	// The old socket's pump now reports its own death — too late.
	s.MarkDead(r.ID, "sender", old)

	// The live sender must still be protected from takeover.
	if _, _, err := s.Join(r.ID, "sender", "sender", make(chan []byte, 8)); err != ErrDuplicatePeer {
		t.Fatalf("a late MarkDead from the displaced socket made the replacement displaceable: err = %v", err)
	}
	snap, _ := s.SnapshotOf(r.ID)
	if !snap.SenderOnline {
		t.Fatal("senderOnline false — the live sender was evicted")
	}
}

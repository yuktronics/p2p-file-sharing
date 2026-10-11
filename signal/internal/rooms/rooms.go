// Package rooms owns room lifecycle, signaling routing, presence and TURN
// credentials. Transport-agnostic: peers are represented by buffered send
// channels owned by the server layer; closing a channel means "bye + hang up".
package rooms

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sync"
	"time"
)

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// Frame is the wire object (docs/WIRE-PROTOCOL.md v1).
type Frame struct {
	From    string `json:"from"`
	To      string `json:"to"`
	Kind    string `json:"kind"`
	Payload string `json:"payload"`
	Seq     int64  `json:"seq,omitempty"`
}

type FileMeta struct {
	// ID is a stable per-file identity assigned by the sender. The DataChannel
	// protocol used to address files by array index, which breaks the moment the
	// sender removes a file mid-session: every later index shifts and a receiver
	// asking for "idx 3" silently gets a different file. ID never shifts.
	ID   string `json:"id,omitempty"`
	Name string `json:"name"`
	Size int64  `json:"size"`
	Mime string `json:"mime"`
}

// senderPeerID is the peer id the sender occupies. It is not cosmetic: the
// wire protocol addresses the sender by this literal (`to:"sender"`), so a
// receiver must not be able to hold it. See docs/WIRE-PROTOCOL.md.
const senderPeerID = "sender"

var (
	ErrNotFound      = errors.New("rooms: not found")
	ErrDuplicatePeer = errors.New("rooms: duplicate peer")
	ErrRoomFull      = errors.New("rooms: peer limit reached")
	ErrUnknownTarget = errors.New("rooms: unknown target")
	ErrRoomGone      = errors.New("rooms: room closed")
	ErrInvalidFrame  = errors.New("rooms: invalid frame")
	ErrNotSender     = errors.New("rooms: only the sender may change the file list")
)

type Peer struct {
	ID   string
	Role string // "sender" | "receiver"
	Send chan []byte
}

type Room struct {
	ID         string
	NearbyCode string
	Files      []FileMeta
	CreatedAt  time.Time

	mu       sync.Mutex
	peers    map[string]*Peer
	senderID string
	seq      int64
	goneAt   time.Time // zero while sender present
	dropped  int64     // frames dropped on full buffers
	// dead marks peers whose socket the server layer has PROVEN gone (a write
	// failed). Such an entry may be displaced by a reconnect with the same id; a
	// live entry may not. See Join.
	dead map[string]bool
	// lastOffer caches the newest broadcast offer so receivers joining late
	// still get one (senders offer immediately after their own join).
	// Stored without seq; replay assigns a fresh one.
	lastOffer *Frame
}

type Store struct {
	mu     sync.Mutex
	rooms  map[string]*Room
	byNear map[string]string
	Grace  time.Duration

	// Operator abuse state (ephemeral like rooms; structured log mirrors it).
	tombs     map[string]Tombstone
	tombOrder []string
	reports   []Report
	// reportLog, when set, is the durable copy. nil = memory only.
	reportLog *ReportLog

	// Metrics (atomics guarded by mu for simplicity at this scale).
	routed  int64
	dropped int64

	// maxPeers caps concurrent peers per room (0 = unlimited). Set by the
	// server so a room id cannot be used to amplify routing work.
	maxPeers int
}

// SetMaxPeers bounds concurrent peers per room. Must be called before the store
// is used concurrently.
func (s *Store) SetMaxPeers(n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.maxPeers = n
}

const (
	maxTombs   = 1000
	maxReports = 500
)

// maxRoomAge bounds how long a room survives without ever having a sender. It
// is a backstop against unbounded growth, not a user-visible timeout: a sender
// that connects clears it, because the sender-present case is governed by Grace
// instead. Ten minutes is many times the real gap between POST /api/rooms and
// the WebSocket the client opens immediately afterwards, so this only collects
// rooms whose creator never came back.
const maxRoomAge = 10 * time.Minute

func NewStore(grace time.Duration) *Store {
	return &Store{rooms: map[string]*Room{}, byNear: map[string]string{}, Grace: grace,
		tombs: map[string]Tombstone{}}
}

// SetReportLog attaches a durable report log. A nil log leaves reports in
// memory only, which is the pre-existing behaviour. Called once at startup,
// before the server accepts traffic.
func (s *Store) SetReportLog(l *ReportLog) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reportLog = l
}

// ReportLogPath is the configured log path, or "" when reports are memory-only.
// Surfaced on /metrics so an operator can confirm persistence is actually on
// without reading the source.
func (s *Store) ReportLogPath() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reportLog.Path()
}

// randString draws n characters uniformly from alphabet.
//
// Rejection sampling, not a plain `% len(alphabet)`. The alphabet is 62
// characters and a byte is 256 values, so modulo made 8 of the 62 symbols
// (those at indices 248-255) each ~14% more likely than the rest. Negligible for
// a 10-character room id (~59.4 effective bits either way) but it is free to
// remove, and "the bias is negligible" is not a reason to keep a known skew in
// code whose entire security argument rests on unguessability.
func randString(n int) string {
	b := make([]byte, n)
	// The largest multiple of len(alphabet) that fits in a byte. Values at or
	// above this are discarded and redrawn, so every character is equally likely.
	const maxUnbiased = 256 - (256 % len(alphabet))
	for i := 0; i < n; {
		var rb [64]byte
		_, _ = rand.Read(rb[:])
		for _, v := range rb {
			if i == n {
				break
			}
			if int(v) >= maxUnbiased {
				continue // would skew the distribution: redraw
			}
			b[i] = alphabet[int(v)%len(alphabet)]
			i++
		}
	}
	return string(b)
}

// Create makes a room. Validation of files happens in the server layer.
func (s *Store) Create(files []FileMeta, wantNearby bool) *Room {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := randString(10)
	for {
		if _, ok := s.rooms[id]; !ok {
			break
		}
		id = randString(10)
	}
	r := &Room{ID: id, Files: files, CreatedAt: time.Now(), peers: map[string]*Peer{}, dead: map[string]bool{}}
	if wantNearby {
		for i := 0; i < 20; i++ {
			code := fmt.Sprintf("%04d", 1000+randInt(9000))
			if _, ok := s.byNear[code]; !ok {
				r.NearbyCode = code
				s.byNear[code] = id
				break
			}
		}
	}
	s.rooms[id] = r
	return r
}

// randInt returns a uniform value in [0, n). Rejection sampling again: 65536 is
// not a multiple of 9000, so modulo made codes 1000-3535 ~14% more likely than
// the rest. The nearby code is a BEARER SECRET — GET /api/nearby/{code} returns
// the room id — so its space is only 9000 wide and the only barrier is
// RATE_NEARBY_PER_MIN. Every bit of uniformity is worth having there.
func randInt(n int) int {
	if n <= 0 {
		panic("rooms: randInt requires n > 0")
	}
	limit := math.MaxInt32 - (math.MaxInt32 % n)
	for {
		var b [4]byte
		_, _ = rand.Read(b[:])
		v := int(b[0])<<24 | int(b[1])<<16 | int(b[2])<<8 | int(b[3])
		// Reinterpret as int32 so the value is non-negative, then reject the
		// incomplete final block so the residues are exactly equiprobable.
		if v < 0 {
			v += math.MaxInt32 + 1
		}
		if v < limit {
			return v % n
		}
	}
}

func (s *Store) Get(id string) (*Room, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rooms[id]
	return r, ok
}

func (s *Store) GetByNearby(code string) (*Room, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.byNear[code]
	if !ok {
		return nil, false
	}
	r, ok := s.rooms[id]
	return r, ok
}

// Snapshot is a copy safe to serve over REST.
type Snapshot struct {
	ID           string
	Files        []FileMeta
	Nearby       string
	SenderOnline bool
	Peers        []string
}

// Tombstone remembers an operator-disabled room so GET/WS return 451
// instead of 404 after the room is deleted.
type Tombstone struct {
	Reason string
	At     time.Time
}

// Report is one abuse filing against a room.
type Report struct {
	RoomID  string `json:"room"`
	Reason  string `json:"reason"`
	Contact string `json:"contact,omitempty"`
	At      string `json:"at"`
	// RoomLive records whether the room was still open when the report arrived.
	// A live room can be disabled immediately; an ended one cannot, so the
	// operator knows the report is a record rather than an actionable target.
	// Most abuse is reported after the sender has closed their tab, so this is
	// usually false — that is exactly why reports for ended rooms are accepted.
	RoomLive bool `json:"roomLive"`
}

// SnapshotOf returns room state for REST.
func (s *Store) SnapshotOf(id string) (Snapshot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rooms[id]
	if !ok {
		return Snapshot{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	snap := Snapshot{ID: r.ID, Files: r.Files, Nearby: r.NearbyCode, SenderOnline: r.senderID != ""}
	for pid := range r.peers {
		snap.Peers = append(snap.Peers, pid)
	}
	return snap, true
}

// Join registers a peer. send must be a buffered channel owned by the caller;
// closing is done by Leave/Delete/Expire only via returned channel lists.
// Enforces MaxPeers (0 = unlimited): each peer multiplies the work of every
// frame the sender routes, so an unbounded peer count turns a room id into an
// amplification primitive.
//
// A peer id names exactly ONE live connection. The id is chosen by the client
// (it is a query parameter) and every id is broadcast in the presence payload,
// so an id that could be re-registered while its socket was ALIVE would let a
// second socket seize the first one's routing slot: frames addressed to that id
// would go to the new socket, the original peer would be orphaned with its send
// channel unreachable from Delete/Disable/ExpireSweep, and MaxPeers would never
// apply because the map would not grow.
//
// Liveness is the discriminator, and it is not optional. A mobile sender that
// switches to WhatsApp to send the link has its WebSocket killed by the OS while
// the server still holds the entry — up to one SIGNAL_PING, since only a failed
// write proves the socket is gone. A reconnect inside that window is a legitimate
// reconnect, not an impostor, and rejecting it (as this function originally did)
// made the mobile freeze permanent: the sender could never rejoin its own room.
// MarkDead is how the server layer reports that proof, and a dead entry is
// displaced rather than refused.
//
// Displacement is bounded by what it destroys: Join returns the dead peer's send
// channel so the caller closes it, which makes the displaced socket write bye and
// hang up. The previous peer is therefore TERMINATED, never silently shadowed,
// and MaxPeers still binds because a takeover does not grow the map. What remains
// is that anyone holding a peer id can turn a live peer off during the window
// before its death is detected — the id is a bearer capability already disclosed
// to every member of the room by the presence payload, and the displaced socket
// sees the bye, so the hijack is visible rather than silent.
func (s *Store) Join(roomID, peerID, role string, send chan []byte) (*Room, []chan []byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rooms[roomID]
	if !ok {
		return nil, nil, ErrNotFound
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	// Validate everything before touching r, so a rejected Join leaves no
	// partial state for a later Leave to unwind.
	existing := r.peers[peerID]
	if existing != nil && !r.dead[peerID] {
		return nil, nil, ErrDuplicatePeer
	}
	if role == "sender" && r.senderID != "" && r.senderID != peerID {
		return nil, nil, ErrDuplicatePeer
	}
	// The wire protocol addresses the sender by the literal "sender" (frames
	// use to:"sender"), so that id belongs to the sender role alone. A receiver
	// holding it would lock the real sender out of its own room.
	if role != "sender" && peerID == senderPeerID {
		return nil, nil, ErrDuplicatePeer
	}
	if s.maxPeers > 0 && len(r.peers) >= s.maxPeers && existing == nil {
		return nil, nil, ErrRoomFull
	}
	var stale []chan []byte
	if existing != nil {
		stale = append(stale, existing.Send)
	}
	if role == "sender" {
		r.senderID = peerID
		r.goneAt = time.Time{}
	}
	delete(r.dead, peerID)
	r.peers[peerID] = &Peer{ID: peerID, Role: role, Send: send}
	return r, stale, nil
}

// MarkDead records that a peer's socket is gone, so the next Join with that id is
// recognised as a reconnect rather than refused as a duplicate. Only the server
// layer may call it, and only after a write to that socket has failed: a peer
// that has merely gone quiet is still reachable, and the read deadline is what
// settles that case.
//
// send must be the channel the calling connection registered, and the call is
// IGNORED if that connection no longer owns the id. Without the identity check a
// displaced socket's dying pump could mark its own REPLACEMENT dead: MarkDead and
// Join serialise on s.mu, so whichever ran second won, and a failed write landing
// just after a reconnect left a healthy sender displaceable by anyone holding its
// id. That is the exact race the mobile reconnect runs in — the dead socket and
// its replacement are milliseconds apart by design.
func (s *Store) MarkDead(roomID, peerID string, send chan []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rooms[roomID]
	if !ok {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	p := r.peers[peerID]
	if p == nil || p.Send != send {
		return // already replaced or left: this socket owns nothing
	}
	if r.dead == nil {
		r.dead = map[string]bool{}
	}
	r.dead[peerID] = true
}

// Leave unregisters a peer and returns the peer's send channel so the caller can
// close it. send must be the channel this connection registered, and the call is
// IGNORED if that connection no longer owns the id.
//
// The identity check is not defensive tidiness — it is the other half of allowing
// a reconnect. When a reconnect displaces a dead entry, the displaced socket's
// handler is still running and will reach Leave a moment later, typically after
// the replacement is already established. An id-only Leave let that late call
// delete the NEW connection's entry, close its send channel, and clear the sender
// slot, so the sender was announced offline again seconds after coming back — the
// exact symptom that made the mobile reconnect look impossible to fix. Verified
// live: the displaced socket's Leave cleared senderOnline within seconds of the
// reconnect setting it.
//
// Closing matters: the peer's writer pump blocks in select on that channel and
// only wakes on a queued frame or a channel close. Once the peer is out of the
// map, nothing else can reach it — Delete/Disable/ExpireSweep/Shutdown all walk
// r.peers — so without this close the pump and the handler parked behind it
// stayed alive for the life of the process, two goroutines and a socket per
// disconnect. Measured before the fix: 5 join/leave cycles left 10 goroutines
// still running.
//
// Leave never deletes the room; only ExpireSweep does that.
func (s *Store) Leave(roomID, peerID string, send chan []byte) []chan []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rooms[roomID]
	if !ok {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	p := r.peers[peerID]
	if p == nil || p.Send != send {
		return nil // already replaced by a reconnect, or already left
	}
	delete(r.peers, peerID)
	delete(r.dead, peerID)
	if peerID == r.senderID {
		r.senderID = ""
		r.goneAt = time.Now()
	}
	// Drop the cached offer once the last receiver is gone. It describes a
	// DTLS/SCTP association with a peer that no longer exists, so a receiver
	// rejoining would answer a dead remote description: the PC looks negotiated
	// on both sides, the data channel never opens, and wants queue forever. With
	// no mailbox entry the receiver's own offer drives the renegotiation instead.
	if r.senderID != "" && r.receiversLocked() == 0 {
		r.lastOffer = nil
	}
	return []chan []byte{send}
}

// receiversLocked counts peers holding the receiver role. Caller holds r.mu.
func (r *Room) receiversLocked() int {
	n := 0
	for _, p := range r.peers {
		if p.Role == "receiver" {
			n++
		}
	}
	return n
}

// Presence builds the current presence frame (no seq; Route assigns).
func (s *Store) Presence(roomID string) (Frame, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rooms[roomID]
	if !ok {
		return Frame{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	peers := make([]string, 0, len(r.peers))
	for pid := range r.peers {
		peers = append(peers, pid)
	}
	pl, _ := json.Marshal(map[string]any{"peers": peers, "senderOnline": r.senderID != ""})
	return Frame{From: "server", To: "receivers", Kind: "presence", Payload: string(pl)}, true
}

// PeerSendChannel returns the send channel a peer currently holds, or nil. It
// exists so a test can act as the server layer's writer pump would — reporting a
// dead socket by channel identity — which is otherwise unreachable, because on a
// real connection the reader always notices a break first. Same role as
// PeerCount: inspection for assertions, not part of the routing contract.
func (s *Store) PeerSendChannel(roomID, peerID string) chan []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rooms[roomID]
	if !ok {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	p := r.peers[peerID]
	if p == nil {
		return nil
	}
	return p.Send
}

// PeerCount reports how many peers are currently attached to a room.
func (s *Store) PeerCount(roomID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rooms[roomID]
	if !ok {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.peers)
}

// Route validates and delivers one frame. Returns deliveries count.
func (s *Store) Route(roomID string, f Frame) (int, error) {
	if f.From == "" || f.To == "" || f.Kind == "" {
		return 0, ErrInvalidFrame
	}
	// Only kinds a client is allowed to originate. "presence" and "bye" are
	// server statements about the room's own state: the clients treat both as
	// authoritative (a presence frame with senderOnline:false trips every
	// receiver's watchdog into failing the transfer, and a bye is shown to the
	// user as the sender having quit). Accepting them from a peer let any
	// participant forge either. "files" is routed by the handler on the
	// sender's behalf, never here.
	switch f.Kind {
	case "offer", "answer", "ice", "join", "ping":
	default:
		return 0, ErrInvalidFrame
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rooms[roomID]
	if !ok {
		return 0, ErrNotFound
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.peers[f.From]; !ok {
		return 0, ErrInvalidFrame
	}
	var targets []*Peer
	switch {
	case f.To == senderPeerID:
		for _, p := range r.peers {
			if p.Role == senderPeerID {
				targets = append(targets, p)
			}
		}
	case f.To == "receivers":
		for _, p := range r.peers {
			if p.Role == "receiver" {
				targets = append(targets, p)
			}
		}
	default:
		p, ok := r.peers[f.To]
		if !ok {
			return 0, ErrUnknownTarget
		}
		targets = append(targets, p)
	}
	if len(targets) == 0 {
		// Lenient by design (late joiners, empty room) — except offers, which
		// are mailboxed for late-joining receivers (see ReplayOffer).
		cacheOffer(r, f)
		return 0, nil
	}
	r.seq++
	f.Seq = r.seq
	raw, _ := json.Marshal(f)
	n := 0
	for _, p := range targets {
		select {
		case p.Send <- raw:
			n++
		default:
			r.dropped++
			s.dropped++
		}
	}
	s.routed += int64(n)
	cacheOffer(r, f)
	return n, nil
}

// cacheOffer keeps a room-wide sender offer as the late-join mailbox.
// The sender now addresses one offer per receiver peer — a single peer
// connection cannot serve two receivers, since both would answer the same
// offer and the second setRemoteDescription lands in the wrong signaling
// state. That means a peer-addressed offer must never be replayed to a
// different receiver: its SDP names one DTLS identity and one ICE session,
// so the joiner would answer a description that can never connect. Only
// unaddressed offers are mailboxed; peer-addressed ones are re-sent by the
// sender on the presence frame instead.
func cacheOffer(r *Room, f Frame) {
	if f.Kind == "offer" && r.senderID != "" && f.From == r.senderID && f.To == "receivers" {
		r.lastOffer = &Frame{From: f.From, To: f.To, Kind: f.Kind, Payload: f.Payload}
	}
}

// ReplayOffer delivers the cached broadcast offer to a newly joined receiver.
// Reports whether one was sent. Renegotiations overwrite the cache in Route.
func (s *Store) ReplayOffer(roomID, peerID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rooms[roomID]
	if !ok || r.lastOffer == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.peers[peerID]
	if !ok || p.Role != "receiver" {
		return false
	}
	r.seq++
	f := *r.lastOffer
	f.Seq = r.seq
	raw, _ := json.Marshal(f)
	select {
	case p.Send <- raw:
		s.routed++
		return true
	default:
		r.dropped++
		s.dropped++
		return false
	}
}

// Broadcast enqueues a frame to every peer. Used for bye.
func (s *Store) Broadcast(roomID string, f Frame) int {
	return s.broadcastRole(roomID, "", f)
}

// broadcastRole sends f to every peer, or only to peers with the given role when
// role != "". Returns the number of peers written to.
func (s *Store) broadcastRole(roomID, role string, f Frame) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rooms[roomID]
	if !ok {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seq++
	f.Seq = r.seq
	raw, _ := json.Marshal(f)
	n := 0
	for _, p := range r.peers {
		if role != "" && p.Role != role {
			continue
		}
		select {
		case p.Send <- raw:
			n++
		default:
			r.dropped++
			s.dropped++
		}
	}
	return n
}

// SetFiles replaces a room's file manifest. Only the sender may call it, so a
// receiver cannot rewrite what the sender is offering. The caller is expected to
// Broadcast the result to receivers afterwards (UpdateManifest does both).
func (s *Store) SetFiles(roomID, peerID string, files []FileMeta) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rooms[roomID]
	if !ok {
		return ErrNotFound
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.peers[peerID]
	if !ok || p.Role != "sender" {
		return ErrNotSender
	}
	r.Files = files
	return nil
}

// UpdateManifest validates and applies a sender's new file list, then pushes it
// to every receiver as a "files" frame. Returns how many receivers were told.
func (s *Store) UpdateManifest(roomID, peerID string, files []FileMeta) (int, error) {
	if err := s.SetFiles(roomID, peerID, files); err != nil {
		return 0, err
	}
	raw, err := json.Marshal(map[string]any{"files": files})
	if err != nil {
		return 0, ErrInvalidFrame
	}
	// Receivers only — the sender already knows its own list, and echoing it back
	// would make the notified count (and the sender's own message handler) lie.
	return s.broadcastRole(roomID, "receiver", Frame{From: "server", To: "receivers", Kind: "files", Payload: string(raw)}), nil
}

// Delete removes a room and returns peer send channels for the caller to close.
func (s *Store) Delete(roomID string) []chan []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rooms[roomID]
	if !ok {
		return nil
	}
	if r.NearbyCode != "" {
		delete(s.byNear, r.NearbyCode)
	}
	delete(s.rooms, roomID)
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []chan []byte
	for _, p := range r.peers {
		out = append(out, p.Send)
	}
	return out
}

// Expired holds rooms past sender-grace for the server to bye+delete.
type Expired struct {
	RoomID string
	Sends  []chan []byte
}

// ExpireSweep deletes rooms whose sender has been gone longer than grace.
func (s *Store) ExpireSweep(now time.Time) []Expired {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Expired
	for id, r := range s.rooms {
		r.mu.Lock()
		// Two ways a room becomes collectable:
		//
		//  1. The sender was here and left — goneAt is set, so Grace applies.
		//  2. The sender NEVER joined. goneAt is still zero, so the first
		//     condition can never fire and the room would live for the life of
		//     the process. Create leaves goneAt zero precisely because there is
		//     no sender to be gone, so an abandoned create (a client that dies
		//     between the REST POST and the socket open, or any scripted caller)
		//     leaks a Room plus its manifest. Bound that case by age instead.
		//
		// maxRoomAge is far longer than any real gap between creating a room and
		// opening its socket, so it only collects rooms nobody ever came back for.
		senderLeft := r.senderID == "" && !r.goneAt.IsZero() && now.Sub(r.goneAt) > s.Grace
		neverClaimed := r.senderID == "" && r.goneAt.IsZero() && now.Sub(r.CreatedAt) > maxRoomAge
		gone := senderLeft || neverClaimed
		var sends []chan []byte
		if gone {
			if r.NearbyCode != "" {
				delete(s.byNear, r.NearbyCode)
			}
			delete(s.rooms, id)
			for _, p := range r.peers {
				sends = append(sends, p.Send)
			}
		}
		r.mu.Unlock()
		if gone {
			out = append(out, Expired{RoomID: id, Sends: sends})
		}
	}
	return out
}

// Disable deletes a room immediately (returns peer channels to close) and
// leaves a tombstone so restores/joins report 451 instead of 404.
func (s *Store) Disable(roomID, reason string) []chan []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rooms[roomID]
	if !ok {
		return nil
	}
	if r.NearbyCode != "" {
		delete(s.byNear, r.NearbyCode)
	}
	delete(s.rooms, roomID)
	s.tombs[roomID] = Tombstone{Reason: reason, At: time.Now()}
	s.tombOrder = append(s.tombOrder, roomID)
	if len(s.tombOrder) > maxTombs {
		delete(s.tombs, s.tombOrder[0])
		s.tombOrder = s.tombOrder[1:]
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []chan []byte
	for _, p := range r.peers {
		out = append(out, p.Send)
	}
	return out
}

// Disabled reports whether a room was operator-disabled.
func (s *Store) Disabled(roomID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tombs[roomID]
	if !ok {
		return "", false
	}
	return t.Reason, true
}

// AddReport files an abuse report in memory and, when configured, on disk. The
// memory copy is the fast path the operator UI reads; the log is what survives a
// restart. The memory copy is always kept — dropping it on a disk failure would
// lose the report from the one place an operator can still see it — and the
// error is returned so the caller can report that durability was lost.
func (s *Store) AddReport(rep Report) error {
	s.mu.Lock()
	log := s.reportLog
	s.reports = append(s.reports, rep)
	if len(s.reports) > maxReports {
		s.reports = s.reports[len(s.reports)-maxReports:]
	}
	s.mu.Unlock()

	if log == nil {
		return nil
	}
	// Outside the store lock: the log has its own, and a slow disk should not
	// stall room operations. The report is already in memory, so a write failure
	// loses durability but not the record for this process's lifetime.
	return log.Append(rep)
}

// ListReports returns every report, oldest first, and whether the durable log
// was read successfully.
//
// The log is the source of truth when configured — otherwise a restart shows an
// empty inbox while the file still holds the reports. But a read failure used to
// fall back to memory while the comment claimed "the failure is visible in the
// logs", and this package imports no logger and had no metric. After a restart
// the operator saw an empty list presented as a healthy inbox, with no signal
// anywhere that reports were no longer being read. The flag is surfaced by
// /api/admin/reports as "durable": false so the difference is visible.
func (s *Store) ListReports() ([]Report, bool) {
	s.mu.Lock()
	log := s.reportLog
	mem := make([]Report, len(s.reports))
	copy(mem, s.reports)
	s.mu.Unlock()

	if log == nil {
		return mem, true
	}
	fromLog, err := log.All()
	if err != nil {
		return mem, false
	}
	if len(fromLog) > maxReports {
		fromLog = fromLog[len(fromLog)-maxReports:]
	}
	return fromLog, true
}

// Shutdown deletes all rooms and returns every peer send channel.
// The caller closes them (writers send bye + hang up).
func (s *Store) Shutdown() []chan []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []chan []byte
	for id, r := range s.rooms {
		if r.NearbyCode != "" {
			delete(s.byNear, r.NearbyCode)
		}
		delete(s.rooms, id)
		r.mu.Lock()
		for _, p := range r.peers {
			out = append(out, p.Send)
		}
		r.mu.Unlock()
	}
	return out
}

// RoomCount, Routed, Dropped feed /metrics.
func (s *Store) RoomCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.rooms)
}
func (s *Store) Routed() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.routed
}
func (s *Store) Dropped() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.dropped
}

// MintTURN builds coturn REST-API credentials: username "<expiry>:<rand>",
// credential base64(HMAC-SHA1(secret, username)).
func MintTURN(secret string, ttl time.Duration, now time.Time) (username, credential string) {
	exp := now.Add(ttl).Unix()
	username = fmt.Sprintf("%d:%s", exp, randString(4))
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	credential = base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return username, credential
}

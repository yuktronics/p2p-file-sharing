package server

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"signal/internal/rooms"
	"signal/internal/ws"
)

func testConfig() Config {
	return Config{
		Addr: "127.0.0.1:0", BaseURL: "http://x", WebDir: "../../web",
		Grace: 60 * time.Millisecond, PingInterval: 50 * time.Millisecond,
		MaxMsg: 32768, TurnHost: "turn.example.com", TurnSecret: "s3cr3t",
		TurnTTL: time.Hour, TurnRealm: "p2pfilesharing", StunURL: "stun:x",
	}
}

func createRoom(t *testing.T, base string) string {
	t.Helper()
	resp, err := http.Post(base+"/api/rooms", "application/json",
		strings.NewReader(`{"files":[{"name":"f.bin","size":10,"mime":"x/y"}],"nearby":true}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 201 {
		t.Fatalf("create = %d", resp.StatusCode)
	}
	var body struct {
		ID     string `json:"id"`
		Nearby string `json:"nearby"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.ID) != 10 || len(body.Nearby) != 4 {
		t.Fatalf("bad %+v", body)
	}
	return body.ID
}

func dialWS(t *testing.T, base, room, qs string) *ws.Conn {
	t.Helper()
	wbase := "ws" + strings.TrimPrefix(base, "http")
	c, err := ws.Dial(wbase+"/ws/rooms/"+room+"?"+qs, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func sendFrame(t *testing.T, c *ws.Conn, from, to, kind, payload string) {
	t.Helper()
	raw, _ := json.Marshal(rooms.Frame{From: from, To: to, Kind: kind, Payload: payload})
	if err := c.WriteMessage(ws.OpText, raw); err != nil {
		t.Fatal(err)
	}
}

func readFrame(t *testing.T, c *ws.Conn, wantKind string) rooms.Frame {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		op, p, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if op != ws.OpText {
			continue
		}
		var f rooms.Frame
		if err := json.Unmarshal(p, &f); err != nil {
			t.Fatal(err)
		}
		if wantKind == "" || f.Kind == wantKind {
			return f
		}
	}
}

func TestEndToEndSignalExchange(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	id := createRoom(t, ts.URL)

	sender := dialWS(t, ts.URL, id, "role=sender&peer=sender")
	defer sender.Close()
	rx := dialWS(t, ts.URL, id, "role=receiver&peer=rx-1")
	defer rx.Close()

	// drain presence noise on both
	_ = sender.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, _ = sender.ReadMessage()

	sendFrame(t, sender, "sender", "receivers", "offer", `{"sdp":"o"}`)
	if f := readFrame(t, rx, "offer"); f.Seq == 0 || f.Payload != `{"sdp":"o"}` {
		t.Fatalf("offer = %+v", f)
	}
	sendFrame(t, rx, "rx-1", "sender", "answer", `{"sdp":"a"}`)
	if f := readFrame(t, sender, "answer"); f.Seq == 0 {
		t.Fatalf("answer = %+v", f)
	}
	sendFrame(t, rx, "rx-1", "sender", "ice", `{}`)
	if f := readFrame(t, sender, "ice"); f.Seq == 0 {
		t.Fatalf("ice = %+v", f)
	}

	// TURN creds
	resp, err := http.Get(ts.URL + "/api/rooms/" + id + "/turn")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var turn struct {
		TTL        int64 `json:"ttl"`
		IceServers []struct {
			Urls       string `json:"urls"`
			Username   string `json:"username"`
			Credential string `json:"credential"`
		} `json:"iceServers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&turn); err != nil {
		t.Fatal(err)
	}
	if turn.TTL != 3600 || len(turn.IceServers) != 4 {
		t.Fatalf("turn = %+v", turn)
	}
	if !strings.HasPrefix(turn.IceServers[3].Urls, "turns:") {
		t.Fatalf("order = %v", turn.IceServers)
	}

	// sender drop → grace → bye + room gone
	sender.Close()
	if f := readFrame(t, rx, "bye"); f.From != "server" {
		t.Fatalf("bye = %+v", f)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		r, err := http.Get(ts.URL + "/api/rooms/" + id)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		if r.StatusCode == 404 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("room survived grace")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestDuplicateSenderRejected(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	id := createRoom(t, ts.URL)
	a := dialWS(t, ts.URL, id, "role=sender&peer=sender")
	defer a.Close()
	b, err := ws.Dial("ws"+strings.TrimPrefix(ts.URL, "http")+"/ws/rooms/"+id+"?role=sender&peer=s2", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	_ = b.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := b.ReadMessage(); err == nil {
		t.Fatal("expected duplicate-sender close")
	}
}

func TestUnknownRoom404BeforeUpgrade(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	if _, err := ws.Dial("ws"+strings.TrimPrefix(ts.URL, "http")+"/ws/rooms/xxxxxxxxxx?role=receiver", 1<<20); err == nil {
		t.Fatal("expected handshake failure")
	}
}

func TestTurnDisabled410(t *testing.T) {
	cfg := testConfig()
	cfg.TurnSecret = ""
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	id := createRoom(t, ts.URL)
	resp, err := http.Get(ts.URL + "/api/rooms/" + id + "/turn")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 410 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
}

func TestBadBodies400(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	for _, body := range []string{
		`{"files":[]}`, `{"files":[{"name":"","size":1}]}`,
		`{"files":[{"name":"x","size":0}]}`, `not json`,
	} {
		resp, err := http.Post(ts.URL+"/api/rooms", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 400 {
			t.Fatalf("body %q = %d", body, resp.StatusCode)
		}
	}
}

func TestCreateRateLimited429(t *testing.T) {
	cfg := testConfig()
	cfg.RateCreatePerMin = 2
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	post := func() int {
		resp, err := http.Post(ts.URL+"/api/rooms", "application/json",
			strings.NewReader(`{"files":[{"name":"x","size":1}]}`))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}
	if post() != 201 || post() != 201 {
		t.Fatal("burst should pass")
	}
	resp, err := http.Post(ts.URL+"/api/rooms", "application/json",
		strings.NewReader(`{"files":[{"name":"x","size":1}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 429 || resp.Header.Get("Retry-After") != "60" {
		t.Fatalf("status = %d ra = %q", resp.StatusCode, resp.Header.Get("Retry-After"))
	}
}

func TestSecondaryTURNAppended(t *testing.T) {
	cfg := testConfig()
	cfg.Turn2Host = "turn2.example.com"
	cfg.Turn2Secret = "other"
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	id := createRoom(t, ts.URL)
	resp, err := http.Get(ts.URL + "/api/rooms/" + id + "/turn")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var turn struct {
		IceServers []struct {
			Urls       string `json:"urls"`
			Username   string `json:"username"`
			Credential string `json:"credential"`
		} `json:"iceServers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&turn); err != nil {
		t.Fatal(err)
	}
	if len(turn.IceServers) != 7 {
		t.Fatalf("servers = %d", len(turn.IceServers))
	}
	if !strings.HasPrefix(turn.IceServers[4].Urls, "turn:turn2.example.com") ||
		!strings.HasPrefix(turn.IceServers[6].Urls, "turns:turn2.example.com") {
		t.Fatalf("order = %+v", turn.IceServers)
	}
	if turn.IceServers[4].Credential == turn.IceServers[1].Credential {
		t.Fatal("secondary must mint with its own secret")
	}
}

func TestShutdownByesEveryone(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	id := createRoom(t, ts.URL)
	rx := dialWS(t, ts.URL, id, "role=receiver&peer=rx-9")
	defer rx.Close()
	_ = readFrame(t, rx, "presence") // join announcement drains
	srv.Shutdown()
	if f := readFrame(t, rx, "bye"); f.From != "server" {
		t.Fatalf("bye = %+v", f)
	}
}

func TestStaticRoutes(t *testing.T) {
	srv := mustServer(t, testConfig()) // WebDir ../web ships restored UI
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	// /styles.css and /states.css are deliberately NOT routes: both stylesheets
	// are inlined into the HTML at load time (see static.go inlineStyles), so a
	// separate render-blocking request never happens. /debug is also not here:
	// it is gated on SIGNAL_DEBUG (see TestDebugHarnessGated).
	for path, wantCT := range map[string]string{
		"/": "text/html", "/receive": "text/html", "/r/abc123": "text/html",
		"/blog": "text/html", "/blog/": "text/html",
		"/blog/wetransfer-alternative": "text/html",
		"/app.js":                      "text/javascript",
		"/qrcode.js":                   "text/javascript", "/sw.js": "text/javascript",
	} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body := make([]byte, 64)
		n, _ := resp.Body.Read(body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("GET %s = %d", path, resp.StatusCode)
		}
		if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, wantCT) {
			t.Fatalf("GET %s content-type = %q", path, ct)
		}
		if n == 0 {
			t.Fatalf("GET %s empty", path)
		}
	}
	if resp, err := http.Get(ts.URL + "/nope"); err != nil || resp.StatusCode != 404 {
		t.Fatalf("unknown path: %v", resp.StatusCode)
	} else {
		resp.Body.Close()
	}
}

func TestMetricsPrometheus(t *testing.T) {
	// Metrics are fail-closed by default (admin token required); see
	// TestMetricsGated for the negative cases.
	cfg := testConfig()
	cfg.AdminToken = "test-admin-token"
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	req, _ := http.NewRequest("GET", ts.URL+"/metrics", nil)
	req.Header.Set("Authorization", "Bearer test-admin-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	buf := new(strings.Builder)
	b := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(b)
		buf.Write(b[:n])
		if err != nil {
			break
		}
	}
	out := buf.String()
	for _, want := range []string{
		"# HELP p2pfilesharing_rooms_active", "# TYPE p2pfilesharing_rooms_active gauge",
		"p2pfilesharing_rooms_active 0", "p2pfilesharing_rate_limited",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("metrics missing %q:\n%s", want, out)
		}
	}
}

func TestLateJoinGetsOffer(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	id := createRoom(t, ts.URL)
	// Sender joins AND offers before any receiver exists.
	sender := dialWS(t, ts.URL, id, "role=sender&peer=sender")
	defer sender.Close()
	_ = sender.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, _ = sender.ReadMessage() // presence
	sendFrame(t, sender, "sender", "receivers", "offer", `{"sdp":"early"}`)
	// Late receiver must still get the offer via mailbox replay.
	rx := dialWS(t, ts.URL, id, "role=receiver&peer=rx-late")
	defer rx.Close()
	if f := readFrame(t, rx, "offer"); f.Payload != `{"sdp":"early"}` || f.Seq == 0 {
		t.Fatalf("late offer = %+v", f)
	}
}

func TestSpoofedFromDropped(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	id := createRoom(t, ts.URL)
	sender := dialWS(t, ts.URL, id, "role=sender&peer=sender")
	defer sender.Close()
	rx := dialWS(t, ts.URL, id, "role=receiver&peer=rx-1")
	defer rx.Close()
	// Drain all presence noise (sender-join + receiver-join announcements).
	_ = sender.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	for {
		if _, _, err := sender.ReadMessage(); err != nil {
			break
		}
	}
	// rx-1's answer smuggled over the sender's socket must be dropped:
	// nothing may be routed and nothing may arrive.
	sendFrame(t, sender, "rx-1", "sender", "answer", `{}`)
	_ = sender.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	if _, _, err := sender.ReadMessage(); err == nil {
		t.Fatal("spoofed frame was routed")
	}
	if got := srv.store.Routed(); got != 0 {
		t.Fatalf("routed = %d", got)
	}
}

func mustServer(t *testing.T, cfg Config) *Server {
	t.Helper()
	srv, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return srv
}

func TestStaticETag304(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	get := func(path string, hdr map[string]string) *http.Response {
		req, _ := http.NewRequest("GET", ts.URL+path, nil)
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		// drain for reuse
		b := make([]byte, 1<<20)
		for {
			n, err := resp.Body.Read(b)
			if n == 0 || err != nil {
				break
			}
		}
		return resp
	}
	r1 := get("/app.js", nil)
	etag := r1.Header.Get("ETag")
	cc := r1.Header.Get("Cache-Control")
	if r1.StatusCode != 200 || etag == "" || !strings.HasPrefix(cc, "public") {
		t.Fatalf("app.js = %d etag=%q cc=%q", r1.StatusCode, etag, cc)
	}
	r2 := get("/app.js", map[string]string{"If-None-Match": etag})
	if r2.StatusCode != 304 {
		t.Fatalf("revalidate = %d, want 304", r2.StatusCode)
	}
	r3 := get("/", nil)
	if cc := r3.Header.Get("Cache-Control"); cc != "no-cache" || r3.Header.Get("ETag") == "" {
		t.Fatalf("index cc=%q", cc)
	}
}

func TestStaticGzip(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	plain, err := http.Get(ts.URL + "/qrcode.js")
	if err != nil {
		t.Fatal(err)
	}
	defer plain.Body.Close()
	req, _ := http.NewRequest("GET", ts.URL+"/qrcode.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rawClient := &http.Client{Transport: &http.Transport{DisableCompression: true}}
	gz, err := rawClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Body.Close()
	if gz.Header.Get("Content-Encoding") != "gzip" {
		t.Fatal("no gzip encoding")
	}
	var (
		rawBuf, wireBuf bytes.Buffer
		tmp             = make([]byte, 32768)
	)
	for {
		n, err := plain.Body.Read(tmp)
		rawBuf.Write(tmp[:n])
		if err != nil {
			break
		}
	}
	for {
		n, err := gz.Body.Read(tmp)
		wireBuf.Write(tmp[:n])
		if err != nil {
			break
		}
	}
	t.Logf("qrcode.js raw=%d wire-gz=%d", rawBuf.Len(), wireBuf.Len())
	if wireBuf.Len()*2 > rawBuf.Len() {
		t.Fatal("gzip not compressing")
	}
	gr, err := gzip.NewReader(bytes.NewReader(wireBuf.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	var decBuf bytes.Buffer
	for {
		n, err := gr.Read(tmp)
		decBuf.Write(tmp[:n])
		if err != nil {
			break
		}
	}
	if !bytes.Equal(rawBuf.Bytes(), decBuf.Bytes()) {
		t.Fatal("gzip round-trip mismatch")
	}
}

func TestBadWebDirFailsFast(t *testing.T) {
	cfg := testConfig()
	cfg.WebDir = "/nonexistent-dir-xyz"
	if _, err := New(cfg); err == nil {
		t.Fatal("expected startup error")
	}
}

func adminCfg() Config {
	cfg := testConfig()
	cfg.AdminToken = "op-secret"
	return cfg
}

func postJSON(t *testing.T, url, token, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b := make([]byte, 2048)
	n, _ := resp.Body.Read(b)
	return resp.StatusCode, string(b[:n])
}

// adminGet fetches an operator endpoint with a bearer token.
func adminGet(t *testing.T, base, path, token string) string {
	t.Helper()
	req, _ := http.NewRequest("GET", base+path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		t.Fatalf("GET %s = %d %s", path, resp.StatusCode, b)
	}
	return string(b)
}

func TestReportFlow(t *testing.T) {
	srv := mustServer(t, adminCfg())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	id := createRoom(t, ts.URL)
	if code, _ := postJSON(t, ts.URL+"/api/rooms/"+id+"/report", "", `{"reason":"spam"}`); code != 201 {
		t.Fatalf("report = %d", code)
	}
	if code, _ := postJSON(t, ts.URL+"/api/rooms/"+id+"/report", "", `{"reason":"bogus"}`); code != 400 {
		t.Fatalf("bad reason = %d", code)
	}
	// A report for a room that has already ended is still recorded. It used to
	// 404, which made reporting useless: the moment a recipient decides
	// something was malicious, the sender has normally closed their tab, so the
	// room is gone exactly when the report is filed.
	if code, _ := postJSON(t, ts.URL+"/api/rooms/xxxxxxxxxx/report", "", `{"reason":"spam"}`); code != 201 {
		t.Fatalf("report on an ended room = %d, want 201 (the report is the only record left)", code)
	}
	// inbox needs the token
	resp, err := http.Get(ts.URL + "/api/admin/reports")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("no token = %d", resp.StatusCode)
	}
	req, _ := http.NewRequest("GET", ts.URL+"/api/admin/reports", nil)
	req.Header.Set("Authorization", "Bearer op-secret")
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	var inbox struct {
		Reports []struct {
			Room     string `json:"room"`
			Reason   string `json:"reason"`
			RoomLive bool   `json:"roomLive"`
		} `json:"reports"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&inbox); err != nil {
		t.Fatal(err)
	}
	// Both reports are kept: the live room's, and the one for the room that has
	// already ended. The second is the whole point — it is filed after the room
	// is gone. roomLive tells the operator which of the two could still be acted
	// on by disabling the room right now.
	if len(inbox.Reports) != 2 {
		t.Fatalf("inbox = %+v, want both reports kept", inbox)
	}
	if inbox.Reports[0].Room != id || inbox.Reports[0].Reason != "spam" || !inbox.Reports[0].RoomLive {
		t.Fatalf("live-room report = %+v", inbox.Reports[0])
	}
	if inbox.Reports[1].Room != "xxxxxxxxxx" || inbox.Reports[1].RoomLive {
		t.Fatalf("ended-room report = %+v (want roomLive=false)", inbox.Reports[1])
	}
}

func TestAdminDisabled503(t *testing.T) {
	srv := mustServer(t, testConfig()) // no ADMIN_TOKEN
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	if code, _ := postJSON(t, ts.URL+"/api/admin/rooms/x/disable", "whatever", `{"reason":"spam"}`); code != 503 {
		t.Fatalf("admin surface = %d", code)
	}
}

func TestDisableKillsRoom451(t *testing.T) {
	srv := mustServer(t, adminCfg())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	id := createRoom(t, ts.URL)
	rx := dialWS(t, ts.URL, id, "role=receiver&peer=rx-1")
	defer rx.Close()
	_ = readFrame(t, rx, "presence")
	if code, _ := postJSON(t, ts.URL+"/api/admin/rooms/"+id+"/disable", "wrong", `{"reason":"spam"}`); code != 401 {
		t.Fatalf("bad token = %d", code)
	}
	if code, _ := postJSON(t, ts.URL+"/api/admin/rooms/"+id+"/disable", "op-secret", `{"reason":"spam"}`); code != 200 {
		t.Fatalf("disable = %d", code)
	}
	// peer got bye + hangup
	if f := readFrame(t, rx, "bye"); f.From != "server" {
		t.Fatalf("bye = %+v", f)
	}
	// REST now 451 with reason
	resp, err := http.Get(ts.URL + "/api/rooms/" + id)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]string
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if resp.StatusCode != 451 || body["reason"] != "spam" {
		t.Fatalf("get = %d %+v", resp.StatusCode, body)
	}
	// WS join to disabled room → upgrade then 4401 close
	wbase := "ws" + strings.TrimPrefix(ts.URL, "http")
	c, err := ws.Dial(wbase+"/ws/rooms/"+id+"?role=receiver&peer=rx-2", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := c.ReadMessage(); err == nil {
		t.Fatal("expected 4401 close")
	}
	// Report on an already-disabled room → 200 with a note, not an error. The
	// report is still filed (it is the record of the abuse), but the client is
	// told no further action is needed instead of seeing a failure.
	if code, body := postJSON(t, ts.URL+"/api/rooms/"+id+"/report", "", `{"reason":"spam"}`); code != 200 || !strings.Contains(body, "already_disabled") {
		t.Fatalf("report on disabled room = %d %s, want 200 already_disabled", code, body)
	}
	if code, body := postJSON(t, ts.URL+"/api/admin/rooms/"+id+"/disable", "op-secret", `{"reason":"spam"}`); code != 200 || !strings.Contains(body, "already_disabled") {
		t.Fatalf("redisable = %d %s", code, body)
	}
	// nearby code freed (room gone, tombstone doesn't hold it)
	nr, err := http.Get(ts.URL + "/api/nearby/0000")
	if err != nil {
		t.Fatal(err)
	}
	nr.Body.Close()
	if nr.StatusCode != 404 {
		t.Fatalf("nearby = %d", nr.StatusCode)
	}
}

func TestVersionedAssetURLs(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	// ReadAll, not a single Read: one Read returns whatever has arrived so far,
	// so asserting on it is asserting on timing, not on the served document.
	b, _ := io.ReadAll(resp.Body)
	html := string(b)
	if !strings.Contains(html, "/app.js?v=") {
		t.Fatalf("no versioned urls:\n%s", html[:500])
	}
	// The stylesheets are inlined, so they must not appear as separate requests.
	if strings.Contains(html, "styles.css") {
		t.Fatalf("page still references styles.css:\n%s", html[:500])
	}
	// Query string must not affect serving.
	if r2, err := http.Get(ts.URL + "/app.js?v=deadbeef"); err != nil || r2.StatusCode != 200 {
		t.Fatalf("versioned asset: %v", r2.StatusCode)
	} else {
		r2.Body.Close()
	}
}

// The durable report log is the only thing that survives a restart, so a failed
// append must not be reported to the reporter as success. The room is still
// disabled in memory (the abuse is stopped either way), but "received" is a lie
// when nothing reached the disk, and the reporter is the person who would know.
func TestReportThatCannotPersistSaysSo(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig()
	// A path that opens cleanly at startup — so the log IS configured — and
	// then becomes unwritable. A path that fails to open at startup takes the
	// other branch: it logs "report log disabled" and reporting falls back to
	// memory, which is a different (and already-covered) failure.
	cfg.ReportLog = filepath.Join(dir, "reports.jsonl")
	cfg.AdminToken = "op-secret"

	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	id := createRoom(t, ts.URL)

	// Replace the log file with a directory: OpenFile for append now fails.
	if err := os.RemoveAll(cfg.ReportLog); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(cfg.ReportLog, 0o700); err != nil {
		t.Fatal(err)
	}

	code, body := postJSON(t, ts.URL+"/api/rooms/"+id+"/report", "", `{"reason":"spam"}`)
	if code != 503 || !strings.Contains(body, "report_not_persisted") {
		t.Fatalf("report with an unwritable log = %d %s, want 503 report_not_persisted", code, body)
	}
	if srv.reportLogErrors.Load() == 0 {
		t.Error("report_log_errors was not counted — the operator would have no signal")
	}
	// The room is still disabled: the abuse is stopped even though durability
	// was lost, and the reporter must not be able to keep the transfer alive by
	// simply retrying against a full disk.
	if code, _ := postJSON(t, ts.URL+"/api/admin/rooms/"+id+"/disable", "op-secret", `{"reason":"spam"}`); code != 200 {
		t.Fatalf("room was not disabled after a failed report write: %d", code)
	}
	resp, err := http.Get(ts.URL + "/api/rooms/" + id)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 451 {
		t.Fatalf("disabled room reads %d, want 451", resp.StatusCode)
	}
}

// The operator inbox must distinguish a healthy log from a degraded one. It
// used to fall back to memory while the code claimed "the failure is visible in
// the logs" — and no logger existed, so after a restart an empty list looked
// like "no reports yet".
func TestAdminInboxReportsDurability(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig()
	cfg.ReportLog = filepath.Join(dir, "reports.jsonl")
	cfg.AdminToken = "op-secret"
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	id := createRoom(t, ts.URL)
	if code, body := postJSON(t, ts.URL+"/api/rooms/"+id+"/report", "", `{"reason":"spam"}`); code != 201 {
		t.Fatalf("report = %d %s", code, body)
	}
	body := adminGet(t, ts.URL, "/api/admin/reports", "op-secret")
	if !strings.Contains(body, `"durable":true`) {
		t.Fatalf("a healthy log reported durable=false: %s", body)
	}

	// Break the log, then read again.
	if err := os.RemoveAll(cfg.ReportLog); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(cfg.ReportLog, 0o700); err != nil {
		t.Fatal(err)
	}
	body = adminGet(t, ts.URL, "/api/admin/reports", "op-secret")
	if !strings.Contains(body, `"durable":false`) {
		t.Fatalf("an unreadable log still claimed durable=true: %s", body)
	}
}

// Every limiter's bucket map must be swept, not just four of the six.
// usageLimit and metricsLimit were omitted from reapLoop, and POST /api/usage is
// unauthenticated and consults its limiter BEFORE validating the body — so each
// request from a new IP permanently added a map entry. IPv6 source-address
// rotation turns one client into millions of retained buckets.
func TestReapSweepsEveryLimiter(t *testing.T) {
	cfg := testConfig()
	// httptest's peer is loopback, so TRUST_PROXY must be on for the forged
	// per-IP headers below to become distinct buckets.
	cfg.TrustProxy = true
	// The metrics limiter is only consulted when a browser password is
	// configured, so it must be set for that endpoint to create buckets.
	cfg.MetricsPassword = "pw"
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	// The TURN limiter is consulted before the room lookup, so unknown rooms
	// would also create buckets — but a real room keeps this test coupled to
	// the served path rather than the 404 path.
	room := createRoom(t, ts.URL)

	// One request from each of 12 distinct client IPs, spread across every
	// limited endpoint (including /api/usage, which validates nothing first).
	for i := 0; i < 12; i++ {
		ip := fmt.Sprintf("203.0.113.%d", i+1)
		for _, path := range []struct{ method, url, body string }{
			{"POST", "/api/rooms", `{"files":[{"name":"a","size":1}]}`},
			{"GET", "/api/rooms/" + room + "/turn", ""},
			{"POST", "/api/rooms/" + room + "/report", `{"reason":"spam"}`},
			{"GET", "/api/nearby/0001", ""},
			{"POST", "/api/usage", `{"n":1}`},
			{"GET", "/metrics", ""},
		} {
			req, _ := http.NewRequest(path.method, ts.URL+path.url, strings.NewReader(path.body))
			req.Header.Set("X-Forwarded-For", ip)
			if path.method == "POST" {
				req.Header.Set("Content-Type", "application/json")
			}
			req.Header.Set("X-Metrics-Password", "pw")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
		}
	}

	lims := map[string]*Limiter{
		"create":  srv.createLimit,
		"turn":    srv.turnLimit,
		"report":  srv.reportLimit,
		"nearby":  srv.nearbyLimit,
		"usage":   srv.usageLimit,
		"metrics": srv.metricsLimit,
	}
	for name, l := range lims {
		if n := l.Size(); n < 12 {
			t.Errorf("%s limiter holds %d buckets after 12 distinct IPs, want >= 12 — the test is not exercising it", name, n)
		}
	}
	// One sweep, as reapLoop does — through the real entry point, so removing a
	// Sweep call from sweepAll fails this test.
	srv.sweepAll(time.Now().Add(24 * time.Hour))
	for name, l := range lims {
		if n := l.Size(); n != 0 {
			t.Errorf("%s limiter kept %d buckets after a sweep 24h later; reapLoop does not call Sweep on it", name, n)
		}
	}
}

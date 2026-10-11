package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"signal/internal/ws"
)

// wsDial is dialWS without t.Fatal, so a rejected upgrade is a testable
// outcome instead of a test crash.
func wsDial(base, room, qs string) (*ws.Conn, error) {
	wbase := "ws" + strings.TrimPrefix(base, "http")
	return ws.Dial(wbase+"/ws/rooms/"+room+"?"+qs, 1<<20)
}

// The hardening in security.go exists because of specific, named failure modes.
// Each test below states the attack it blocks: a test that only exercises the
// happy path would keep passing after the protection was silently deleted.

func TestSecurityHeadersPresent(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	want := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		// The room id lives in every share link and QR, so a Referer leak to
		// any third party would hand over a live transfer. no-referrer, not
		// same-origin.
		"Referrer-Policy":    "no-referrer",
		"Permissions-Policy": "geolocation=(), microphone=(), camera=(), interest-cohort=()",
	}
	for k, v := range want {
		if got := resp.Header.Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	csp := resp.Header.Get("Content-Security-Policy")
	for _, d := range []string{"default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"} {
		if !strings.Contains(csp, d) {
			t.Errorf("CSP missing %q:\n%s", d, csp)
		}
	}
	// Plain http must not claim HSTS — an unwrapped deployment should not be
	// told its connection is secure when it is not.
	if h := resp.Header.Get("Strict-Transport-Security"); h != "" {
		t.Errorf("HSTS on plain http = %q", h)
	}
}

// The /architecture wrapper embeds its viewer in a same-origin iframe, so
// those two static doc pages — and only those — relax framing to SAMEORIGIN.
// Clickjacking needs a state-changing click or ambient credentials to ride;
// these responses carry neither, so scoping the exception here costs nothing.
func TestFramableDocsAllowSameOriginEmbed(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	for _, p := range []string{"/architecture", "/architecture-viewer"} {
		resp, err := http.Get(ts.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if got := resp.Header.Get("X-Frame-Options"); got != "SAMEORIGIN" {
			t.Errorf("GET %s X-Frame-Options = %q, want SAMEORIGIN", p, got)
		}
		csp := resp.Header.Get("Content-Security-Policy")
		if !strings.Contains(csp, "frame-ancestors 'self'") {
			t.Errorf("GET %s CSP missing frame-ancestors 'self':\n%s", p, csp)
		}
		if strings.Contains(csp, "frame-ancestors 'none'") {
			t.Errorf("GET %s CSP still denies framing:\n%s", p, csp)
		}
	}
}

// The framable exception above must not leak: app pages keep DENY.
func TestAppPagesStillDenyFraming(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	for _, p := range []string{"/", "/receive", "/r/FAKEID01", "/privacy"} {
		resp, err := http.Get(ts.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if got := resp.Header.Get("X-Frame-Options"); got != "DENY" {
			t.Errorf("GET %s X-Frame-Options = %q, want DENY", p, got)
		}
		if csp := resp.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "frame-ancestors 'none'") {
			t.Errorf("GET %s CSP missing frame-ancestors 'none':\n%s", p, csp)
		}
	}
}

// A page served behind a TLS-terminating proxy (X-Forwarded-Proto: https)
// SHOULD carry HSTS, since that is where it actually matters.
func TestHSTSOnlyOverTLS(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	req, _ := http.NewRequest("GET", ts.URL+"/", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if h := resp.Header.Get("Strict-Transport-Security"); !strings.Contains(h, "max-age=") {
		t.Errorf("no HSTS behind TLS proxy: %q", h)
	}
}

// CORS was "*", which let any website a user visits mint rooms and file abuse
// reports against them using that user's browser. It is an allowlist now.
func TestCORSIsAllowlistNotWildcard(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// Allowed by default: local dev.
	for _, origin := range []string{"http://localhost:5173", "https://my-app.pages.dev"} {
		req, _ := http.NewRequest("POST", ts.URL+"/api/rooms", strings.NewReader(`{"files":[{"name":"a.bin","size":1}]}`))
		req.Header.Set("Origin", origin)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if got := resp.Header.Get("Access-Control-Allow-Origin"); got != origin {
			t.Errorf("origin %s: ACAO = %q, want the origin echoed back", origin, got)
		}
		if resp.StatusCode == http.StatusForbidden {
			t.Errorf("origin %s rejected but is on the default allowlist", origin)
		}
	}

	// An arbitrary third-party site must not get CORS permission, and must not
	// get a silent success either.
	for _, origin := range []string{"https://evil.example", "https://pages.dev.attacker.tld"} {
		req, _ := http.NewRequest("POST", ts.URL+"/api/rooms", strings.NewReader(`{"files":[{"name":"a.bin","size":1}]}`))
		req.Header.Set("Origin", origin)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("origin %s was allowed (ACAO=%q)", origin, got)
		}
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("origin %s: status = %d, want 403", origin, resp.StatusCode)
		}
	}
}

// A preflighted cross-origin fetch of /metrics carries Authorization or
// X-Metrics-Password, so both must appear in Access-Control-Allow-Headers.
// Without them the browser blocks the read even from an allowlisted origin,
// and the metrics API "does not load" while curl works fine.
func TestCORSPreflightAllowsMetricsAuthHeaders(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	req, _ := http.NewRequest(http.MethodOptions, ts.URL+"/metrics", nil)
	req.Header.Set("Origin", "https://my-app.pages.dev")
	req.Header.Set("Access-Control-Request-Method", "GET")
	req.Header.Set("Access-Control-Request-Headers", "authorization, x-metrics-password")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", resp.StatusCode)
	}
	got := resp.Header.Get("Access-Control-Allow-Headers")
	for _, h := range []string{"authorization", "x-metrics-password"} {
		if !strings.Contains(strings.ToLower(got), h) {
			t.Errorf("Access-Control-Allow-Headers = %q, missing %q", got, h)
		}
	}
}

// A wildcard-subdomain entry must not match the parent domain or a lookalike
// suffix — the classic allowlist bypass.
func TestCORSWildcardSubdomainIsExact(t *testing.T) {
	req := httptest.NewRequest("GET", "https://srv.example/", nil)
	req.Host = "srv.example"
	allowed := []string{"https://*.pages.dev"}
	for _, origin := range []string{"https://app.pages.dev", "https://a.b.pages.dev"} {
		if !originAllowed(origin, req, allowed) {
			t.Errorf("%s should be allowed by https://*.pages.dev", origin)
		}
	}
	for _, origin := range []string{
		"https://pages.dev", // the parent itself is NOT covered
		"https://evil.pages.dev.attacker.tld",
		"http://app.pages.dev", // scheme matters
	} {
		if originAllowed(origin, req, allowed) {
			t.Errorf("%s must not match https://*.pages.dev", origin)
		}
	}
}

func TestSameOriginAlwaysAllowed(t *testing.T) {
	req := httptest.NewRequest("POST", "http://127.0.0.1:8090/api/rooms", nil)
	req.Host = "127.0.0.1:8090"
	if !originAllowed("http://127.0.0.1:8090", req, nil) {
		t.Error("same-origin request rejected with an empty allowlist")
	}
	// Default ports must compare equal, or every browser behind :443 breaks.
	r2 := httptest.NewRequest("GET", "https://x/", nil)
	r2.Host = "x"
	if !originAllowed("https://x:443", r2, nil) {
		t.Error("https://x:443 should equal host x")
	}
}

// json.Decode on an unbounded body lets one request stream gigabytes into
// memory. The cap must produce a 413, not a generic 400.
func TestRequestBodySizeCapped(t *testing.T) {
	cfg := testConfig()
	cfg.RateCreatePerMin = 1000
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// One file entry with a name far beyond the 16 KB cap.
	huge := fmt.Sprintf(`{"files":[{"name":%q,"size":1}],"nearby":true}`, strings.Repeat("A", 64<<10))
	resp, err := http.Post(ts.URL+"/api/rooms", "application/json", strings.NewReader(huge))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized create = %d, want 413", resp.StatusCode)
	}

	// Every capped route must answer 413, not a bare 400. rejectIfOversized used
	// to match the stdlib's error TEXT, so a change to that wording would have
	// turned a clear "too large" into an indistinguishable "bad request" on
	// every route at once, with no test failing.
	for _, path := range []struct{ method, url, body string }{
		{"POST", "/api/rooms", `{"files":[{"name":%q,"size":1}]}`},
		{"POST", "/api/rooms/x/report", `{"reason":"spam","contact":%q}`},
	} {
		body := fmt.Sprintf(path.body, strings.Repeat("A", 64<<10))
		req, _ := http.NewRequest(path.method, ts.URL+path.url, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusRequestEntityTooLarge {
			t.Errorf("oversized %s = %d, want 413", path.url, resp.StatusCode)
		}
	}
}

// A nearby code is 4 digits: 9 000 values. Unthrottled, the whole space is
// walkable in ~9k requests, which enumerates live rooms and yields joinable
// room ids. A human types a code a handful of times.
func TestNearbyCodeRateLimited(t *testing.T) {
	cfg := testConfig()
	cfg.RateNearbyPerMin = 5
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	codes := 0
	for i := 0; i < 40; i++ {
		resp, err := http.Get(fmt.Sprintf("%s/api/nearby/%04d", ts.URL, i))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusTooManyRequests {
			codes++
			if got := resp.Header.Get("Retry-After"); got == "" {
				t.Error("429 without Retry-After")
			}
			continue
		}
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("code %04d = %d, want 404 or 429", i, resp.StatusCode)
		}
	}
	if codes == 0 {
		t.Fatal("enumeration never throttled: 40 guesses across a 4-digit space")
	}
}

// The file name is attacker-controlled and becomes the receiver's suggested
// download name, so it must not carry traversal or extension-spoofing tricks.
func TestFileNameValidation(t *testing.T) {
	cfg := testConfig()
	cfg.RateCreatePerMin = 1000
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	bad := []string{
		"../../../../etc/passwd",
		"..\\..\\windows\\system32",
		"sub/dir/file.bin",
		".",
		"..",
		"...",
		"evil\x00.bin",
		"line\nbreak.bin",
		"invoice.pdf\u202egpj.exe", // bidi override: "exe.pdf" rendered
		"invoice\u2066.pdf",        // bidi isolate
		"zero\u200fwidth.bin",
		"photo.jpg.", // Windows silently strips the trailing dot
		"photo.jpg ", // ...and the trailing space
		"CON",        // Windows device: the save silently discards the bytes
		"con.txt",    // ...with any extension
		"PRN",
		"AUX",
		"NUL",
		"COM1",
		"LPT9",
	}
	for _, name := range bad {
		body, _ := json.Marshal(map[string]any{"files": []map[string]any{{"name": name, "size": 10}}})
		resp, err := http.Post(ts.URL+"/api/rooms", "application/json", strings.NewReader(string(body)))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("name %q accepted with %d", name, resp.StatusCode)
		}
	}
	// The live `files` WebSocket frame is the ONLY way a filename can change
	// after creation, and it is sender-controlled. Without validation there, a
	// name this test rejects at REST was served to receivers and became the name
	// written to their disk. Verified live before the fix: POST /api/rooms with
	// "../../etc/passwd" returned 400, and the same name over this frame was
	// served by GET /api/rooms/{id}.
	live := dialWS(t, ts.URL, createRoom(t, ts.URL), "role=sender&peer=sender")
	defer live.Close()
	_ = live.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, _ = live.ReadMessage() // presence
	for _, tc := range []struct{ id, name string }{
		{"f1", "../../etc/passwd"},
		{"f2", "sub/dir/file.bin"},
		{"f3", "CON"},
		{"f4", "photo.jpg."},
		{"f5", "invoice.pdf‮gpj.exe"},
		{`f6"onclick=alert(1) x="`, "looks-fine.bin"}, // id reaches a querySelector
	} {
		payload, _ := json.Marshal(map[string]any{"files": []map[string]any{
			{"id": tc.id, "name": tc.name, "size": 10},
		}})
		sendFrame(t, live, "sender", "receivers", "files", string(payload))
	}
	// Every one of those frames must have been rejected and counted. Poll the
	// counter rather than sleeping a fixed amount.
	deadline := time.Now().Add(2 * time.Second)
	for srv.routeErrors.Load() < 6 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if got := srv.routeErrors.Load(); got < 6 {
		t.Errorf("route_errors = %d, want >= 6: the live manifest frame accepted rejected names", got)
	}

	// Real-world names must keep working, including unicode.
	for _, name := range []string{"demo-video.mp4", "photo 2026.jpeg", "Ünïcode-ñame.pdf", "a..b.txt", "console.log", strings.Repeat("n", 255)} {
		body, _ := json.Marshal(map[string]any{"files": []map[string]any{{"name": name, "size": 10}}})
		resp, err := http.Post(ts.URL+"/api/rooms", "application/json", strings.NewReader(string(body)))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusCreated {
			t.Errorf("legit name %q rejected with %d", name, resp.StatusCode)
		}
	}
}

// TRUST_PROXY=1 on a directly-reachable service means anyone can mint a fresh
// rate-limit bucket per request by sending their own X-Forwarded-For. The
// header is only believed when the direct peer is itself private/loopback.
// Caddy (and nginx) APPEND the address they observed to whatever X-Forwarded-For
// the client already sent, so the list is client-controlled up to its last entry.
// Keying the limiter on the leftmost entry therefore hands every caller a fresh
// bucket per request and voids every per-IP limit in the file — RATE_NEARBY_PER_MIN
// is the documented defence for the 9 000-value nearby-code space.
//
// Verified live before the fix: 40 requests with 40 distinct forged leftmost
// values returned 40x201 and 0x429, where the same 40 without forging split
// 30x201 / 10x429.
func TestForwardedForTakesProxyAppendedHop(t *testing.T) {
	for _, tc := range []struct {
		name, xff, remote, want string
	}{
		{"forged prefix is ignored", "203.0.113.9, 198.51.100.7", "127.0.0.1:5555", "198.51.100.7"},
		{"single entry", "203.0.113.9", "127.0.0.1:5555", "203.0.113.9"},
		{"two forged entries", "1.1.1.1, 2.2.2.2, 198.51.100.7", "10.0.0.5:5555", "198.51.100.7"},
		{"public peer is not trusted", "203.0.113.9, 198.51.100.7", "203.0.113.1:5555", "203.0.113.1"},
		{"spaces trimmed", "1.1.1.1,   198.51.100.7  ", "127.0.0.1:5555", "198.51.100.7"},
	} {
		r := &http.Request{
			Header:     http.Header{"X-Forwarded-For": []string{tc.xff}},
			RemoteAddr: tc.remote,
		}
		if got := clientIP(r, Config{TrustProxy: true}); got != tc.want {
			t.Errorf("%s: clientIP(%q) = %q, want %q", tc.name, tc.xff, got, tc.want)
		}
	}

	// End to end, with the real limiter behind a trusted proxy: forging a new
	// leftmost entry per request must not buy a new bucket.
	cfg := testConfig()
	cfg.TrustProxy = true
	cfg.RateCreatePerMin = 3
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	throttled := false
	for i := 0; i < 10; i++ {
		req, _ := http.NewRequest("POST", ts.URL+"/api/rooms", strings.NewReader(`{"files":[{"name":"a.bin","size":1}]}`))
		// The forged prefix varies per request; the appended hop is the loopback
		// peer, i.e. what a real Caddy would write.
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("203.0.113.%d, 198.51.100.7", i+1))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusTooManyRequests {
			throttled = true
		}
	}
	if !throttled {
		t.Error("forging a new X-Forwarded-For prefix per request bypassed the create rate limit")
	}
}

func TestForwardedForOnlyFromPrivatePeer(t *testing.T) {
	for _, tc := range []struct {
		remote string
		want   bool
	}{
		{"127.0.0.1:5555", true},
		{"[::1]:5555", true},
		{"10.1.2.3:5555", true},
		{"192.168.1.9:5555", true},
		{"203.0.113.7:5555", false}, // public peer → header is a lie
	} {
		if got := trustProxyHeader(true, tc.remote); got != tc.want {
			t.Errorf("trustProxyHeader(%q) = %v, want %v", tc.remote, got, tc.want)
		}
	}
	if trustProxyHeader(false, "127.0.0.1:5555") {
		t.Error("TRUST_PROXY off must never trust the header")
	}
	// End to end: with TRUST_PROXY off (a directly exposed service) a spoofed
	// X-Forwarded-For must not mint a fresh bucket per request.
	cfg := testConfig()
	cfg.RateCreatePerMin = 3
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	throttled := false
	for i := 0; i < 10; i++ {
		req, _ := http.NewRequest("POST", ts.URL+"/api/rooms", strings.NewReader(`{"files":[{"name":"a.bin","size":1}]}`))
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("203.0.113.%d", i+1))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusTooManyRequests {
			throttled = true
		}
	}
	if !throttled {
		t.Error("spoofed X-Forwarded-For bypassed the create rate limit")
	}
}

// expectCloseCode asserts that c is closed with the given WebSocket close code.
// A refusal after the upgrade arrives this way rather than as a failed dial.
func expectCloseCode(t *testing.T, c *ws.Conn, want int, what string) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		if _, _, err := c.ReadMessage(); err != nil {
			if !strings.Contains(fmt.Sprint(err), fmt.Sprintf("code %d", want)) {
				t.Fatalf("%s closed with %v, want close code %d", what, err, want)
			}
			return
		}
	}
}

// A peer id names ONE live connection. The id is a client-chosen query
// parameter and every id is broadcast in the presence payload, so a
// re-registerable id lets a second socket take over the first one's routing
// slot: frames addressed to that id go to the attacker, the victim's send
// channel becomes unreachable from Delete/Disable/ExpireSweep, and the frame
// then arrives claiming the sender's identity — which docs/WIRE-PROTOCOL.md
// states is impossible ("mismatched frames are dropped silently (no
// impersonation)").
//
// The same hole defeats MaxPeers: reusing one id keeps len(peers) at 1, so the
// cap is never consulted and each connection still costs a socket, a channel
// and two goroutines.
func TestPeerIDIsExclusive(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	id := createRoom(t, ts.URL)

	sender := dialWS(t, ts.URL, id, "role=sender&peer=sender")
	defer sender.Close()
	_ = sender.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, _ = sender.ReadMessage() // presence

	// A receiver claiming the sender's own id must be refused, both when the
	// sender is present (duplicate) and — by the reserved-id rule — always.
	// Join happens after the upgrade, so the refusal surfaces as a close code
	// rather than a failed handshake.
	if imp, err := wsDial(ts.URL, id, "role=receiver&peer=sender"); err == nil {
		defer imp.Close()
		expectCloseCode(t, imp, ws.CloseDuplicatePeer, "a receiver holding the sender's peer id")
	} else {
		t.Logf("receiver claiming peer=sender refused at handshake: %v", err)
	}

	// Two receivers with the same id: the second must not overwrite the first.
	victim, err := wsDial(ts.URL, id, "role=receiver&peer=rx-victim")
	if err != nil {
		t.Fatalf("dial victim: %v", err)
	}
	defer victim.Close()
	_ = victim.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, _ = victim.ReadMessage() // presence
	if n := srv.store.PeerCount(id); n != 2 {
		t.Fatalf("peer count %d, want 2 (sender + victim)", n)
	}

	if dup, derr := wsDial(ts.URL, id, "role=receiver&peer=rx-victim"); derr == nil {
		defer dup.Close()
		expectCloseCode(t, dup, ws.CloseDuplicatePeer, "a duplicate peer id")
	} else {
		t.Logf("duplicate peer id refused at handshake: %v", derr)
	}
	if n := srv.store.PeerCount(id); n != 2 {
		t.Fatalf("peer count %d after a duplicate join, want 2 — the map grew", n)
	}
}

// A sender that never connects leaves its room un-evictable (the only eviction
// path is the sender-gone grace timer, and Create leaves goneAt zero). Every
// POST /api/rooms that is not followed by a sender join would therefore leak a
// Room for the life of the process — reachable at the documented create rate,
// so it is a slow memory exhaustion, not a single request.
func TestRoomWithNoSenderIsEvicted(t *testing.T) {
	cfg := testConfig()
	cfg.RateCreatePerMin = 100 // this test creates rooms in a loop; the limit is tested elsewhere
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	var ids []string
	for i := 0; i < 20; i++ {
		ids = append(ids, createRoom(t, ts.URL))
	}
	if n := srv.store.RoomCount(); n != len(ids) {
		t.Fatalf("room count %d, want %d", n, len(ids))
	}
	// The sender never joins, so the grace clock never starts. Sweep far past it.
	srv.store.ExpireSweep(time.Now().Add(24 * time.Hour))
	if n := srv.store.RoomCount(); n != 0 {
		t.Fatalf("room count %d after a 24h sweep, want 0: a room whose sender never joined is never evicted", n)
	}
}

// Each peer multiplies the work of every frame the sender routes, so an
// unbounded peer count turns a room id into an amplification primitive. The
// rejected peer must be closed with the policy code, not silently dropped.
func TestRoomPeerCap(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	id := createRoom(t, ts.URL)

	sender := dialWS(t, ts.URL, id, "role=sender&peer=sender")
	defer sender.Close()
	_ = sender.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, _ = sender.ReadMessage() // presence

	var held []*ws.Conn
	for i := 0; i < maxPeersPerRoom; i++ {
		c, err := wsDial(ts.URL, id, fmt.Sprintf("role=receiver&peer=rx-%d", i))
		if err != nil {
			t.Fatalf("dial receiver %d: %v", i, err)
		}
		held = append(held, c)
	}
	defer func() {
		for _, c := range held {
			c.Close()
		}
	}()
	// Give the server a moment to register every upgrade before probing.
	deadline := time.Now().Add(3 * time.Second)
	for srv.store.PeerCount(id) < maxPeersPerRoom && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if got := srv.store.PeerCount(id); got > maxPeersPerRoom {
		t.Fatalf("peer count %d exceeds the cap %d", got, maxPeersPerRoom)
	}

	// One more must be refused, and refused with the policy close code rather
	// than left hanging.
	over, err := wsDial(ts.URL, id, "role=receiver&peer=rx-over")
	if err == nil {
		defer over.Close()
		_ = over.SetReadDeadline(time.Now().Add(3 * time.Second))
		for {
			if _, _, rerr := over.ReadMessage(); rerr != nil {
				if !strings.Contains(fmt.Sprint(rerr), "code 1008") {
					t.Fatalf("over-cap peer closed with %v, want close code 1008 (ClosePolicy)", rerr)
				}
				return
			}
		}
	}
	// A refused upgrade at the HTTP layer is also acceptable.
	t.Logf("over-cap peer refused at handshake: %v", err)
}

// /debug creates rooms and drives WebSocket exchanges on demand: a ready-made
// abuse tool. It is a dev harness, so it must be off unless asked for.
func TestDebugHarnessGated(t *testing.T) {
	closed := mustServer(t, testConfig()) // EnableDebug defaults false
	ts := httptest.NewServer(closed.Handler())
	resp, err := http.Get(ts.URL + "/debug")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("GET /debug = %d, want 404 by default", resp.StatusCode)
	}
	ts.Close()

	cfg := testConfig()
	cfg.EnableDebug = true
	open := httptest.NewServer(mustServer(t, cfg).Handler())
	defer open.Close()
	resp2, err := http.Get(open.URL + "/debug")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Errorf("GET /debug with SIGNAL_DEBUG=1 = %d, want 200", resp2.StatusCode)
	}
}

// Counters are not secrets, but they are a free load/traffic oracle and a
// scrape target. Fail closed unless the operator opts in.
func TestMetricsGated(t *testing.T) {
	// No admin token configured and none presented: must not even confirm the
	// surface exists.
	ts := httptest.NewServer(mustServer(t, testConfig()).Handler())
	resp, err := http.Get(ts.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("unauthenticated /metrics = %d, want 404", resp.StatusCode)
	}
	ts.Close()

	// Admin token configured: wrong token is 401, right token is 200.
	cfg := testConfig()
	cfg.AdminToken = "sekrit"
	ts2 := httptest.NewServer(mustServer(t, cfg).Handler())
	defer ts2.Close()
	bad, _ := http.NewRequest("GET", ts2.URL+"/metrics", nil)
	bad.Header.Set("Authorization", "Bearer nope")
	r1, err := http.DefaultClient.Do(bad)
	if err != nil {
		t.Fatal(err)
	}
	r1.Body.Close()
	if r1.StatusCode != http.StatusUnauthorized {
		t.Errorf("wrong token = %d, want 401", r1.StatusCode)
	}
	good, _ := http.NewRequest("GET", ts2.URL+"/metrics", nil)
	good.Header.Set("Authorization", "Bearer sekrit")
	r2, err := http.DefaultClient.Do(good)
	if err != nil {
		t.Fatal(err)
	}
	r2.Body.Close()
	if r2.StatusCode != http.StatusOK {
		t.Errorf("right token = %d, want 200", r2.StatusCode)
	}

	// Explicit opt-out for a scraped /metrics endpoint.
	cfg3 := testConfig()
	cfg3.PublicMetrics = true
	ts3 := httptest.NewServer(mustServer(t, cfg3).Handler())
	defer ts3.Close()
	r3, err := http.Get(ts3.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	r3.Body.Close()
	if r3.StatusCode != http.StatusOK {
		t.Errorf("PUBLIC_METRICS=1 → %d, want 200", r3.StatusCode)
	}
}

// The admin surface must stay fully fail-closed: no token configured means the
// endpoint is inert, not open.
func TestAdminStillFailClosed(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Post(ts.URL+"/api/admin/rooms/abc/disable", "application/json", strings.NewReader(`{"reason":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("admin with no ADMIN_TOKEN = %d, want 503", resp.StatusCode)
	}
}

// The API host must NOT be in SIGNAL_ALLOWED_ORIGINS. It was listed for months
// doing nothing: sameOrigin() already allows any request whose Origin matches
// the request's own Host, so an API-hosted page never consults the list. Leaving
// it in implies the list is what grants that access, which is the belief that
// leads someone to "fix" the list by removing something that mattered.
func TestAPIHostNeedsNoAllowlistEntry(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/rooms", nil)
	r.Host = "api-files.example.com"
	r.Header.Set("Origin", "https://api-files.example.com")

	if !originAllowed(r.Header.Get("Origin"), r, nil) {
		t.Error("API host rejected with an EMPTY allowlist; same-origin must cover it")
	}
	// And it must be the same-origin rule doing the work, not a stray default.
	if !sameOrigin(r.Header.Get("Origin"), r) {
		t.Error("sameOrigin() should match the API host against itself")
	}
	// A different host on the same domain is a different origin and must not
	// inherit the grant.
	other := httptest.NewRequest("POST", "/api/rooms", nil)
	other.Host = "api-files.example.com"
	other.Header.Set("Origin", "https://p2pfilesharing.example.com")
	if originAllowed(other.Header.Get("Origin"), other, nil) {
		t.Error("a sibling subdomain was allowed with an empty allowlist")
	}
}

// An upgrade request must not carry a body into the frame parser. Hijack hands
// the raw bufio.Reader straight to readFrame, so unread body bytes were read as
// WebSocket frames and the connection died with close 1008 "extensions
// unsupported" — the first body byte parsed as a frame header. Every other JSON
// route on this server is capped; the upgrade was not.
func TestWebSocketUpgradeDrainsRequestBody(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	id := createRoom(t, ts.URL)

	// Speak HTTP/1.1 by hand so the upgrade carries a real Content-Length+body.
	conn, err := net.Dial("tcp", strings.TrimPrefix(ts.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	body := "BODYBYTES!!"
	req := "GET /ws/rooms/" + id + "?role=receiver&peer=rx-body HTTP/1.1\r\n" +
		"Host: " + strings.TrimPrefix(ts.URL, "http://") + "\r\n" +
		"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + base64.StdEncoding.EncodeToString([]byte("0123456789abcdef")) + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n" +
		"Content-Length: " + strconv.Itoa(len(body)) + "\r\n\r\n" + body
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatal(err)
	}

	// Read the handshake response.
	buf := make([]byte, 0, 1024)
	tmp := make([]byte, 1)
	for !strings.Contains(string(buf), "\r\n\r\n") {
		n, err := conn.Read(tmp)
		if err != nil {
			t.Fatalf("reading handshake: %v (got %q)", err, buf)
		}
		buf = append(buf, tmp[:n]...)
	}
	resp := string(buf)
	if !strings.Contains(resp, "101") {
		t.Fatalf("upgrade refused: %s", resp)
	}

	// The connection must stay usable: a presence frame arrives. Previously the
	// body bytes desynchronised the stream and it closed with 1008 instead.
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	got := ""
	for {
		n, err := conn.Read(tmp)
		if err != nil {
			t.Fatalf("connection died after the upgrade: %v (read so far %q)", err, got)
		}
		got += string(tmp[:n])
		if strings.Contains(got, "presence") {
			return // survived: the body did not desynchronise the frame stream
		}
		if strings.Contains(got, "\x88") || len(got) > 4096 {
			t.Fatalf("connection closed instead of serving presence; got %q", got)
		}
	}
}

// The allowlist decides on a string it calls a host, so it has to BE a host.
// "https://evil.com@a.example.com" satisfied the wildcard-suffix test
// because hostOf split only on /?# and left the userinfo attached. No browser
// sends userinfo in Origin, so there is no live attack — but the decision was
// being made on a non-host, which is exactly the string that becomes
// exploitable when something else starts building these values.
func TestOriginAllowlistRejectsUserinfoAndJunk(t *testing.T) {
	// An allowlist wide enough that a userinfo trick would be visible if allowed.
	// Set through Config, not srv.cfg after New: reapLoop reads that struct.
	cfg := testConfig()
	cfg.AllowedOrigins = []string{"https://*.example.com"}
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	for _, origin := range []string{
		"https://evil.com@a.example.com",
		"https://example.com@evil.com",
		"https://a\\b.example.com",
		"https://a b.example.com",
		"https://example.com/",
		"https://example.com.evil.tld",
		"https://notexample.com",
	} {
		req, _ := http.NewRequest("POST", ts.URL+"/api/rooms", strings.NewReader(`{"files":[{"name":"a.bin","size":1}]}`))
		req.Header.Set("Origin", origin)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("origin %q was allowed (ACAO %q)", origin, got)
		}
	}
	// A real subdomain still works.
	req, _ := http.NewRequest("POST", ts.URL+"/api/rooms", strings.NewReader(`{"files":[{"name":"a.bin","size":1}]}`))
	req.Header.Set("Origin", "https://app.example.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://app.example.com" {
		t.Errorf("a legitimate subdomain was rejected: ACAO = %q", got)
	}
}

// docs/CONFIG.md states bare `http://localhost` is deliberately not on the
// allowlist — on a desktop it is whatever dev server happens to be running, and
// permitting it hands room creation to any unrelated local page. The wildcard
// entry compared only the host part, so the no-port origin matched and was
// reflected. The code now matches the documented intent.
func TestBareLocalhostOriginIsNotAllowed(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	for _, origin := range []string{"http://localhost", "http://localhost:8090", "http://127.0.0.1:5173"} {
		req, _ := http.NewRequest("POST", ts.URL+"/api/rooms", strings.NewReader(`{"files":[{"name":"a.bin","size":1}]}`))
		req.Header.Set("Origin", origin)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		got := resp.Header.Get("Access-Control-Allow-Origin")
		if origin == "http://localhost" {
			if got != "" {
				t.Errorf("bare http://localhost was allowed (ACAO %q), but docs/CONFIG.md says it is excluded", got)
			}
			continue
		}
		if got != origin {
			t.Errorf("dev origin %s: ACAO = %q, want it echoed back", origin, got)
		}
	}
}

// A frozen mobile tab must be able to rejoin its OWN room.
//
// The mobile freeze bug has two halves. The first (a backgrounded tab's socket
// dies, the receiver is told the sender is offline) was fixed client-side. The
// second was here and it was created by TestPeerIDIsExclusive's rule: the server
// still holds the dead entry for up to SIGNAL_PING, so the reconnect that
// arrives first is refused as a duplicate — with 4400 — and the sender can never
// come back. Reproduced against production, the reconnect closed with
// 4400 "duplicate_sender" and the mobile fix was silently a no-op.
//
// Two things must hold here: the reconnect is accepted, and the socket it
// displaced is terminated by the server (bye), so the id is served by exactly
// one connection. Asserting only "the upgrade succeeded" would pass with two
// sockets racing for one routing slot, which is the abuse case the exclusivity
// rule exists for.
func TestSenderReconnectAfterFrozenSocket(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	id := createRoom(t, ts.URL)

	first := dialWS(t, ts.URL, id, "role=sender&peer=sender")
	defer first.Close()
	_ = first.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, _ = first.ReadMessage() // presence

	// The writer pump has PROVEN the socket gone (a write failed). This is the
	// state a backgrounded tab's connection is in for up to one ping interval.
	srv.store.MarkDead(id, "sender", srv.store.PeerSendChannel(id, "sender"))

	second, err := wsDial(ts.URL, id, "role=sender&peer=sender")
	if err != nil {
		t.Fatalf("reconnect refused at handshake: %v", err)
	}
	defer second.Close()

	// The displaced socket must be told bye and hung up, not left racing.
	_ = first.SetReadDeadline(time.Now().Add(3 * time.Second))
	deadline := time.Now().Add(3 * time.Second)
	gotBye := false
	for time.Now().Before(deadline) {
		op, payload, err := first.ReadMessage()
		if err != nil {
			break // closed: acceptable, as long as a bye came first
		}
		if op == ws.OpText && bytes.Contains(payload, []byte(`"bye"`)) {
			gotBye = true
			break
		}
	}
	if !gotBye {
		t.Fatal("the displaced socket got no bye — two connections now share one id")
	}

	// And the sender is announced online again.
	snap, ok := srv.store.SnapshotOf(id)
	if !ok || !snap.SenderOnline {
		t.Fatalf("senderOnline = %v, want true after the reconnect", snap.SenderOnline)
	}
	if n := srv.store.PeerCount(id); n != 1 {
		t.Fatalf("peer count %d, want 1 — the displaced peer was not removed", n)
	}
}

// The displaced socket's handler unwinding late must not unregister the sender
// that replaced it. Without the identity check this sequence reproduced the
// original symptom in reverse: online for a moment, then offline again.
func TestDisplacedSocketLeaveKeepsReconnectAlive(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	id := createRoom(t, ts.URL)

	first := dialWS(t, ts.URL, id, "role=sender&peer=sender")
	_ = first.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, _ = first.ReadMessage()
	srv.store.MarkDead(id, "sender", srv.store.PeerSendChannel(id, "sender"))

	second := dialWS(t, ts.URL, id, "role=sender&peer=sender")
	defer second.Close()
	_ = second.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, _ = second.ReadMessage()

	// Let the displaced connection's server-side handler run its whole teardown.
	first.Close()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if snap, ok := srv.store.SnapshotOf(id); ok && !snap.SenderOnline && srv.store.PeerCount(id) == 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	// Give the stale Leave time to land.
	time.Sleep(200 * time.Millisecond)

	snap, ok := srv.store.SnapshotOf(id)
	if !ok {
		t.Fatal("room gone")
	}
	if !snap.SenderOnline {
		t.Fatal("the displaced socket's Leave cleared the sender slot — the reconnect was undone")
	}
	if n := srv.store.PeerCount(id); n != 1 {
		t.Fatalf("peer count %d, want 1", n)
	}
}

// A receiver that reloads gets a new peer id, but one that merely loses its
// socket (in-app browser backgrounded) reconnects with the same id. The
// allowance must be symmetric across roles, not a sender-only concession.
func TestReceiverReconnectAfterFrozenSocket(t *testing.T) {
	srv := mustServer(t, testConfig())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	id := createRoom(t, ts.URL)

	rx := dialWS(t, ts.URL, id, "role=receiver&peer=rx-1")
	defer rx.Close()
	_ = rx.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, _ = rx.ReadMessage()

	srv.store.MarkDead(id, "rx-1", srv.store.PeerSendChannel(id, "rx-1"))
	if again, err := wsDial(ts.URL, id, "role=receiver&peer=rx-1"); err != nil {
		t.Fatalf("receiver reconnect refused: %v", err)
	} else {
		defer again.Close()
	}
	if n := srv.store.PeerCount(id); n != 1 {
		t.Fatalf("peer count %d, want 1", n)
	}
}

// failingWriter fails every write, standing in for a socket the OS killed.
type failingWriter struct{ closed bool }

func (f *failingWriter) WriteMessage(byte, []byte) error  { f.closed = true; return io.ErrClosedPipe }
func (f *failingWriter) WriteControl(byte, []byte) error  { f.closed = true; return io.ErrClosedPipe }
func (f *failingWriter) SetWriteDeadline(time.Time) error { return nil }
func (f *failingWriter) Close() error                     { f.closed = true; return nil }

// The writer pump's MarkDead is the load-bearing half of the mobile reconnect
// and was untested: on a real httptest connection the READER always notices a
// break first, so the branch could not be reached. Deleting it left every test
// green and the fix inert — verified by mutation. These drive the pump directly.
func TestWriteFailureMarksPeerDead(t *testing.T) {
	for _, tc := range []struct {
		name  string
		feed  func(chan []byte)
		after string
	}{
		{"a queued frame fails to write", func(ch chan []byte) { ch <- []byte(`{}`) }, "write"},
		{"the keepalive ping fails", func(chan []byte) {}, "ping"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// PingInterval through Config, not srv.cfg after New: reapLoop is
			// already reading it.
			cfg := testConfig()
			cfg.PingInterval = 20 * time.Millisecond
			srv := mustServer(t, cfg)
			id := srv.store.Create(nil, false).ID
			// The pump reports a dead socket BY the channel it owns, so the
			// channel it is handed must be the one registered — otherwise the
			// identity check (correctly) treats it as a stranger's socket.
			send := make(chan []byte, 8)
			srv.store.Join(id, "sender", "sender", send)
			w := &failingWriter{}
			done := make(chan struct{})
			go func() { defer close(done); srv.writePump(w, send, "sender", id) }()
			tc.feed(send)
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("pump did not return after a write failure")
			}
			// Observable proof: a reconnect now displaces the dead entry instead
			// of being refused as a duplicate. This is the whole point.
			if _, _, err := srv.store.Join(id, "sender", "sender", make(chan []byte, 8)); err != nil {
				t.Fatalf("reconnect after %s refused (%v) — the peer was never marked dead", tc.after, err)
			}
		})
	}
}

// TURN minting must spend rate-limit budget even for unknown rooms. The old
// order answered 404 before consulting the limiter, so walking the room space
// was free while callers holding a valid ID paid — the limit bound exactly the
// wrong population.
func TestTURNRateLimitsUnknownRooms(t *testing.T) {
	cfg := testConfig()
	cfg.RateTurnPerMin = 3
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	throttled := false
	for i := 0; i < 10; i++ {
		resp, err := http.Get(ts.URL + "/api/rooms/xxxxxxxxxx/turn")
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusTooManyRequests {
			throttled = true
			if got := resp.Header.Get("Retry-After"); got == "" {
				t.Error("429 without Retry-After")
			}
		}
	}
	if !throttled {
		t.Error("unknown-room TURN probes never throttled: enumeration bypasses the rate limit")
	}
}

// DELETE fans out (bye broadcast + peer closes), so it shares the lifecycle
// bucket with creation. Unbounded, any holder of a room ID — and the ID space
// is probed via /api/nearby — could drive delete work forever.
func TestDeleteIsRateLimited(t *testing.T) {
	cfg := testConfig()
	cfg.RateCreatePerMin = 3
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	throttled := false
	for i := 0; i < 10; i++ {
		req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/rooms/xxxxxxxxxx", nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusTooManyRequests {
			throttled = true
		}
	}
	if !throttled {
		t.Error("DELETE never throttled: unbounded fan-out per request")
	}
}

// Room JSON carries attacker-chosen filenames; the ID rides in the URL. A
// cached copy in a shared proxy is a leak of both, so API answers must not be
// stored.
func TestAPIResponsesAreNoStore(t *testing.T) {
	cfg := testConfig()
	cfg.RateCreatePerMin = 1000
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/rooms", "application/json",
		strings.NewReader(`{"files":[{"name":"a.bin","size":1}]}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("POST /api/rooms Cache-Control = %q, want no-store", got)
	}
	var body struct {
		ID string `json:"id"`
	}
	// Re-create via the decoded ID is unnecessary here; fetch the room back
	// through a fresh create to also cover the GET path.
	resp2, err := http.Post(ts.URL+"/api/rooms", "application/json",
		strings.NewReader(`{"files":[{"name":"b.bin","size":1}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if err := json.NewDecoder(resp2.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	g, err := http.Get(ts.URL + "/api/rooms/" + body.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer g.Body.Close()
	if got := g.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("GET /api/rooms/{id} Cache-Control = %q, want no-store", got)
	}
	h, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer h.Body.Close()
	if got := h.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("GET /healthz Cache-Control = %q, want no-store", got)
	}
}

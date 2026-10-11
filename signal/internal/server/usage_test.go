package server

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// usageServer builds a Server with optional config tweaks and a live test server.
func usageServer(t *testing.T, tweak func(*Config)) (*Server, *httptest.Server) {
	t.Helper()
	cfg := testConfig()
	if tweak != nil {
		tweak(&cfg)
	}
	srv := mustServer(t, cfg)
	ts := httptest.NewServer(srv.Handler())
	// Without this every test in this file leaked a listener and its accept
	// goroutine — 7 tests, ~14 goroutines per `go test ./...` run. The sibling
	// helpers (seo_test.go, static_test.go) register this cleanup, so it was an
	// isolated oversight rather than the house style.
	t.Cleanup(ts.Close)
	return srv, ts
}

// The endpoint must never be able to break a transfer, so it answers 204 for
// every input including nonsense. A non-204 here would be a new way for
// someone's download to look broken.
func TestUsageAlwaysAnswersNoContent(t *testing.T) {
	_, ts := usageServer(t, nil)
	for _, body := range []string{
		`{"n":1}`, `{"n":0}`, `{"n":-5}`, `{"n":999999}`,
		`not json at all`, `{"n":"lots"}`, `{}`, ``,
	} {
		if code, _ := postJSON(t, ts.URL+"/api/usage", "", body); code != 204 {
			t.Fatalf("body %q -> %d, want 204 for every input", body, code)
		}
	}
}

// The whole point: +1 per successfully received file, and nothing else counts.
func TestUsageCountsOnlyPlausibleDeltas(t *testing.T) {
	srv, ts := usageServer(t, nil)
	post := func(body string) {
		if code, _ := postJSON(t, ts.URL+"/api/usage", "", body); code != 204 {
			t.Fatalf("post %q = %d", body, code)
		}
	}
	post(`{"n":1}`)
	post(`{"n":1}`)
	post(`{"n":3}`)  // a batched flush of three completed files
	post(`{"n":0}`)  // dropped
	post(`{"n":-2}`) // dropped: a success count cannot go down
	post(`{"n":1000001}`)
	post(`garbage`)

	if got := srv.usageOK.Load(); got != 5 {
		t.Fatalf("usageOK = %d, want 5 (1+1+3; zero, negative, absurd and garbage all dropped)", got)
	}
}

// Persistence is the reason the count is worth having: it must survive a restart.
func TestUsageSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.json")

	srv1, ts1 := usageServer(t, func(c *Config) { c.UsageFile = path })
	postJSON(t, ts1.URL+"/api/usage", "", `{"n":7}`)
	if got := srv1.usageOK.Load(); got != 7 {
		t.Fatalf("pre-flush = %d, want 7", got)
	}
	if err := srv1.flushUsage(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("no state file after flush: %v", err)
	}

	// A brand new server over the same file, as after a restart.
	srv2, _ := usageServer(t, func(c *Config) { c.UsageFile = path })
	if got := srv2.usageOK.Load(); got != 7 {
		t.Fatalf("after restart = %d, want 7", got)
	}
}

// The file holds one integer; it must not be readable by other accounts.
func TestUsageStateFileIsNotWorldReadable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.json")
	srv, _ := usageServer(t, func(c *Config) { c.UsageFile = path })
	// Mark dirty explicitly: the counter is set directly here rather than
	// through the handler, and flushUsage is supposed to skip a write when
	// nothing changed since the last one (covered by TestUsageFlushSkipsWhenUnchanged).
	srv.usageOK.Store(3)
	srv.usageDirty.Store(1)
	if err := srv.flushUsage(); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm&0o077 != 0 {
		t.Fatalf("perms = %o, want no group/other access", perm)
	}
	b, _ := os.ReadFile(path)
	var st struct {
		OK int64 `json:"ok"`
	}
	if err := json.Unmarshal(b, &st); err != nil || st.OK != 3 {
		t.Fatalf("state = %s (%+v)", b, st)
	}
}

// Nothing is written when the count did not change, so an idle server does not
// keep touching the disk.
func TestUsageFlushSkipsWhenUnchanged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.json")
	srv, _ := usageServer(t, func(c *Config) { c.UsageFile = path })
	if err := srv.flushUsage(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("flush with no change and no prior state created a file")
	}
}

// An unreadable state file must not stop the service; the count just starts over.
func TestUsageBadStateFileIsNotFatal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.json")
	if err := os.WriteFile(path, []byte("{{{ not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	srv, _ := usageServer(t, func(c *Config) { c.UsageFile = path })
	if got := srv.usageOK.Load(); got != 0 {
		t.Fatalf("corrupt state file gave %d, want 0", got)
	}
}

// A public counter is a free amplification target, so it is rate limited. The
// limiter is replaced with a zero-capacity one to test the path directly rather
// than by sending usagePerMin+ requests.
func TestUsageIsRateLimited(t *testing.T) {
	// One token, then dry. Injected through Config rather than by assigning
	// srv.usageLimit after New: New starts reapLoop, which reads that field
	// every tick, so swapping it underneath was a data race (`go test -race`).
	srv, ts := usageServer(t, func(c *Config) { c.RateUsagePerMin = 1 })

	postJSON(t, ts.URL+"/api/usage", "", `{"n":1}`)
	postJSON(t, ts.URL+"/api/usage", "", `{"n":1}`)
	if got := srv.usageOK.Load(); got != 1 {
		t.Fatalf("usageOK = %d, want 1 (the second request must be dropped)", got)
	}
}

package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func metricsSrv(t *testing.T, pw string) (*httptest.Server, *Server) {
	t.Helper()
	cfg := testConfig()
	cfg.AdminToken = "op-secret"
	cfg.MetricsPassword = pw
	srv := mustServer(t, cfg)
	return httptest.NewServer(srv.Handler()), srv
}

func get(t *testing.T, url string, hdr map[string]string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

// Unset METRICS_PASSWORD must leave the old behaviour exactly intact: a browser
// gets a bare 401, not a login form, so the surface looks unchanged to anything
// probing it.
func TestMetricsNoPasswordUnchanged(t *testing.T) {
	ts, _ := metricsSrv(t, "")
	code, body := get(t, ts.URL+"/metrics", map[string]string{"Accept": "text/html"})
	if code != 401 {
		t.Fatalf("browser GET = %d, want 401 (unchanged when no password set)", code)
	}
	if strings.Contains(body, "password") {
		t.Fatal("login form leaked when METRICS_PASSWORD is unset")
	}
	// The bearer token still works, so scripts are unaffected.
	if code, body := get(t, ts.URL+"/metrics", map[string]string{"Authorization": "Bearer op-secret"}); code != 200 ||
		!strings.Contains(body, "files_completed") {
		t.Fatalf("bearer = %d %q", code, body[:min(60, len(body))])
	}
}

// With a password set, a browser gets the form and the metrics stay gated.
func TestMetricsPasswordGate(t *testing.T) {
	ts, _ := metricsSrv(t, "hunter2")

	code, body := get(t, ts.URL+"/metrics", map[string]string{"Accept": "text/html"})
	if code != 200 || !strings.Contains(body, "X-Metrics-Password") {
		t.Fatalf("browser GET = %d, want the login page", code)
	}
	// The form must never embed the secret.
	if strings.Contains(body, "hunter2") {
		t.Fatal("password appears in the served page")
	}
	// Right password, sent as a header (never a query param).
	if code, body := get(t, ts.URL+"/metrics", map[string]string{
		"X-Metrics-Password": "hunter2", "Accept": "text/plain",
	}); code != 200 || !strings.Contains(body, "files_completed") {
		t.Fatalf("correct password = %d", code)
	}
	// Wrong password, and it must not become an oracle: identical response.
	if code, _ := get(t, ts.URL+"/metrics", map[string]string{
		"X-Metrics-Password": "wrong", "Accept": "text/plain",
	}); code != 401 {
		t.Fatalf("wrong password = %d, want 401", code)
	}
	// A query parameter must NOT work — that is how passwords end up in history
	// and access logs.
	if code, _ := get(t, ts.URL+"/metrics?password=hunter2", nil); code == 200 {
		t.Fatal("password accepted as a query parameter")
	}
}

// A public endpoint with a password is a brute-force target, so attempts are
// limited per client IP.
func TestMetricsPasswordIsRateLimited(t *testing.T) {
	ts, srv := metricsSrv(t, "hunter2")
	srv.metricsLimit = NewLimiter(2, time.Minute) // 2 tries, then dry
	hit := 0
	for i := 0; i < 6; i++ {
		if code, _ := get(t, ts.URL+"/metrics", map[string]string{
			"X-Metrics-Password": "wrong", "Accept": "text/plain",
		}); code == 401 {
			hit++
		}
	}
	// The limiter is consulted, so a correct password is refused once the
	// attempts are spent. If it were not wired, this would be 200 every time.
	if code, _ := get(t, ts.URL+"/metrics", map[string]string{
		"X-Metrics-Password": "hunter2", "Accept": "text/plain",
	}); code == 200 {
		t.Fatalf("brute force was never limited (correct password still accepted after %d failures)", hit)
	}
}

// The bearer token must keep working alongside the password: it is the script
// path (metrics.sh, Prometheus) and must not regress.
func TestMetricsBearerStillWorksWithPasswordSet(t *testing.T) {
	ts, _ := metricsSrv(t, "hunter2")
	if code, body := get(t, ts.URL+"/metrics", map[string]string{"Authorization": "Bearer op-secret"}); code != 200 ||
		!strings.Contains(body, "files_completed") {
		t.Fatalf("bearer with password configured = %d", code)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

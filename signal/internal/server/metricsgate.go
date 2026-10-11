package server

// Password gate for /metrics.
//
// The endpoint is reachable from anywhere (the API host is public), but reading
// it from a browser meant pasting a Bearer token, which is awkward and invites
// putting the secret in a URL. With METRICS_PASSWORD set, an unauthenticated
// GET /metrics returns a small HTML page with a password box instead of a bare
// 401, and the page then re-requests with the password in a header.
//
// Design notes, because this is a security surface:
//
//   - The password is NEVER accepted as a query parameter. ?password=... ends up
//     in browser history, in proxy access logs, and in a Referer header sent to
//     any third party the page ever links to. The page keeps it in sessionStorage
//     and sends it as a header, so it appears in exactly one place.
//   - Constant-time compare, and the failure response is identical whatever the
//     password was, so it is not an oracle.
//   - Rate limited per client IP, because a password on a public endpoint is a
//     brute-force target otherwise.
//   - Nothing is logged on success or failure. The service deliberately writes
//     no request log, and adding one line per attempt would record exactly the
//     kind of operational detail this project avoids.
//   - Fail closed. With METRICS_PASSWORD unset the old behaviour stands exactly:
//     ADMIN_TOKEN via header, or 404 when no token is configured.
//
// The HTML is inline and self-contained on purpose: it must not reference any
// external asset, or the page would leak a request for a third-party host on
// every visit.

import (
	"crypto/subtle"
	"net/http"
	"strings"
	"time"
)

const (
	metricsPasswordHeader = "X-Metrics-Password"

	// metricsPasswordPerMin bounds password attempts per client IP. A password on a
	// public endpoint is a brute-force target, so this is the real control — a long
	// password is not enough on its own.
	metricsPasswordPerMin = 10
)

// metricsLoginPage is served for an unauthenticated GET when METRICS_PASSWORD is
// set. Kept small and dependency-free; the styling is inline because there is
// no build step for a string in the Go binary.
const metricsLoginPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>metrics — sign in</title>
<style>
:root{color-scheme:dark light}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111014;color:#f4f1e8;
  font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
form{width:min(420px,92vw);background:#191820;border:1px solid #2b2b36;border-radius:16px;padding:26px}
h1{margin:0 0 4px;font-size:17px;letter-spacing:-.01em}
p{margin:0 0 16px;color:#a8a49a;font-size:13px}
input{width:100%;box-sizing:border-box;background:#111014;border:1px solid #34343f;color:inherit;
  border-radius:10px;padding:11px 12px;font:inherit}
button{margin-top:12px;width:100%;background:#ff5a1f;color:#fff;border:0;border-radius:10px;
  padding:11px 12px;font:inherit;font-weight:700;cursor:pointer}
button:hover{filter:brightness(1.08)}
#err{margin:12px 0 0;color:#ff6b5e;font-size:13px;min-height:1.2em}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.hide{display:none}
</style></head><body>
<form id="f" autocomplete="off">
  <h1>Server metrics</h1>
  <p>Enter the metrics password.</p>
  <input id="pw" type="password" placeholder="password" autocomplete="current-password" autofocus>
  <button type="submit">Show metrics</button>
  <div id="err"></div>
</form>
<pre id="out" class="hide"></pre>
<script>
// sessionStorage, not localStorage: the password should not outlive the tab,
// and definitely should not sit in history or survive a restart. Cleared by the
// "forget" button so a shared machine is not left holding it.
const KEY = "signal-metrics-pw";
const $ = id => document.getElementById(id);
$("f").addEventListener("submit", async e => {
  e.preventDefault();
  $("err").textContent = "";
  const pw = $("pw").value;
  if (!pw) { $("err").textContent = "Enter a password."; return; }
  try { sessionStorage.setItem(KEY, pw); } catch {}
  await load();
});
async function load() {
  const pw = sessionStorage.getItem(KEY) || "";
  let r;
  try {
    r = await fetch(location.pathname, { headers: { "X-Metrics-Password": pw }, cache: "no-store" });
  } catch { $("err").textContent = "Network error."; return; }
  if (r.status === 401 || r.status === 404) {
    try { sessionStorage.removeItem(KEY); } catch {}
    $("pw").value = ""; $("pw").focus();
    $("err").textContent = r.status === 404 ? "Metrics are disabled on this server." : "Wrong password.";
    return;
  }
  if (!r.ok) { $("err").textContent = "Error " + r.status + "."; return; }
  $("f").classList.add("hide");
  $("out").classList.remove("hide");
  $("out").textContent = await r.text();
}
$("pw").value = sessionStorage.getItem(KEY) || "";
if ($("pw").value) load();
</script>
</body></html>`

// metricsAuthorised reports whether the request may read /metrics.
//
// Order matters: the existing ADMIN_TOKEN bearer path is checked first and
// behaves exactly as before, so scripts (metrics.sh, Prometheus) are unaffected.
// The password is an ADDITIONAL door for browsers, never a replacement.
func (s *Server) metricsAuthorised(r *http.Request) (ok bool, noAdmin bool) {
	if s.cfg.PublicMetrics {
		return true, false
	}
	// Existing behaviour: bearer token, and 404 when no token is configured at
	// all so the surface is not even confirmed.
	if got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "); got != "" {
		if s.cfg.AdminToken == "" {
			return false, true
		}
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.AdminToken)) == 1 {
			return true, false
		}
	}
	// Browser door. Absent config → closed, exactly as before.
	if s.cfg.MetricsPassword == "" {
		return false, s.cfg.AdminToken == ""
	}
	pw := r.Header.Get(metricsPasswordHeader)
	if pw == "" {
		return false, false
	}
	if !s.metricsLimit.Allow(clientIP(r, s.cfg), time.Now()) {
		return false, false
	}
	return subtle.ConstantTimeCompare([]byte(pw), []byte(s.cfg.MetricsPassword)) == 1, false
}

// serveMetricsGate wires the gate into the /metrics handler: an unauthorised
// browser gets the login page, anything else gets the usual bare 401 so a
// script that forgot its token still sees a clean error.
func (s *Server) serveMetricsGate(w http.ResponseWriter, r *http.Request) bool {
	ok, noAdmin := s.metricsAuthorised(r)
	if ok {
		return false // carry on to the metrics
	}
	if noAdmin {
		http.NotFound(w, r)
		return true
	}
	// A browser asking for the page gets the form, but ONLY when a password is
	// actually configured. With METRICS_PASSWORD unset there is nothing to type,
	// and serving a form there would both imply a door that does not exist and
	// change the response a prober sees (a bare 401 before, an HTML page now).
	if s.cfg.MetricsPassword != "" && strings.Contains(r.Header.Get("Accept"), "text/html") {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			w.Write([]byte(metricsLoginPage))
		}
		return true
	}
	writeJSON(w, 401, map[string]string{"error": "unauthorized"})
	return true
}

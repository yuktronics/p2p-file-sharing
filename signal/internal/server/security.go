package server

import (
	"errors"
	"log"
	"net"
	"net/http"
	"strings"

	"signal/internal/rooms"
)

// ── Security posture, in one place ──────────────────────────────────────────
//
// Defaults are fail-closed: anything that could be used as an abuse amplifier
// (the dev loopback harness, Prometheus counters) is off unless an operator
// turns it on, and anything that could leak a room secret through a browser
// (Referer to a third party, framing, injected script) is blocked outright.
// See docs/CONFIG.md for the env vars that switch each of these.

// maxBodyBytes caps every JSON request body. Without it a POST can stream
// unbounded data into json.Decode and take the process out with it; the largest
// legitimate body is 20 file entries (~8 KB).
const maxBodyBytes = 16 << 10 // 16 KB

// maxPeersPerRoom bounds one room's fan-out. Every peer multiplies the work of
// every frame the sender routes, so an unbounded peer count is an amplification
// primitive even with the per-IP create limit.
const maxPeersPerRoom = 32

// securityHeaders is applied to every response. The room id is a bearer-ish
// secret (it is in every share link and QR), so a Referer leak to any third
// party would hand over a live transfer — hence no-referrer, not just
// same-origin.
func (s *Server) securityHeaders(h http.Header, r *http.Request) {
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Permissions-Policy", "geolocation=(), microphone=(), camera=(), interest-cohort=()")
	// The UI is entirely self-hosted: no CDN, no analytics, no inline JS event
	// handlers. The only inline scripts are the page bootstraps and the inlined
	// stylesheets the first-visit budget produces, hence 'unsafe-inline' for
	// style and the nonce-free bootstrap allowance.
	h.Set("Content-Security-Policy", strings.Join([]string{
		"default-src 'self'",
		"script-src 'self' 'unsafe-inline'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"font-src 'self'",
		"connect-src *", // signalling/ICE reach the configured backend origin
		"frame-ancestors 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"object-src 'none'",
	}, "; "))
	// Only meaningful over TLS; a proxy normally sets it, but an unwrapped
	// deployment should not be told the connection is secure when it isn't.
	if rfcStrictTransport(r) {
		h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
	}
}

func rfcStrictTransport(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// originAllowed implements the CORS allowlist. Same-origin is always allowed
// (a same-origin POST still carries Origin in some browsers). Otherwise the
// configured list decides, where an entry may be an exact origin or a wildcard
// subdomain form ("https://*.pages.dev").
func originAllowed(origin string, r *http.Request, allowed []string) bool {
	if origin == "" {
		return false // not a cross-origin request
	}
	if sameOrigin(origin, r) {
		return true
	}
	oHost, oScheme := hostOf(origin)
	if oHost == "" {
		return false // "null" or a path: not an origin we can reason about
	}
	for _, a := range allowed {
		a = strings.TrimSpace(a)
		if a == "" {
			continue
		}
		if a == "*" {
			return true
		}
		aHost, aScheme := hostOf(a)
		if aHost == "" {
			// An entry that parses to nothing can never match, so it silently
			// deadens its own rule — and the symptom is the quiet failure mode
			// docs/CONFIG.md warns about for CORS mistakes: every browser request
			// gets 403, the app says "server unreachable", and nothing in the log
			// explains why. Say it out loud at startup instead.
			log.Printf("signal: ignoring unparseable allowed origin %q (no scheme://host)", a)
			continue
		}
		if aScheme != "" && oScheme != "" && !strings.EqualFold(aScheme, oScheme) {
			continue // http must not satisfy an https-only entry
		}
		if strings.HasPrefix(aHost, "*.") {
			// "*.example.com" matches "a.example.com" and "a.b.example.com"
			// but NOT "example.com" and NOT "example.com.evil.tld". Requiring a
			// non-empty label prefix and comparing the suffix exactly rules out
			// both the parent domain and the lookalike suffix bypass.
			suffix := aHost[1:] // ".example.com"
			if !strings.HasSuffix(oHost, suffix) {
				continue
			}
			label := oHost[:len(oHost)-len(suffix)]
			if label != "" && !strings.HasPrefix(label, ".") && !strings.ContainsAny(label, ":/") {
				return true
			}
			continue
		}
		// "host:*" matches any port on that host — for dev servers on a random
		// port. It never widens the host itself, but the ORIGIN MUST CARRY A
		// PORT. The previous version compared only the host part, so
		// "http://localhost:*" also matched the bare "http://localhost" origin —
		// which docs/CONFIG.md states is deliberately excluded, because on a
		// desktop it is whatever dev server happens to be listening and permitting
		// it hands room creation to any unrelated local page. Requiring a port
		// makes the code match the documented intent.
		if strings.HasSuffix(aHost, ":*") {
			base := strings.TrimSuffix(aHost, ":*")
			oBase, oPort, hasPort := strings.Cut(oHost, ":")
			if base != "" && hasPort && oPort != "" && strings.EqualFold(oBase, base) {
				return true
			}
			continue
		}
		if aHost == oHost {
			return true
		}
	}
	return false
}

// hostOf splits an origin into (host[:port], scheme). The host is empty for
// anything that is not an absolute scheme://host origin, so "null" (which
// browsers send from sandboxed iframes and file:// pages), a bare hostname and a
// path can never match a list entry. Any well-formed scheme is accepted;
// matching is still exact, and the list is operator-controlled.
func hostOf(origin string) (host, scheme string) {
	o := strings.TrimSpace(origin)
	i := strings.Index(o, "://")
	if i <= 0 {
		return "", ""
	}
	scheme = strings.ToLower(o[:i])
	// Reject anything that is not a well-formed scheme.
	for j, c := range scheme {
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '+', c == '-', c == '.':
		case j == 0:
			return "", ""
		default:
			return "", ""
		}
	}
	o = o[i+3:]
	if j := strings.IndexAny(o, "/?#"); j >= 0 {
		o = o[:j]
	}
	// Reject an authority carrying userinfo, a backslash, or whitespace. An
	// allowlist entry like "https://*.example.com" would otherwise be
	// satisfied by "https://evil.com@a.example.com", because the suffix test
	// runs on what this function calls a host but is not one. No browser puts
	// userinfo in Origin (the header is scheme://host[:port]), so there is no
	// live attack — but the decision was being made on a string that is not a
	// host, which is the kind of thing that becomes exploitable later.
	if strings.ContainsAny(o, "@\\ \t\r\n") {
		return "", ""
	}
	if o == "" {
		return "", ""
	}
	return strings.ToLower(stripDefaultPort(o)), scheme
}

func stripDefaultPort(h string) string {
	if strings.HasSuffix(h, ":443") || strings.HasSuffix(h, ":80") {
		return h[:strings.LastIndexByte(h, ':')]
	}
	return h
}

// sameOrigin compares an Origin header against the request Host. The scheme is
// ignored on purpose (TLS is terminated upstream, so the app sees http) and
// the default port is normalised away.
func sameOrigin(origin string, r *http.Request) bool {
	oHost, _ := hostOf(origin)
	if oHost == "" {
		return false
	}
	return oHost == stripDefaultPort(strings.ToLower(r.Host))
}

// defaultAllowedOrigins is what an operator gets with no configuration: local
// development on any port, and Cloudflare Pages deploy/preview hostnames.
// Anything else must be listed explicitly. Note this is a *narrow* default — a
// self-hosted frontend on the user's own domain needs SIGNAL_ALLOWED_ORIGINS
// (see docs/CONFIG.md).
// docs/CONFIG.md states that bare `http://localhost` is deliberately not on the
// list, because on a desktop it is whatever dev server happens to be running and
// permitting it hands room creation to any unrelated local page. That claim was
// not true: the wildcard-port entry below compares only the host part, so
// `http://localhost` with no port matched and was reflected in
// Access-Control-Allow-Origin. The code now matches the documented intent — the
// port must be present for the loopback dev entries.
func defaultAllowedOrigins() []string {
	return []string{
		"https://localhost:*",
		"http://localhost:*",
		"http://127.0.0.1:*",
		"https://*.pages.dev",
		"http://*.localhost:*",
	}
}

// trustProxyHeader decides whether X-Forwarded-For may be believed. Trusting it
// unconditionally is the classic rate-limit bypass: anyone can set the header.
// So the remote peer itself must be a loopback or private address — i.e. a
// proxy on the same host or the same network — before the header is honoured.
func trustProxyHeader(enabled bool, remoteAddr string) bool {
	if !enabled {
		return false
	}
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

// capBody wraps r.Body so a huge or slow body cannot exhaust memory.
func capBody(w http.ResponseWriter, r *http.Request) {
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	}
}

// rejectIfOversized reports the 413 for bodies that hit the cap, so callers can
// answer with a proper status instead of a bare 400.
// The error is matched by TYPE, not by message. MaxBytesReader returns
// *http.MaxBytesError, so errors.Is is exact; matching on the string depended on
// the stdlib's wording and would silently stop answering 413 (returning a bare
// 400) if that wording ever changed.
func rejectIfOversized(err error) (int, bool) {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		return http.StatusRequestEntityTooLarge, true
	}
	return 0, false
}

// validFileMeta checks one file entry of a room manifest. The name is attacker
// controlled and ends up as a suggested download name on the receiver's device,
// so it must not carry path separators (a receiver writing into a chosen folder
// would otherwise be walked out of it), control characters, or the bidi/NUL
// tricks used to disguise an extension. Real files are unaffected: no browser
// hands out a name containing any of these.
func validFileMeta(f rooms.FileMeta) bool {
	if f.Name == "" || len(f.Name) > 255 || f.Size <= 0 || f.Size > 50<<30 {
		return false
	}
	name := f.Name
	// Reject "." and ".." and anything with a separator.
	if name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
		return false
	}
	for _, r := range name {
		// Control chars, NUL, DEL, and the bidi overrides / zero-width marks
		// that let "photo.jpg.exe" or "invoice.pdf‮gpj" masquerade as something else.
		if r < 0x20 || r == 0x7f || r == 0x200e || r == 0x200f || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) || r == 0xfeff {
			return false
		}
	}
	// A name that is only dots ("...", "…") is a traversal in disguise on some
	// filesystems.
	if strings.Trim(name, ".") == "" {
		return false
	}
	// Windows silently strips a trailing dot or space, so "photo.jpg." is stored
	// as "photo.jpg" while the receiver was shown "photo.jpg." — the same
	// display/store divergence as the bidi case above, and it is how
	// "report.pdf.exe." is made to look like a PDF.
	if strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") {
		return false
	}
	// Windows device names resolve to a device, not a file, so a save silently
	// discards the bytes: CON, PRN, AUX, NUL, COM1-9, LPT1-9. Check the stem
	// before the first dot, since "CON.txt" is the device too.
	if isWindowsDevice(stemBeforeExt(name)) {
		return false
	}
	// FileMeta.ID is assigned by the sender and is peer-controlled. It reaches
	// the receiver's DOM as a data-fid attribute that app.js interpolates into a
	// querySelector, so it must not be able to break out of that selector or
	// carry characters no legitimate client sends. See app.js rowBtn.
	if len(f.ID) > 64 {
		return false
	}
	for _, r := range f.ID {
		if r <= 0x20 || r == 0x7f || r == '"' || r == '\'' || r == '\\' || r == '<' || r == '>' || r == '=' {
			return false
		}
	}
	if len(f.Mime) > 128 {
		return false
	}
	return true
}

// stemBeforeExt returns the part of a filename before its first dot, lowercased
// without any trailing dot/space, which is what a filesystem actually resolves
// a device name from ("CON", "CON.txt", "con " all reach the CON device).
func stemBeforeExt(name string) string {
	if i := strings.IndexByte(name, '.'); i >= 0 {
		name = name[:i]
	}
	return strings.ToLower(strings.TrimRight(name, " ."))
}

// isWindowsDevice reports whether stem names a reserved Windows device.
func isWindowsDevice(stem string) bool {
	switch stem {
	case "con", "prn", "aux", "nul":
		return true
	}
	// COM1-COM9, LPT1-LPT9 (COM0/LPT0 are not reserved; COM¹ is, but that is
	// beyond what a receiver's download path needs to defend).
	if len(stem) == 4 && (strings.HasPrefix(stem, "com") || strings.HasPrefix(stem, "lpt")) {
		if c := stem[3]; c >= '1' && c <= '9' {
			return true
		}
	}
	return false
}

// validManifest validates a whole room manifest. Used by every path that can
// introduce a file list, so a name that Create rejects cannot reappear later.
func validManifest(files []rooms.FileMeta) bool {
	if len(files) > 20 {
		return false
	}
	for _, f := range files {
		if !validFileMeta(f) {
			return false
		}
	}
	return true
}

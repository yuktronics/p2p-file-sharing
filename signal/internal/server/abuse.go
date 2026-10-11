package server

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"signal/internal/rooms"
	"signal/internal/ws"
)

var validReasons = map[string]bool{
	"spam": true, "malware": true, "phishing": true, "csam": true, "other": true,
}

// checkAdmin enforces the operator bearer token. Empty ADMIN_TOKEN disables
// the admin surface entirely (503, not 401 — fail closed and explicit).
func (s *Server) checkAdmin(w http.ResponseWriter, r *http.Request) bool {
	if s.cfg.AdminToken == "" {
		writeJSON(w, 503, map[string]string{"error": "admin_disabled"})
		return false
	}
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.AdminToken)) != 1 {
		writeJSON(w, 401, map[string]string{"error": "unauthorized"})
		return false
	}
	return true
}

// POST /api/rooms/{id}/report {reason, contact?} — anyone (usually the receiver).
//
// A report is accepted even when the room no longer exists. This used to 404 on
// a missing room, which made the feature useless in practice: the moment a
// recipient has decided something was malicious, the sender has usually closed
// their tab, so the transfer — and the room — is gone by the time they report
// it. The operator can still act on the report text and the room id, and a
// still-live room additionally becomes an actionable tombstone.
//
// The abuse surface is bounded by the per-IP report limit and the capped
// report list, so accepting unknown ids does not open a cheap way to flood it.
func (s *Server) handleReport(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	_, live := s.store.Get(id)
	_, alreadyDisabled := s.store.Disabled(id)
	if !s.reportLimit.Allow(clientIP(r, s.cfg), time.Now()) {
		s.rateLimited.Add(1)
		w.Header().Set("Retry-After", "60")
		writeJSON(w, 429, map[string]string{"error": "rate_limited"})
		return
	}
	capBody(w, r)
	var body struct {
		Reason  string `json:"reason"`
		Contact string `json:"contact"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !validReasons[body.Reason] {
		if code, ok := rejectIfOversized(err); ok {
			writeJSON(w, code, map[string]string{"error": "body_too_large"})
			return
		}
		writeJSON(w, 400, map[string]string{"error": "bad_reason"})
		return
	}
	if len(body.Contact) > 120 {
		writeJSON(w, 400, map[string]string{"error": "bad_contact"})
		return
	}
	// The durable append is the whole point of REPORT_LOG, so its error decides the
	// status code. Dropping it answered 201 {"status":"received"} on a disk-full
	// or permission failure, telling the reporter it was filed while the report
	// existed only in the 500-entry memory ring — and vanished on restart. Now the
	// in-memory record still stands (the room is still disabled either way) but
	// the response and the metric say persistence failed, so the operator can see
	// it. The error itself is not logged: this service writes nothing to disk
	// that would record room ids.
	if err := s.store.AddReport(rooms.Report{
		RoomID: id, Reason: body.Reason, Contact: body.Contact,
		// Live: the room was still open, so the operator can disable it right
		// now and stop the transfer. Ended: the room had already closed, and the
		// report is the only remaining record that it happened at all.
		RoomLive: live,
		At:       time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		s.reportLogErrors.Add(1)
		if alreadyDisabled {
			writeJSON(w, 200, map[string]string{"status": "received", "note": "already_disabled", "persisted": "false"})
			return
		}
		// The room is disabled in memory either way, so the abuse is stopped —
		// but tell the caller the durable copy failed rather than confirming a
		// record that does not exist on disk.
		writeJSON(w, 503, map[string]string{"error": "report_not_persisted", "note": "the room was disabled but the report could not be written to the log"})
		return
	}
	if alreadyDisabled {
		// Still recorded above, but say plainly that no further action is needed
		// rather than returning an error the client renders as a failure.
		writeJSON(w, 200, map[string]string{"status": "received", "note": "already_disabled"})
		return
	}
	writeJSON(w, 201, map[string]string{"status": "received"})
}

// GET /api/admin/reports — operator inbox (newest last).
func (s *Server) handleAdminReports(w http.ResponseWriter, r *http.Request) {
	if !s.checkAdmin(w, r) {
		return
	}
	reports, durable := s.store.ListReports()
	writeJSON(w, 200, map[string]any{"reports": reports, "durable": durable})
}

// POST /api/admin/rooms/{id}/disable {reason} — kill now, tombstone for 451.
func (s *Server) handleAdminDisable(w http.ResponseWriter, r *http.Request) {
	if !s.checkAdmin(w, r) {
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	capBody(w, r)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Reason == "" || len(body.Reason) > 120 {
		writeJSON(w, 400, map[string]string{"error": "bad_reason"})
		return
	}
	id := r.PathValue("id")
	sends := s.store.Disable(id, body.Reason)
	if sends == nil {
		if _, dis := s.store.Disabled(id); dis {
			writeJSON(w, 200, map[string]string{"status": "already_disabled"})
			return
		}
		writeJSON(w, 404, map[string]string{"error": "not_found"})
		return
	}
	for _, ch := range sends {
		close(ch) // writers send bye + hang up
	}
	writeJSON(w, 200, map[string]string{"status": "disabled"})
}

// Close code for WS joins to disabled rooms (see WIRE-PROTOCOL.md).
const closeRoomDisabled = 4401

func closeDisabled(c *ws.Conn, reason string) {
	if reason == "" {
		reason = "room_disabled"
	}
	if len(reason) > 100 {
		reason = reason[:100]
	}
	c.CloseWith(closeRoomDisabled, reason)
}

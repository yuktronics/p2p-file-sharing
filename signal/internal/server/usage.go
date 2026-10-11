package server

// Anonymous success counter.
//
// One number: how many files completed successfully. Nothing else.
//
// "Completed" is defined on the client as a file that was written to disk AND
// whose sha256 matched — not merely requested, started, or partially received.
// The client increments exactly once per such file.
//
// No identifier of any kind is involved: no room id, no file name, no client IP,
// no user key, no per-event timestamp, no referrer. A single monotonic integer
// cannot identify anyone, which is why this is compatible with the product
// still routing file bytes peer-to-peer and storing nothing about transfers.
//
// Constraints, in priority order:
//
//  1. Never affect a transfer. The handler cannot reject a file, cannot report a
//     failure to the client, and does no disk work on the request path — a disk
//     write per completed file would put a filesystem sync in someone's
//     download. Persistence runs on a timer for the same reason.
//  2. Cheap. One atomic add and a 204; the timer writes at most once a minute.
//  3. Abuse-bounded. A public counter is a free amplification target, so it is
//     rate limited per client IP like every other POST, and the per-request
//     delta is capped so a hostile client cannot inflate it to absurdity.

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"
)

const (
	// usageMaxPerRequest bounds a single submission. The client batches a
	// session, so this is far above honest use.
	usageMaxPerRequest int64 = 1000

	// usagePerMin bounds submissions from one client IP. The client now reports each
	// completed file immediately and the batching happens here, so this has to
	// accommodate a burst of finished files. It also has to tolerate a shared
	// address: a household or office behind one NAT egress would otherwise spend
	// a single small budget, and a receiver whose count is silently dropped is a
	// worse outcome than a few wasted request slots. Still bounded, because a
	// public counter must not be a free amplifier.
	usagePerMin = 600

	// usageFlushInterval is how often the total is written to disk. Batching
	// means a burst of completed files costs one write, and a crash loses at
	// most a minute of counting rather than the whole total.
	usageFlushInterval = 60 * time.Second

	usageStateFileMode os.FileMode = 0o600
)

// handleUsage accepts an anonymous success delta and always answers 204.
//
// Errors are swallowed on purpose: a counter that surfaced a failure would add
// a new way for a transfer to look broken, and there is nothing a user could
// do about it.
func (s *Server) handleUsage(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusNoContent)

	if !s.usageLimit.Allow(clientIP(r, s.cfg), time.Now()) {
		return
	}
	capBody(w, r)
	var d struct {
		N int64 `json:"n"`
	}
	if err := json.NewDecoder(r.Body).Decode(&d); err != nil {
		return
	}
	// Dropped rather than clamped when nonsensical: a clamped value is one this
	// server invented, not one it measured.
	if d.N <= 0 || d.N > usageMaxPerRequest {
		return
	}
	s.usageOK.Add(d.N)
	s.usageDirty.Store(1)
}

// flushUsage writes the total if it changed. Temp file + rename, so a crash
// mid-write leaves the previous state rather than a truncated one.
func (s *Server) flushUsage() error {
	if s.usageFile == "" {
		return nil
	}
	if !s.usageDirty.CompareAndSwap(1, 0) {
		return nil // unchanged since the last flush
	}
	b, err := json.Marshal(struct {
		OK int64 `json:"ok"`
	}{OK: s.usageOK.Load()})
	if err != nil {
		return err
	}
	tmp := s.usageFile + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), usageStateFileMode); err != nil {
		s.usageDirty.Store(1) // retry next tick
		return err
	}
	if err := os.Rename(tmp, s.usageFile); err != nil {
		os.Remove(tmp)
		s.usageDirty.Store(1)
		return err
	}
	return nil
}

// startUsagePersist loads any saved total and runs the flush timer. An
// unreadable state file must not stop the service, so it only starts from zero.
func (s *Server) startUsagePersist() {
	if s.usageFile == "" {
		return // disabled: the counter still works, it just resets on restart
	}
	if b, err := os.ReadFile(s.usageFile); err == nil {
		var st struct {
			OK int64 `json:"ok"`
		}
		if json.Unmarshal(b, &st) == nil && st.OK >= 0 {
			s.usageOK.Store(st.OK)
		}
	}
	go func() {
		t := time.NewTicker(usageFlushInterval)
		defer t.Stop()
		for range t.C {
			if err := s.flushUsage(); err != nil {
				// No room id or file name exists in this error by construction,
				// so it cannot leak user content to the journal.
				log.Printf("usage flush: %v", err)
			}
		}
	}()
}

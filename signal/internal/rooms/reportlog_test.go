package rooms

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The point of the log: a report filed before a restart must still be there
// after one. Before this existed, every report died with the process, so the
// operator inbox was empty after any update or reboot.
func TestReportSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "reports.jsonl")

	first, err := OpenReportLog(path)
	if err != nil {
		t.Fatal(err)
	}
	s1 := NewStore(time.Minute)
	s1.SetReportLog(first)
	if err := s1.AddReport(Report{RoomID: "ROOM1", Reason: "malware", Contact: "a@b.c", At: "2026-01-01T00:00:00Z", RoomLive: true}); err != nil {
		t.Fatal(err)
	}

	// A brand new store, as after a restart. Nothing in memory carries over.
	second, err := OpenReportLog(path)
	if err != nil {
		t.Fatal(err)
	}
	s2 := NewStore(time.Minute)
	s2.SetReportLog(second)
	got, durable := s2.ListReports()
	if !durable {
		t.Error("a readable log reported itself as not durable")
	}
	if len(got) != 1 {
		t.Fatalf("after restart: %d reports, want 1", len(got))
	}
	if got[0].RoomID != "ROOM1" || got[0].Reason != "malware" || got[0].Contact != "a@b.c" || !got[0].RoomLive {
		t.Fatalf("report not intact: %+v", got[0])
	}
}

// The log is opened but never written until the first report, so a configured
// path leaves no artefact — otherwise a deployment would create an empty file
// that looks like "persistence is working" when nothing has been reported yet.
func TestReportLogNoFileUntilFirstAppend(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "reports.jsonl")
	rl, err := OpenReportLog(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("file created before any report was filed")
	}
	all, err := rl.All()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 0 {
		t.Fatalf("All on an empty log = %+v", all)
	}
}

// Reports carry whatever a reporter typed into the contact box, so the file must
// not be world-readable.
func TestReportLogIsNotWorldReadable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "reports.jsonl")
	rl, err := OpenReportLog(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := rl.Append(Report{RoomID: "ROOM1", Reason: "spam", At: "now"}); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm&0o077 != 0 {
		t.Fatalf("report log perms = %o, want no group/other access", perm)
	}
}

// One corrupt line must not hide the reports around it — that is precisely when
// the operator most needs to read them.
func TestReportLogSkipsCorruptLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "reports.jsonl")
	rl, err := OpenReportLog(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range []Report{
		{RoomID: "A", Reason: "spam", At: "1"},
		{RoomID: "B", Reason: "phishing", At: "2"},
		{RoomID: "C", Reason: "csam", At: "3"},
	} {
		if err := rl.Append(r); err != nil {
			t.Fatal(err)
		}
	}
	// Splice a truncated JSON line into the middle, the shape a crash mid-write
	// would leave.
	raw, _ := os.ReadFile(path)
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	corrupt := strings.Join([]string{lines[0], `{"room":"BROKEN`, lines[1], lines[2]}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(corrupt), 0o600); err != nil {
		t.Fatal(err)
	}

	all, err := rl.All()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 3 {
		t.Fatalf("got %d reports, want 3 (the corrupt line skipped): %+v", len(all), all)
	}
	for _, r := range all {
		if r.RoomID == "BROKEN" {
			t.Fatal("corrupt line was returned as a report")
		}
	}
}

// Unset path = the pre-existing in-memory behaviour, and no file anywhere.
func TestReportLogDisabledByDefault(t *testing.T) {
	rl, err := OpenReportLog("   ")
	if err != nil {
		t.Fatalf("blank path should not be an error: %v", err)
	}
	if rl != nil {
		t.Fatal("blank path should disable the log")
	}
	if rl.Path() != "" {
		t.Fatalf("Path on nil log = %q", rl.Path())
	}
	s := NewStore(time.Minute)
	if p := s.ReportLogPath(); p != "" {
		t.Fatalf("ReportLogPath with no log = %q", p)
	}
	if err := s.AddReport(Report{RoomID: "X", Reason: "spam", At: "1"}); err != nil {
		t.Fatal(err)
	}
	if got, durable := s.ListReports(); len(got) != 1 || !durable {
		t.Fatalf("memory fallback = %d reports, durable=%v", len(got), durable)
	}
}

// The file is a backstop, not unbounded growth: past the cap the oldest lines are
// dropped and the newest kept.
func TestReportLogRotatesWhenOversize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "reports.jsonl")
	rl, err := OpenReportLog(path)
	if err != nil {
		t.Fatal(err)
	}
	rl.maxBytes = 2048 // small enough to trip with a handful of reports
	for i := 0; i < 60; i++ {
		if err := rl.Append(Report{RoomID: "ROOM" + strings.Repeat("x", 40), Reason: "malware", At: "2026-01-01T00:00:00Z"}); err != nil {
			t.Fatal(err)
		}
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Size() > 4096 {
		t.Fatalf("log grew to %d bytes, rotation did not bound it", fi.Size())
	}
	all, err := rl.All()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) == 0 {
		t.Fatal("rotation emptied the log")
	}
	// The newest report must survive: rotation drops the OLDEST.
	last := all[len(all)-1]
	if !strings.HasPrefix(last.RoomID, "ROOM") {
		t.Fatalf("newest report mangled: %+v", last)
	}
}

// One unreadable line must not kill durable reporting. The scanner's line cap
// made readUnlocked return an error, Append returned that error before writing,
// so a single over-long line made every LATER report fail too — reporting died
// permanently over one bad byte. The scan error is now reported alongside the
// reports that were recovered, and Append still writes.
func TestOversizedLineDoesNotStopLaterReports(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "reports.jsonl")

	lg, err := OpenReportLog(path)
	if err != nil {
		t.Fatal(err)
	}
	// A good report first, so we can prove the reader keeps what it recovered.
	if err := lg.Append(Report{RoomID: "GOOD", Reason: "spam", At: "1"}); err != nil {
		t.Fatal(err)
	}
	// Now an over-long line: bigger than maxReportLineBytes.
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	huge := `{"room":"` + strings.Repeat("A", maxReportLineBytes+1024) + `","reason":"spam"}` + "\n"
	if _, err := f.WriteString(huge); err != nil {
		t.Fatal(err)
	}
	f.Close()

	got, rerr := lg.All()
	if rerr == nil {
		t.Error("an oversized line should still surface as a read error, so the operator can see it")
	}
	var sawGood bool
	for _, r := range got {
		if r.RoomID == "GOOD" {
			sawGood = true
		}
	}
	if !sawGood {
		t.Fatalf("the readable report was lost because of one oversized line; got %d reports", len(got))
	}

	// The decisive assertion: a later report is still accepted.
	if err := lg.Append(Report{RoomID: "LATER", Reason: "abuse", At: "2"}); err != nil {
		t.Fatalf("a report after an oversized line was rejected: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"LATER"`) {
		t.Fatal("the later report was not written to disk")
	}
}

// Rotation is a backstop; failing it must degrade, not disable. This makes the
// log unreadable in a way Stat accepts but a full read does not, then asserts
// the next Append still lands.
func TestRotationFailureStillAppends(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "reports.jsonl")

	lg, err := OpenReportLog(path)
	if err != nil {
		t.Fatal(err)
	}
	// Force rotation with a tiny cap and an over-long line already present.
	lg.maxBytes = 1
	huge := `{"room":"` + strings.Repeat("B", maxReportLineBytes+1024) + `","reason":"spam"}` + "\n"
	if err := os.WriteFile(path, []byte(huge), 0o600); err != nil {
		t.Fatal(err)
	}

	err = lg.Append(Report{RoomID: "AFTERROT", Reason: "abuse", At: "3"})
	// A RotationError means "persisted, but not rotated" — a different condition
	// from "not persisted", and the caller must be able to tell them apart.
	var re *RotationError
	if err != nil && !errors.As(err, &re) {
		t.Fatalf("Append returned %v, want nil or a *RotationError", err)
	}
	raw, rerr := os.ReadFile(path)
	if rerr != nil {
		t.Fatal(rerr)
	}
	if !strings.Contains(string(raw), `"AFTERROT"`) {
		t.Fatal("the report was not appended after a failed rotation")
	}
}

package rooms

// Durable abuse reports.
//
// Reports used to live only in a []Report on the Store, so a restart — an
// update, a crash, a reboot — silently discarded every abuse report the
// operator had collected. This adds an append-only JSON Lines log so the record
// survives that, which is the whole point of receiving one.
//
// Deliberate constraints:
//
//   - Stdlib only (os, bufio, encoding/json, path/filepath). The rest of the
//     service has no external dependencies and a log file is not worth one.
//   - JSON Lines, one report per line. Appending never rewrites history, a
//     half-written final line costs one report rather than the file, and
//     `tail` / `jq` work on it directly — which is how an operator will
//     actually read it.
//   - No reporter IP is recorded. docs/privacy.html promises that a report
//     stores "the room ID, the reason, and any contact detail you choose to
//     include", and the rate limiter already keys on the client IP, so adding
//     one would make the published policy false.
//   - Opt-in via a path. An empty path keeps the previous in-memory behaviour,
//     so enabling this is a deliberate operator action rather than a side
//     effect of upgrading.
//
// The file holds personal data (whatever a reporter typed into "contact"), so
// it is created 0600 and the containing directory 0700.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	// reportLogDirMode and reportLogFileMode keep the log unreadable to other
	// accounts on the host. Reports are user-supplied content.
	reportLogDirMode  os.FileMode = 0o700
	reportLogFileMode os.FileMode = 0o600

	// defaultReportLogMaxBytes bounds the file. At ~200 bytes per report this
	// is a few thousand reports; the in-memory cap is far lower, so this only
	// matters as a backstop against a long-running process that is never
	// restarted.
	defaultReportLogMaxBytes int64 = 4 << 20 // 4 MiB

	// maxReportLineBytes bounds a single JSONL line. A contact is capped at 120
	// bytes and the reason is an enum, so a real report is a few hundred bytes;
	// this is generous headroom. It exists so an over-long line degrades into a
	// skipped line rather than a scan error that hides the whole log.
	maxReportLineBytes = 1 << 20
)

// ReportLog is an append-only JSON Lines file of abuse reports.
type ReportLog struct {
	mu       sync.Mutex
	path     string
	maxBytes int64
}

// OpenReportLog prepares the log and its directory. It does not create the file
// until the first Append, so a configured-but-never-used path leaves no
// artefact behind. Returns nil (no error) for an empty path, which means
// "keep reports in memory only".
func OpenReportLog(path string) (*ReportLog, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, nil
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("report log path: %w", err)
	}
	if dir := filepath.Dir(abs); dir != "" {
		// MkdirAll is a no-op when the directory exists, so this does not
		// loosen permissions on a directory the operator already set up.
		if err := os.MkdirAll(dir, reportLogDirMode); err != nil {
			return nil, fmt.Errorf("report log dir: %w", err)
		}
	}
	return &ReportLog{path: abs, maxBytes: defaultReportLogMaxBytes}, nil
}

// Path is the absolute log path ("" when disabled).
func (l *ReportLog) Path() string {
	if l == nil {
		return ""
	}
	return l.path
}

// Append writes one report as a single line. Errors are returned, not logged:
// the caller decides what a failed write means, and the service deliberately
// writes nothing to disk that would record room ids.
func (l *ReportLog) Append(r Report) error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	// Rotation is a best-effort backstop, not a precondition: returning its error
	// here meant one unreadable line (a scanner ErrTooLong on a >1MiB line makes
	// readUnlocked fail, and every later read fails the same way) permanently
	// rejected every subsequent report, so durable reporting died silently
	// instead of degrading. Append anyway — an oversized log is a lesser problem
	// than an empty one.
	var rotationErr error
	if err := l.rotateIfOversize(); err != nil {
		rotationErr = err
	}
	b, err := json.Marshal(r)
	if err != nil {
		return fmt.Errorf("encode report: %w", err)
	}
	f, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, reportLogFileMode)
	if err != nil {
		return fmt.Errorf("open report log: %w", err)
	}
	defer f.Close()
	// A newline-terminated write keeps a crash from leaving a partial line that
	// would be skipped as corrupt on the next read.
	if _, err := f.Write(append(b, '\n')); err != nil {
		return fmt.Errorf("write report: %w", err)
	}
	if err := f.Close(); err != nil {
		return err
	}
	// The report IS on disk, so this is not a failed append — report the missed
	// rotation so the caller can count it, but the caller must still treat the
	// report as persisted.
	if rotationErr != nil {
		return &RotationError{Err: rotationErr}
	}
	return nil
}

// RotationError reports that a report was appended successfully but the log was
// not rotated. It is distinct from a failed append, so a caller can tell
// "persisted but oversized" from "not persisted at all".
type RotationError struct{ Err error }

func (e *RotationError) Error() string {
	return "report appended but log rotation failed: " + e.Err.Error()
}

func (e *RotationError) Unwrap() error { return e.Err }

// rotateIfOversize trims the oldest lines once the file passes maxBytes. It
// rewrites through a temp file and renames, so a crash mid-rotation leaves the
// previous log intact rather than a truncated one.
func (l *ReportLog) rotateIfOversize() error {
	fi, err := os.Stat(l.path)
	if err != nil {
		// No file yet is the normal first-append case. Any other Stat failure
		// means the size is unknown, so treat the log as due for rotation
		// rather than assuming it is under the cap — the previous code returned
		// nil for both and silently skipped the bound entirely.
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if fi.Size() <= l.maxBytes {
		return nil
	}
	all, err := l.readUnlocked()
	if err != nil {
		return err
	}
	// Keep roughly the newest 80% so rotation is infrequent.
	keep := len(all) * 4 / 5
	if keep < 1 {
		keep = 1
	}
	body := make([]byte, 0, keep*256)
	for _, r := range all[len(all)-keep:] {
		b, err := json.Marshal(r)
		if err != nil {
			continue
		}
		body = append(body, b...)
		body = append(body, '\n')
	}
	tmp := l.path + ".tmp"
	if err := os.WriteFile(tmp, body, reportLogFileMode); err != nil {
		return fmt.Errorf("rotate report log: %w", err)
	}
	if err := os.Rename(tmp, l.path); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("rotate report log: %w", err)
	}
	return nil
}

// All returns every readable report, oldest first. A corrupt line is skipped
// rather than failing the read: one bad line must not hide every report around
// it, which is exactly when the operator most needs to see them.
func (l *ReportLog) All() ([]Report, error) {
	if l == nil {
		return nil, nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.readUnlocked()
}

func (l *ReportLog) readUnlocked() ([]Report, error) {
	f, err := os.Open(l.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil // configured but never written yet
		}
		return nil, fmt.Errorf("read report log: %w", err)
	}
	defer f.Close()

	var out []Report
	sc := bufio.NewScanner(f)
	// A contact is capped at 120 bytes and the reason is an enum, so a line is
	// small; the buffer is raised anyway so a future field cannot silently
	// truncate a report into being skipped as corrupt.
	sc.Buffer(make([]byte, 0, 64<<10), maxReportLineBytes)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var r Report
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			continue // corrupt line: skip, keep going
		}
		if r.RoomID == "" {
			continue
		}
		out = append(out, r)
	}
	if err := sc.Err(); err != nil {
		// bufio.ErrTooLong (or any other scan error) is not fatal: keep every
		// report read up to this point. Returning nil here meant ONE oversized
		// line made the whole log unreadable, which also broke rotation (it
		// calls this function) and so stopped every subsequent Append — durable
		// reporting died over a single bad line.
		if errors.Is(err, bufio.ErrTooLong) {
			return out, fmt.Errorf("scan report log: line exceeds %d bytes, %d report(s) recovered: %w", maxReportLineBytes, len(out), err)
		}
		return out, fmt.Errorf("scan report log: %w", err)
	}
	return out, nil
}

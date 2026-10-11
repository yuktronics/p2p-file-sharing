package server

import (
	"testing"
	"time"
)

func TestLimiterBurstAndRefill(t *testing.T) {
	l := NewLimiter(3, time.Minute)
	now := time.Now()
	for i := 0; i < 3; i++ {
		if !l.Allow("a", now) {
			t.Fatalf("allow %d", i)
		}
	}
	if l.Allow("a", now) {
		t.Fatal("burst exceeded")
	}
	// other keys unaffected
	if !l.Allow("b", now) {
		t.Fatal("key isolation")
	}
	// refill after a full interval
	if !l.Allow("a", now.Add(time.Minute)) {
		t.Fatal("no refill")
	}
	l.Sweep(now.Add(10 * time.Minute))
	if n := l.Size(); n != 0 {
		t.Fatalf("sweep left %d", n)
	}
}

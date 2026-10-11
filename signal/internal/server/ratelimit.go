package server

import (
	"sync"
	"time"
)

// Limiter is a per-key token bucket (stdlib only). Zero value is unusable;
// build with NewLimiter.
type Limiter struct {
	mu       sync.Mutex
	buckets  map[string]*bucket
	capacity float64
	per      time.Duration
}

type bucket struct {
	tokens float64
	last   time.Time
}

// NewLimiter allows `capacity` events per `per` interval, bursting to capacity.
func NewLimiter(capacity int, per time.Duration) *Limiter {
	return &Limiter{buckets: map[string]*bucket{}, capacity: float64(capacity), per: per}
}

// Allow reports whether key may proceed, consuming one token.
func (l *Limiter) Allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.capacity, last: now}
		l.buckets[key] = b
	}
	elapsed := now.Sub(b.last).Seconds()
	b.tokens += elapsed * (l.capacity / l.per.Seconds())
	if b.tokens > l.capacity {
		b.tokens = l.capacity
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// Sweep drops idle buckets (call periodically; keeps memory bounded).
func (l *Limiter) Sweep(now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for k, b := range l.buckets {
		if now.Sub(b.last) > 2*l.per {
			delete(l.buckets, k)
		}
	}
}

func (l *Limiter) Size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

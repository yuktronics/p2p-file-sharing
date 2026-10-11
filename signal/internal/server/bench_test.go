package server

// Load benchmarks for ARCHITECTURE.md §3 acceptance criteria.
// Run explicitly: go test -bench=. -benchtime=10x -run=XXX ./internal/server/
// Never run under plain `go test` (testing.B only executes with -bench).

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"signal/internal/rooms"
	"signal/internal/ws"
)

func benchServer(b *testing.B, cfg Config) (*httptest.Server, string) {
	b.Helper()
	srv, err := New(cfg)
	if err != nil {
		b.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	b.Cleanup(ts.Close)
	resp, err := http.Post(ts.URL+"/api/rooms", "application/json",
		strings.NewReader(`{"files":[{"name":"f","size":1}]}`))
	if err != nil {
		b.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct{ ID string }
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		b.Fatal(err)
	}
	return ts, body.ID
}

func benchDial(b *testing.B, ts *httptest.Server, id, qs string) *ws.Conn {
	b.Helper()
	c, err := ws.Dial("ws"+strings.TrimPrefix(ts.URL, "http")+"/ws/rooms/"+id+"?"+qs, 1<<20)
	if err != nil {
		b.Fatal(err)
	}
	return c
}

// Idle connections: heap cost per parked receiver (presence drained).
// Run with -benchtime=1x (setup IS the measurement).
func BenchmarkIdleReceivers(b *testing.B) {
	const n = 2000
	cfg := testConfig()
	// Outlast the benchmark, like BenchmarkFanout already does. testConfig sets
	// PingInterval to 50ms, so with 2000 connections this queued ~40 000 pings
	// per second INSIDE the measurement window and retained them in each read
	// buffer — so the reported heap-per-conn measured ping traffic, not the idle
	// cost the benchmark exists to quantify. Those numbers feed the
	// ARCHITECTURE.md §3 acceptance criteria.
	cfg.PingInterval = 30 * time.Second // outlast the bench, not the conns
	ts, id := benchServer(b, cfg)
	conns := make([]*ws.Conn, 0, n)
	for i := 0; i < n; i++ {
		conns = append(conns, benchDial(b, ts, id, "role=receiver"))
	}
	drainAll(conns)
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	b.ReportMetric(float64(m.HeapAlloc)/1024/1024, "heap-MB")
	b.ReportMetric(float64(m.HeapAlloc)/float64(n), "heap-B-per-conn")
	for _, c := range conns {
		c.Close()
	}
}

func drainAll(conns []*ws.Conn) {
	for _, c := range conns {
		_ = c.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				break
			}
		}
		_ = c.SetReadDeadline(time.Time{})
	}
}

// Fan-out: one sender broadcasting to R receivers; cost per delivered frame.
func BenchmarkFanout(b *testing.B) {
	const receivers = 100
	cfg := testConfig()
	cfg.PingInterval = 30 * time.Second // outlast the bench, not the conns
	ts, id := benchServer(b, cfg)
	snd := benchDial(b, ts, id, "role=sender&peer=sender")
	defer snd.Close()
	rxs := make([]*ws.Conn, 0, receivers)
	for i := 0; i < receivers; i++ {
		rxs = append(rxs, benchDial(b, ts, id, "role=receiver"))
		defer rxs[i].Close()
	}
	drainAll(append(rxs, snd))
	msg, _ := json.Marshal(rooms.Frame{From: "sender", To: "receivers", Kind: "ice", Payload: "{}"})
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := snd.WriteMessage(ws.OpText, msg); err != nil {
			b.Fatal(err)
		}
	}
	b.ReportMetric(float64(receivers), "receivers")
}

// Round-trip: A→B→A app-level echo through the router. Measures trickle-path
// latency (the time budget ICE candidates actually experience).
func BenchmarkRoutedRoundTrip(b *testing.B) {
	cfg := testConfig()
	cfg.PingInterval = 30 * time.Second // measure signaling latency, not ping traffic
	ts, id := benchServer(b, cfg)
	a := benchDial(b, ts, id, "role=sender&peer=sender")
	defer a.Close()
	bb := benchDial(b, ts, id, "role=receiver&peer=rx-echo")
	defer bb.Close()
	drainAll([]*ws.Conn{a, bb})
	echo, _ := json.Marshal(rooms.Frame{From: "rx-echo", To: "sender", Kind: "ice", Payload: "{}"})
	ping, _ := json.Marshal(rooms.Frame{From: "sender", To: "rx-echo", Kind: "ice", Payload: "{}"})
	_ = bb.SetReadDeadline(time.Time{})
	_ = a.SetReadDeadline(time.Time{})
	done := make(chan struct{})
	go func() { // echo pump on bb
		defer close(done)
		for {
			op, p, err := bb.ReadMessage()
			if err != nil || op != ws.OpText {
				return
			}
			var f rooms.Frame
			if err := json.Unmarshal(p, &f); err != nil || f.Kind != "ice" {
				continue
			}
			if err := bb.WriteMessage(ws.OpText, echo); err != nil {
				return
			}
		}
	}()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := a.WriteMessage(ws.OpText, ping); err != nil {
			b.Fatal(err)
		}
		for {
			op, p, err := a.ReadMessage()
			if err != nil {
				b.Fatal(err)
			}
			if op != ws.OpText {
				continue
			}
			var f rooms.Frame
			if err := json.Unmarshal(p, &f); err != nil {
				continue
			}
			if f.Kind == "ice" {
				break
			}
		}
	}
	b.StopTimer()
	bb.Close()
	<-done
}

// Join storm: N rapid joins; wall time + heap delta (presence is O(n²)).
func BenchmarkJoinStorm(b *testing.B) {
	const n = 500
	cfg := testConfig()
	cfg.PingInterval = 30 * time.Second // isolate the join cost from ping traffic
	ts, id := benchServer(b, cfg)
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	start := time.Now()
	conns := make([]*ws.Conn, 0, n)
	for i := 0; i < n; i++ {
		conns = append(conns, benchDial(b, ts, id, "role=receiver"))
	}
	elapsed := time.Since(start)
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	b.ReportMetric(float64(elapsed.Milliseconds()), "join-ms-for-500")
	b.ReportMetric(float64(after.HeapAlloc-before.HeapAlloc)/float64(n), "heap-B-per-join")
	for _, c := range conns {
		c.Close()
	}
}

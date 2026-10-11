package ws

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// dialHandshakeTimeout bounds the whole connect + upgrade exchange, so Dial
// cannot block forever on a peer that accepts and then stalls.
const dialHandshakeTimeout = 10 * time.Second

// Dial opens a client WebSocket connection (for tests and dev tooling).
// Only ws:// (plain TCP) is implemented; production browsers use wss:// via TLS termination.
func Dial(addrURL string, maxMsg int) (*Conn, error) {
	u, err := url.Parse(addrURL)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "ws" {
		return nil, fmt.Errorf("ws: dial supports ws:// only, got %s", u.Scheme)
	}
	host := u.Host
	if _, _, err := net.SplitHostPort(host); err != nil {
		host = net.JoinHostPort(host, "80")
	}
	nc, err := net.DialTimeout("tcp", host, dialHandshakeTimeout)
	if err != nil {
		return nil, err
	}
	key := make([]byte, 16)
	if _, err := rand.Read(key); err != nil {
		nc.Close()
		return nil, err
	}
	b64key := base64.StdEncoding.EncodeToString(key)
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	req := "GET " + path + " HTTP/1.1\r\n" +
		"Host: " + u.Host + "\r\n" +
		"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + b64key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n\r\n"
	if _, err := nc.Write([]byte(req)); err != nil {
		nc.Close()
		return nil, err
	}
	// The connect had a 10s timeout but the handshake response did not: a peer
	// that accepts the TCP connection and never answers left ReadResponse
	// blocked forever, which is an unbounded goroutine in the test and dev
	// tooling — the same lifecycle rule the server side is held to.
	_ = nc.SetDeadline(time.Now().Add(dialHandshakeTimeout))
	br := bufio.NewReader(nc)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		nc.Close()
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		nc.Close()
		return nil, fmt.Errorf("ws: handshake status %s", resp.Status)
	}
	if got := resp.Header.Get("Sec-WebSocket-Accept"); !strings.EqualFold(got, AcceptKey(b64key)) {
		nc.Close()
		return nil, fmt.Errorf("ws: bad accept key")
	}
	bw := bufio.NewWriter(nc)
	return &Conn{conn: nc, br: br, bw: bw, client: true, maxMsg: maxMsg}, nil
}

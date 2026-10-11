package ws

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"net"
	"net/http"
	"net/url"
	"testing"
	"time"
)

type rawConn struct{ net.Conn }

func dialRawTCP(t *testing.T, httpURL string) (*rawConn, error) {
	t.Helper()
	u, err := url.Parse(httpURL)
	if err != nil {
		return nil, err
	}
	nc, err := net.DialTimeout("tcp", u.Host, 5*time.Second)
	if err != nil {
		return nil, err
	}
	key := make([]byte, 16)
	_, _ = rand.Read(key)
	b64 := base64.StdEncoding.EncodeToString(key)
	req := "GET / HTTP/1.1\r\nHost: " + u.Host + "\r\nUpgrade: websocket\r\n" +
		"Connection: Upgrade\r\nSec-WebSocket-Key: " + b64 + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n\r\n"
	if _, err := nc.Write([]byte(req)); err != nil {
		nc.Close()
		return nil, err
	}
	br := bufio.NewReader(nc)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		nc.Close()
		return nil, err
	}
	resp.Body.Close()
	if resp.StatusCode != 101 {
		nc.Close()
		return nil, errBadStatus(resp.Status)
	}
	return &rawConn{nc}, nil
}

type statusErr string

func errBadStatus(s string) error { return statusErr(s) }
func (e statusErr) Error() string { return "bad status: " + string(e) }

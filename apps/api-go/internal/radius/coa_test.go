package radius

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"encoding/binary"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

const syntheticRadiusSecret = "synthetic-radius-secret-32-bytes"

func testReply(request []byte, code byte, attrs []byte, withMAC bool) []byte {
	p := make([]byte, 20)
	p[0], p[1] = code, request[1]
	copy(p[4:20], request[4:20])
	p = append(p, attrs...)
	if withMAC {
		p = append(p, 80, 18)
		p = append(p, make([]byte, 16)...)
	}
	binary.BigEndian.PutUint16(p[2:4], uint16(len(p)))
	if withMAC {
		mac := hmac.New(md5.New, []byte(syntheticRadiusSecret))
		_, _ = mac.Write(p)
		copy(p[len(p)-16:], mac.Sum(nil))
	}
	sum := md5.Sum(append(bytes.Clone(p), []byte(syntheticRadiusSecret)...))
	copy(p[4:20], sum[:])
	return p
}
func TestDisconnectRejectsBroadSelectionAndAuthenticatesRequest(t *testing.T) {
	if BuildDisconnect(syntheticRadiusSecret, 1, "user", "", "") != nil {
		t.Fatal("username-only Disconnect is unsafe")
	}
	if BuildDisconnect(syntheticRadiusSecret, 1, "user", string(make([]byte, 254)), "") != nil {
		t.Fatal("oversized session attribute accepted")
	}
	p := BuildDisconnect(syntheticRadiusSecret, 1, "user", "exact-session", "2001:db8::1")
	if len(p) < 20 {
		t.Fatal("IPv6 selected session unavailable")
	}
	signature := bytes.Clone(p[4:20])
	clear(p[4:20])
	sum := md5.Sum(append(bytes.Clone(p), []byte(syntheticRadiusSecret)...))
	if !bytes.Equal(sum[:], signature) {
		t.Fatal("request authenticator")
	}
	at := -1
	for i := 20; i < len(p); i += int(p[i+1]) {
		if p[i] == 80 {
			at = i + 2
		}
	}
	if at < 0 {
		t.Fatal("Message-Authenticator missing")
	}
	signature = bytes.Clone(p[at : at+16])
	clear(p[at : at+16])
	mac := hmac.New(md5.New, []byte(syntheticRadiusSecret))
	_, _ = mac.Write(p)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		t.Fatal("request Message-Authenticator")
	}
}
func TestDisconnectStrictReplyFramingAndOptionalHMAC(t *testing.T) {
	request := BuildDisconnect(syntheticRadiusSecret, 2, "user", "exact-session", "")
	for _, withMAC := range []bool{false, true} {
		if r := ParseReply(syntheticRadiusSecret, request, testReply(request, 41, nil, withMAC)); r == nil || r.Outcome != "ack" {
			t.Fatal("valid reply rejected")
		}
	}
	for _, attrs := range [][]byte{{101, 6, 0, 0, 1, 150}, {101, 5, 0, 0, 1}, {101, 6, 0, 0, 1}, {80, 17, 0, 0, 0}, {1, 0}, {1, 2, 1}} {
		if ParseReply(syntheticRadiusSecret, request, testReply(request, 41, attrs, false)) != nil {
			t.Fatalf("signed malformed attributes accepted: %v", attrs)
		}
	}
	tampered := testReply(request, 41, nil, true)
	tampered[len(tampered)-1] ^= 1
	// Re-sign Response Authenticator only: a present wrong HMAC must still fail.
	data := bytes.Clone(tampered)
	copy(data[4:20], request[4:20])
	sum := md5.Sum(append(data, []byte(syntheticRadiusSecret)...))
	copy(tampered[4:20], sum[:])
	if ParseReply(syntheticRadiusSecret, request, tampered) != nil {
		t.Fatal("invalid HMAC accepted with valid Response Authenticator")
	}
	nak := ParseReply(syntheticRadiusSecret, request, testReply(request, 42, []byte{101, 6, 0, 0, 1, 150}, true))
	if nak == nil || nak.Outcome != "nak" || nak.Cause == nil || *nak.Cause != 406 {
		t.Fatal("NAK406 misclassified")
	}
}
func TestDisconnectConnectedPeerAndCancellationWithoutRetry(t *testing.T) {
	t.Setenv("NEXO_RADIUS_COA_RELAY", "")
	server, e := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if e != nil {
		t.Fatal(e)
	}
	defer server.Close()
	var legitimate atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		b := make([]byte, 4096)
		n, client, e := server.ReadFromUDP(b)
		if e != nil {
			return
		}
		packet := testReply(b[:n], 41, nil, true)
		rogue, e := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
		if e != nil {
			return
		}
		_, _ = rogue.WriteToUDP(packet, client)
		_ = rogue.Close()
		time.Sleep(30 * time.Millisecond)
		legitimate.Store(true)
		_, _ = server.WriteToUDP(packet, client)
	}()
	result := SendDisconnect(context.Background(), "127.0.0.1", server.LocalAddr().(*net.UDPAddr).Port, syntheticRadiusSecret, "user", "exact-session", "")
	if result.Outcome != "ack" || !legitimate.Load() {
		t.Fatal("reply from another peer was accepted", result)
	}
	<-done
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	start := time.Now()
	result = SendDisconnect(ctx, "127.0.0.1", server.LocalAddr().(*net.UDPAddr).Port, syntheticRadiusSecret, "user", "another-session", "")
	if result.Outcome != "timeout" || time.Since(start) > 500*time.Millisecond {
		t.Fatal("context cancellation ignored", result, time.Since(start))
	}
	_ = server.SetReadDeadline(time.Now().Add(60 * time.Millisecond))
	b := make([]byte, 4096)
	if _, _, e = server.ReadFromUDP(b); e != nil {
		t.Fatal("expected one datagram")
	}
	if _, _, e = server.ReadFromUDP(b); e == nil {
		t.Fatal("unknown result was retransmitted")
	}
}

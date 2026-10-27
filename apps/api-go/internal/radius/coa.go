package radius

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/subtle"
	"encoding/binary"
	"net"
	"os"
	"strconv"
	"time"
)

type DisconnectResult struct {
	Outcome string
	Cause   *uint32
}

// BuildDisconnect selects one known session. A username by itself is never a
// safe substitute after a lost response or a NAS reconnect.
func BuildDisconnect(secret string, id byte, username, session, ip string) []byte {
	if len(secret) < 16 || len(username) == 0 || len(username) > 253 || len(session) == 0 || len(session) > 253 {
		return nil
	}
	attr := func(kind byte, value []byte) []byte { return append([]byte{kind, byte(len(value) + 2)}, value...) }
	attrs := attr(1, []byte(username))
	attrs = append(attrs, attr(44, []byte(session))...)
	if ip != "" {
		parsed := net.ParseIP(ip)
		if parsed == nil {
			return nil
		}
		if v := parsed.To4(); v != nil {
			attrs = append(attrs, attr(8, v)...)
		}
	}
	stamp := make([]byte, 4)
	binary.BigEndian.PutUint32(stamp, uint32(time.Now().Unix()))
	attrs = append(attrs, attr(55, stamp)...)
	attrs = append(attrs, attr(80, make([]byte, 16))...)
	packet := make([]byte, 20)
	packet[0], packet[1] = 40, id
	binary.BigEndian.PutUint16(packet[2:4], uint16(20+len(attrs)))
	packet = append(packet, attrs...)
	// RFC5176 section3.4: both authenticators are zero for the request HMAC;
	// calculate the Request Authenticator only after inserting that HMAC.
	mac := hmac.New(md5.New, []byte(secret))
	_, _ = mac.Write(packet)
	copy(packet[len(packet)-16:], mac.Sum(nil))
	sum := md5.Sum(append(bytes.Clone(packet), []byte(secret)...))
	copy(packet[4:20], sum[:])
	return packet
}
func ParseReply(secret string, request, reply []byte) *DisconnectResult {
	if len(request) < 20 || request[0] != 40 || len(request) != int(binary.BigEndian.Uint16(request[2:4])) || len(reply) < 20 || len(reply) > 4096 || reply[1] != request[1] || len(reply) != int(binary.BigEndian.Uint16(reply[2:4])) || (reply[0] != 41 && reply[0] != 42) {
		return nil
	}
	var cause *uint32
	authAt := -1
	for i := 20; i < len(reply); {
		if i+2 > len(reply) {
			return nil
		}
		n := int(reply[i+1])
		if n < 2 || i+n > len(reply) {
			return nil
		}
		if reply[i] == 101 {
			if n != 6 || cause != nil {
				return nil
			}
			v := binary.BigEndian.Uint32(reply[i+2 : i+6])
			cause = &v
		}
		if reply[i] == 80 {
			if n != 18 || authAt >= 0 {
				return nil
			}
			authAt = i + 2
		}
		i += n
	}
	data := bytes.Clone(reply)
	copy(data[4:20], request[4:20])
	sum := md5.Sum(append(bytes.Clone(data), []byte(secret)...))
	if subtle.ConstantTimeCompare(sum[:], reply[4:20]) != 1 {
		return nil
	}
	if authAt >= 0 {
		clear(data[authAt : authAt+16])
		mac := hmac.New(md5.New, []byte(secret))
		_, _ = mac.Write(data)
		if !hmac.Equal(mac.Sum(nil), reply[authAt:authAt+16]) {
			return nil
		}
	}
	// RFC5176 permits replies without Message-Authenticator; keep that explicit
	// interoperability rule, but never accept a present invalid authenticator.
	if reply[0] == 41 && cause != nil && *cause != 201 {
		return nil
	}
	if reply[0] == 42 && cause != nil && *cause < 400 {
		return nil
	}
	if reply[0] == 41 {
		return &DisconnectResult{Outcome: "ack", Cause: cause}
	}
	return &DisconnectResult{Outcome: "nak", Cause: cause}
}
func SendDisconnect(ctx context.Context, host string, port int, secret, username, session, ip string) DisconnectResult {
	if ctx.Err() != nil {
		return DisconnectResult{Outcome: "unavailable"}
	}
	if host == "" || port < 1 || port > 65535 {
		return DisconnectResult{Outcome: "invalid"}
	}
	random := []byte{0}
	if _, e := rand.Read(random); e != nil {
		return DisconnectResult{Outcome: "unavailable"}
	}
	request := BuildDisconnect(secret, random[0], username, session, ip)
	if request == nil {
		return DisconnectResult{Outcome: "invalid"}
	}
	wire := request
	if relay := os.Getenv("NEXO_RADIUS_COA_RELAY"); relay != "" {
		// The existing VPN relay envelope is IPv4 only. Do not silently bypass it
		// for an IPv6 NAS or hostname: that would change the configured trust path.
		address := net.ParseIP(host)
		if address == nil || address.To4() == nil {
			return DisconnectResult{Outcome: "invalid"}
		}
		h, p, e := net.SplitHostPort(relay)
		if e != nil {
			return DisconnectResult{Outcome: "invalid"}
		}
		n, e := strconv.Atoi(p)
		if e != nil || n < 1 || n > 65535 {
			return DisconnectResult{Outcome: "invalid"}
		}
		header := make([]byte, 6)
		copy(header, address.To4())
		binary.BigEndian.PutUint16(header[4:], uint16(port))
		wire = append(header, request...)
		host, port = h, n
	}
	// DialContext binds replies to the chosen UDP peer and honors cancellation
	// during DNS/connect. A connected socket cannot accept another source's ACK.
	dialer := net.Dialer{}
	conn, e := dialer.DialContext(ctx, "udp", net.JoinHostPort(host, strconv.Itoa(port)))
	if e != nil {
		return DisconnectResult{Outcome: "unavailable"}
	}
	defer conn.Close()
	deadline := time.Now().Add(2500 * time.Millisecond)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Now()) })
	defer stop()
	// One journalled send only. Retransmitting after an unknown result could
	// target a later session on NASes with weak duplicate handling.
	if _, e = conn.Write(wire); e != nil {
		return DisconnectResult{Outcome: "timeout"}
	}
	buffer := make([]byte, 4097)
	for {
		n, e := conn.Read(buffer)
		if e != nil {
			return DisconnectResult{Outcome: "timeout"}
		}
		if r := ParseReply(secret, request, buffer[:n]); r != nil {
			return *r
		}
	}
}

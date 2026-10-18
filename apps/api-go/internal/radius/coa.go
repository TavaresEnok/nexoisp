package radius

import (
	"bytes"
	"context"
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

func BuildDisconnect(secret string, id byte, username, session, ip string) []byte {
	attr := func(kind byte, v []byte) []byte { return append([]byte{kind, byte(len(v) + 2)}, v...) }
	attrs := attr(1, []byte(username))
	if session != "" {
		attrs = append(attrs, attr(44, []byte(session))...)
	}
	if v := net.ParseIP(ip).To4(); v != nil {
		attrs = append(attrs, attr(8, v)...)
	}
	packet := make([]byte, 20)
	packet[0], packet[1] = 40, id
	binary.BigEndian.PutUint16(packet[2:4], uint16(20+len(attrs)))
	packet = append(packet, attrs...)
	sum := md5.Sum(append(bytes.Clone(packet), []byte(secret)...))
	copy(packet[4:20], sum[:])
	return packet
}
func ParseReply(secret string, request, reply []byte) *DisconnectResult {
	if len(request) < 20 || len(reply) < 20 || reply[1] != request[1] || int(binary.BigEndian.Uint16(reply[2:4])) != len(reply) {
		return nil
	}
	data := append(bytes.Clone(reply[:4]), request[4:20]...)
	data = append(data, reply[20:]...)
	data = append(data, []byte(secret)...)
	sum := md5.Sum(data)
	if subtle.ConstantTimeCompare(sum[:], reply[4:20]) != 1 {
		return nil
	}
	if reply[0] == 41 {
		return &DisconnectResult{Outcome: "ack"}
	}
	if reply[0] != 42 {
		return nil
	}
	r := &DisconnectResult{Outcome: "nak"}
	for i := 20; i+2 <= len(reply); {
		n := int(reply[i+1])
		if n < 2 || i+n > len(reply) {
			break
		}
		if reply[i] == 101 && n == 6 {
			value := binary.BigEndian.Uint32(reply[i+2 : i+6])
			r.Cause = &value
		}
		i += n
	}
	return r
}
func SendDisconnect(ctx context.Context, host string, port int, secret, username, session, ip string) DisconnectResult {
	random := make([]byte, 1)
	_, _ = rand.Read(random)
	request := BuildDisconnect(secret, random[0], username, session, ip)
	wire := request
	if relay := os.Getenv("NEXO_RADIUS_COA_RELAY"); relay != "" && net.ParseIP(host).To4() != nil {
		if h, p, e := net.SplitHostPort(relay); e == nil {
			n, e := strconv.Atoi(p)
			if e == nil {
				head := make([]byte, 6)
				copy(head, net.ParseIP(host).To4())
				binary.BigEndian.PutUint16(head[4:], uint16(port))
				wire = append(head, request...)
				host, port = h, n
			}
		}
	}
	address, e := net.ResolveUDPAddr("udp", net.JoinHostPort(host, strconv.Itoa(port)))
	if e != nil {
		return DisconnectResult{Outcome: "timeout"}
	}
	family := "udp4"
	if address.IP.To4() == nil {
		family = "udp6"
	}
	conn, e := net.ListenUDP(family, nil)
	if e != nil {
		return DisconnectResult{Outcome: "timeout"}
	}
	defer conn.Close()
	buffer := make([]byte, 65535)
	for attempt := 0; attempt < 2; attempt++ {
		if ctx.Err() != nil {
			break
		}
		_ = conn.SetReadDeadline(time.Now().Add(2500 * time.Millisecond))
		_, _ = conn.WriteToUDP(wire, address)
		for {
			n, _, e := conn.ReadFromUDP(buffer)
			if e != nil {
				break
			}
			if r := ParseReply(secret, request, buffer[:n]); r != nil {
				return *r
			}
		}
	}
	return DisconnectResult{Outcome: "timeout"}
}

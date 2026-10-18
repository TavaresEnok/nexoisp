package vpn

import (
	"context"
	"encoding/binary"
	"net"
	"testing"
	"time"
)

func TestRelayProtocolAndShutdown(t *testing.T) {
	target, e := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if e != nil {
		t.Fatal(e)
	}
	defer target.Close()
	probe, e := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if e != nil {
		t.Fatal(e)
	}
	address := probe.LocalAddr().String()
	_ = probe.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- Relay(ctx, address) }()
	received := make(chan []byte, 1)
	go func() {
		b := make([]byte, 256)
		n, from, e := target.ReadFromUDP(b)
		if e == nil {
			received <- b[:n]
			_, _ = target.WriteToUDP([]byte("reply"), from)
		}
	}()
	packet := make([]byte, 26)
	copy(packet, []byte{127, 0, 0, 1})
	binary.BigEndian.PutUint16(packet[4:6], uint16(target.LocalAddr().(*net.UDPAddr).Port))
	copy(packet[6:], []byte("radius-packet-20byte!"))
	var reply []byte
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); {
		c, e := net.Dial("udp4", address)
		if e != nil {
			t.Fatal(e)
		}
		_ = c.SetDeadline(time.Now().Add(100 * time.Millisecond))
		_, _ = c.Write(packet)
		b := make([]byte, 256)
		n, e := c.Read(b)
		_ = c.Close()
		if e == nil {
			reply = b[:n]
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if string(reply) != "reply" {
		t.Fatalf("resposta UDP: %q", reply)
	}
	select {
	case got := <-received:
		if string(got) != string(packet[6:]) {
			t.Fatal("envelope não foi removido corretamente")
		}
	case <-time.After(time.Second):
		t.Fatal("destino não recebeu o pacote")
	}
	cancel()
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		t.Fatal("relay não encerrou")
	}
}

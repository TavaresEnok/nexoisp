package httpx

import (
	"net/http/httptest"
	"testing"
)

func TestClientIP(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.5:4000"
	req.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.5")
	req.Header.Set("X-Nexo-Client-Ip", "198.51.100.7")
	t.Setenv("NEXO_TRUST_PROXY", "")
	if got := ClientIP(req); got != "10.0.0.5" {
		t.Fatalf("sem proxy confiável usa o par TCP: %s", got)
	}
	t.Setenv("NEXO_TRUST_PROXY", "1")
	if got := ClientIP(req); got != "198.51.100.7" {
		t.Fatalf("atrás do Caddy usa o cabeçalho calculado por ele: %s", got)
	}
	req.Header.Set("X-Nexo-Client-Ip", "não é ip")
	if got := ClientIP(req); got != "10.0.0.5" {
		t.Fatalf("valor inválido cai no par TCP, nunca no X-Forwarded-For forjável: %s", got)
	}
	req.Header.Set("X-Nexo-Client-Ip", "::ffff:198.51.100.7")
	if got := ClientIP(req); got != "198.51.100.7" {
		t.Fatalf("IPv4 mapeado é normalizado: %s", got)
	}
}

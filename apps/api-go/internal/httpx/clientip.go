package httpx

import (
	"net"
	"net/http"
	"net/netip"
	"os"
	"strings"
)

// ClientIP devolve o endereço do cliente usado em limites e auditoria.
//
// Com NEXO_TRUST_PROXY=1 a API está atrás do Caddy do NexoISP, que sobrescreve
// X-Nexo-Client-Ip com o primeiro endereço não confiável da cadeia
// X-Forwarded-For (trusted_proxies_strict). O valor mais à esquerda do
// X-Forwarded-For não é usado: o cliente controla esse campo.
func ClientIP(r *http.Request) string {
	if os.Getenv("NEXO_TRUST_PROXY") == "1" {
		if addr, err := netip.ParseAddr(strings.TrimSpace(r.Header.Get("X-Nexo-Client-Ip"))); err == nil {
			return addr.Unmap().String()
		}
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

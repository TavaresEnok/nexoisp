package cloudapi

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"
)

const graphHost = "graph.facebook.com"

// privateAddress matches outbound.privateAddress. The parent package is not
// imported: cloudapi must stay free of that dependency cycle.
func privateAddress(ip string) bool {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return true
	}
	if addr.Is4In6() || !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() {
		return true
	}
	for _, prefix := range []netip.Prefix{
		netip.MustParsePrefix("100.64.0.0/10"),
		netip.MustParsePrefix("192.0.0.0/24"),
		netip.MustParsePrefix("198.18.0.0/15"),
		netip.MustParsePrefix("198.51.100.0/24"),
		netip.MustParsePrefix("203.0.113.0/24"),
		netip.MustParsePrefix("2001:db8::/32"),
	} {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

func canonicalHost(host string) string {
	return strings.TrimSuffix(strings.ToLower(host), ".")
}

func rejectPrivate(addrs []netip.Addr) error {
	if len(addrs) == 0 {
		return errors.New("resolução vazia do host fixo")
	}
	for _, addr := range addrs {
		if privateAddress(addr.String()) {
			return errors.New("endereço interno recusado")
		}
	}
	return nil
}

func authorizeDial(address string, pinned []netip.Addr) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	if canonicalHost(host) != graphHost {
		return errors.New("destino divergente do host fixo")
	}
	if port != "443" {
		return errors.New("porta divergente do host fixo")
	}
	return rejectPrivate(pinned)
}

func lookupPinned(ctx context.Context) ([]netip.Addr, error) {
	addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip", graphHost)
	if err != nil || len(addrs) == 0 {
		return nil, errors.New("não foi possível resolver o host fixo")
	}
	if err := rejectPrivate(addrs); err != nil {
		return nil, err
	}
	return addrs, nil
}

func pinnedHTTPClient(pinned []netip.Addr, timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: timeout}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			if err := authorizeDial(address, pinned); err != nil {
				return nil, err
			}
			_, port, _ := net.SplitHostPort(address)
			var last error
			for _, ip := range pinned {
				conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
				if err == nil {
					return conn, nil
				}
				last = err
			}
			if last == nil {
				last = errors.New("sem endereço aceito")
			}
			return nil, last
		},
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			ServerName: graphHost,
		},
		ForceAttemptHTTP2:     false,
		DisableKeepAlives:     true,
		MaxIdleConns:          1,
		IdleConnTimeout:       timeout,
		TLSHandshakeTimeout:   timeout,
		ResponseHeaderTimeout: timeout,
	}
	return &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("redirect recusado")
		},
	}
}

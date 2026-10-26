// Package outbound sends provider webhooks outside database transactions.
package outbound

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/jsonx"
	"os"
	"strings"
	"time"
	"unicode/utf16"
)

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
func safeURL(ctx context.Context, raw string) (*url.URL, []netip.Addr, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return nil, nil, apierr.New(400, "endereço do webhook inválido")
	}
	password := ""
	if u.User != nil {
		password, _ = u.User.Password()
	}
	if u.User != nil && (u.User.Username() != "" || password != "") {
		return nil, nil, apierr.New(400, "o endereço do webhook não pode conter usuário e senha")
	}
	if os.Getenv("NEXO_DEMO_MODE") == "1" {
		if u.Scheme != "http" && u.Scheme != "https" {
			return nil, nil, apierr.New(400, "use http ou https")
		}
		return u, nil, nil
	}
	if u.Scheme != "https" {
		return nil, nil, apierr.New(400, "o webhook precisa usar https")
	}
	host := u.Hostname()
	if host == "" {
		return nil, nil, apierr.New(400, "endereço do webhook inválido")
	}
	addresses := []netip.Addr{}
	if address, parseErr := netip.ParseAddr(host); parseErr == nil {
		addresses = append(addresses, address)
	} else {
		addresses, err = net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil || len(addresses) == 0 {
			return nil, nil, apierr.New(400, "não foi possível resolver o endereço do webhook")
		}
	}
	for _, address := range addresses {
		if privateAddress(address.String()) {
			return nil, nil, apierr.New(400, "o webhook aponta para um endereço interno, o que não é permitido")
		}
	}
	return u, addresses, nil
}
func SafeURL(ctx context.Context, raw string) (*url.URL, error) {
	u, _, err := safeURL(ctx, raw)
	return u, err
}
func Sign(secret, timestamp, body string) string {
	h := hmac.New(sha256.New, []byte(secret))
	_, _ = h.Write([]byte(timestamp + "." + body))
	return "sha256=" + hex.EncodeToString(h.Sum(nil))
}
func Post(ctx context.Context, raw string, payload any, headers map[string]string, timeout time.Duration) (int, error) {
	u, addresses, err := safeURL(ctx, raw)
	if err != nil {
		return 0, err
	}
	body, err := jsonx.Encode(payload)
	if err != nil {
		return 0, err
	}
	return postBytes(ctx, u, addresses, body, headers, timeout)
}
func postBytes(ctx context.Context, u *url.URL, addresses []netip.Addr, body []byte, headers map[string]string, timeout time.Duration) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", u.String(), bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	if len(addresses) > 0 {
		allowedHost := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, err
			}
			if strings.TrimSuffix(strings.ToLower(host), ".") != allowedHost {
				return nil, errors.New("destino de webhook divergente do endereço validado")
			}
			var lastErr error
			for _, ip := range addresses {
				conn, err := (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
				if err == nil {
					return conn, nil
				}
				lastErr = err
			}
			return nil, lastErr
		}
	}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect recusado") }}
	response, err := client.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return 0, errors.New("The operation was aborted due to timeout")
		}
		return 0, errors.New("fetch failed")
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	return response.StatusCode, nil
}
func Webhook(ctx context.Context, raw, secret string, id any, event string, payload any) (int, error) {
	u, addresses, err := safeURL(ctx, raw)
	if err != nil {
		return 0, err
	}
	body, err := jsonx.Encode(payload)
	if err != nil {
		return 0, err
	}
	timestamp := fmt.Sprint(time.Now().Unix())
	return postBytes(ctx, u, addresses, body, map[string]string{"user-agent": "NexoISP-Webhook/1", "x-nexo-event": event, "x-nexo-delivery": jsonx.String(id), "x-nexo-timestamp": timestamp, "x-nexo-signature": Sign(secret, timestamp, string(body))}, 8*time.Second)
}
func ErrorText(err error) string {
	units := utf16.Encode([]rune(err.Error()))
	if len(units) > 300 {
		units = units[:300]
	}
	return string(utf16.Decode(units))
}

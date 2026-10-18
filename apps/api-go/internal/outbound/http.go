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
	if addr.Is6() {
		s := strings.ToLower(ip)
		return s == "::1" || s == "::" || strings.HasPrefix(s, "fc") || strings.HasPrefix(s, "fd") || strings.HasPrefix(s, "fe80") || strings.HasPrefix(s, "::ffff:")
	}
	a := addr.As4()
	return a[0] == 0 || a[0] == 10 || a[0] == 127 || a[0] == 169 && a[1] == 254 || a[0] == 172 && a[1] >= 16 && a[1] <= 31 || a[0] == 192 && a[1] == 168 || a[0] == 100 && a[1] >= 64 && a[1] <= 127 || a[0] >= 224
}
func SafeURL(ctx context.Context, raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return nil, apierr.New(400, "endereço do webhook inválido")
	}
	password := ""
	if u.User != nil {
		password, _ = u.User.Password()
	}
	if u.User != nil && (u.User.Username() != "" || password != "") {
		return nil, apierr.New(400, "o endereço do webhook não pode conter usuário e senha")
	}
	if os.Getenv("NEXO_DEMO_MODE") == "1" {
		if u.Scheme != "http" && u.Scheme != "https" {
			return nil, apierr.New(400, "use http ou https")
		}
		return u, nil
	}
	if u.Scheme != "https" {
		return nil, apierr.New(400, "o webhook precisa usar https")
	}
	addresses := []string{u.Hostname()}
	if _, err = netip.ParseAddr(u.Hostname()); err != nil {
		addresses, err = net.DefaultResolver.LookupHost(ctx, u.Hostname())
		if err != nil || len(addresses) == 0 {
			return nil, apierr.New(400, "não foi possível resolver o endereço do webhook")
		}
	}
	for _, address := range addresses {
		if privateAddress(address) {
			return nil, apierr.New(400, "o webhook aponta para um endereço interno, o que não é permitido")
		}
	}
	return u, nil
}
func Sign(secret, timestamp, body string) string {
	h := hmac.New(sha256.New, []byte(secret))
	_, _ = h.Write([]byte(timestamp + "." + body))
	return "sha256=" + hex.EncodeToString(h.Sum(nil))
}
func Post(ctx context.Context, raw string, payload any, headers map[string]string, timeout time.Duration) (int, error) {
	u, err := SafeURL(ctx, raw)
	if err != nil {
		return 0, err
	}
	body, err := jsonx.Encode(payload)
	if err != nil {
		return 0, err
	}
	return postBytes(ctx, u, body, headers, timeout)
}
func postBytes(ctx context.Context, u *url.URL, body []byte, headers map[string]string, timeout time.Duration) (int, error) {
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
	u, err := SafeURL(ctx, raw)
	if err != nil {
		return 0, err
	}
	body, err := jsonx.Encode(payload)
	if err != nil {
		return 0, err
	}
	timestamp := fmt.Sprint(time.Now().Unix())
	return postBytes(ctx, u, body, map[string]string{"user-agent": "NexoISP-Webhook/1", "x-nexo-event": event, "x-nexo-delivery": jsonx.String(id), "x-nexo-timestamp": timestamp, "x-nexo-signature": Sign(secret, timestamp, string(body))}, 8*time.Second)
}
func ErrorText(err error) string {
	units := utf16.Encode([]rune(err.Error()))
	if len(units) > 300 {
		units = units[:300]
	}
	return string(utf16.Decode(units))
}

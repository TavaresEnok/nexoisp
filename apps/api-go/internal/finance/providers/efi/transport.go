// Package efi contains the sandbox-only Pix protocol boundary. It is not
// registered in the application's executable provider registry.
package efi

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"nexoisp/api-go/internal/finance/providers"
)

const sandboxURL = "https://pix-h.api.efipay.com.br"
const maxBody = 1 << 20

// Config must come from one connection's secret store, never ambient environment.
// Certificate rotation constructs a new Client; token/cache/transport are not shared.
type Config struct {
	Scope                         providers.Scope
	ClientID, ClientSecret        string
	CertificatePEM, PrivateKeyPEM []byte
	Timeout                       time.Duration
}

type Client struct {
	scope            providers.Scope
	id, secret, base string
	http             *http.Client
	mu               sync.Mutex
	token            string
	expires          time.Time
}

func NewSandbox(cfg Config) (*Client, error) {
	if cfg.Scope.Validate() != nil || cfg.Scope.Provider != "efi" || cfg.Scope.Environment != "sandbox" {
		return nil, errors.New("Efí Pix requires a complete sandbox connection")
	}
	if cfg.ClientID == "" || cfg.ClientSecret == "" || strings.Contains(cfg.ClientID, ":") {
		return nil, errors.New("invalid OAuth credentials")
	}
	cert, err := tls.X509KeyPair(cfg.CertificatePEM, cfg.PrivateKeyPEM)
	if err != nil {
		return nil, errors.New("invalid client certificate/key pair")
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil || time.Now().Before(leaf.NotBefore) || !time.Now().Before(leaf.NotAfter) {
		return nil, errors.New("client certificate outside validity period")
	}
	timeout := cfg.Timeout
	if timeout == 0 {
		timeout = 15 * time.Second
	}
	if timeout < time.Second || timeout > time.Minute {
		return nil, errors.New("timeout must be between one second and one minute")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}}
	transport.TLSHandshakeTimeout = timeout
	client := &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("provider redirects disabled") }}
	return &Client{scope: cfg.Scope, id: cfg.ClientID, secret: cfg.ClientSecret, base: sandboxURL, http: client}, nil
}

func (c *Client) Close() { c.http.CloseIdleConnections() }

func failure(kind providers.FailureKind, text string) error {
	return &providers.Failure{Kind: kind, Cause: errors.New(text)}
}

func readJSON(r *http.Response, target any) error {
	defer func() { _ = r.Body.Close() }()
	b, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil || len(b) > maxBody {
		return errors.New("provider response truncated or oversized")
	}
	if err = json.Unmarshal(b, target); err != nil {
		return errors.New("invalid provider JSON")
	}
	return nil
}

// accessToken serializes refresh per connection. No shared global token cache.
func (c *Client) accessToken(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if c.token != "" && time.Now().Before(c.expires) {
		return c.token, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/oauth/token", strings.NewReader(`{"grant_type":"client_credentials"}`))
	if err != nil {
		return "", err
	}
	req.SetBasicAuth(c.id, c.secret)
	req.Header.Set("Content-Type", "application/json")
	r, err := c.http.Do(req)
	if err != nil {
		return "", failure(providers.Unavailable, "OAuth transport failed")
	}
	if r.StatusCode != http.StatusOK {
		return "", responseFailure(r, providers.Unavailable)
	}
	var token struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err = readJSON(r, &token); err != nil {
		return "", failure(providers.Unavailable, "invalid OAuth response")
	}
	if token.AccessToken == "" || !strings.EqualFold(token.TokenType, "Bearer") || token.ExpiresIn <= 0 || token.ExpiresIn > 86400 {
		return "", failure(providers.Unavailable, "invalid OAuth token metadata")
	}
	// Keep a safety margin, including short-lived tokens, without integer overflow.
	ttl := time.Duration(token.ExpiresIn) * time.Second
	margin := ttl / 10
	if margin > 30*time.Second {
		margin = 30 * time.Second
	}
	c.token = token.AccessToken
	c.expires = time.Now().Add(ttl - margin)
	return c.token, nil
}

func responseFailure(r *http.Response, uncertain providers.FailureKind) error {
	defer func() { _ = r.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, 4096))
	kind := uncertain
	switch r.StatusCode {
	case 400, 401, 403, 422:
		kind = providers.Rejected
	case 409:
		kind = providers.Conflict
	}
	var delay time.Duration
	if seconds, err := strconv.ParseInt(r.Header.Get("Retry-After"), 10, 64); err == nil && seconds >= 0 && seconds <= 86400 {
		delay = time.Duration(seconds) * time.Second
	} else if date, err := http.ParseTime(r.Header.Get("Retry-After")); err == nil {
		delay = time.Until(date)
		if delay < 0 {
			delay = 0
		}
		if delay > 24*time.Hour {
			delay = 24 * time.Hour
		}
	}
	// Never expose provider bodies, URLs, tokens or credentials in errors/logs.
	return &providers.Failure{Kind: kind, RetryAfter: delay, Cause: fmt.Errorf("Efí HTTP %d", r.StatusCode)}
}

func (c *Client) request(ctx context.Context, method, path string, body any, target any) error {
	var payload []byte
	var err error
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			return failure(providers.Rejected, "invalid request payload")
		}
	}
	token, err := c.accessToken(ctx)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	kind := providers.Unknown
	if method == http.MethodGet {
		kind = providers.Unavailable
	}
	r, err := c.http.Do(req)
	if err != nil {
		return failure(kind, "provider transport failed; lookup required before write retry")
	}
	if r.StatusCode != 200 && r.StatusCode != 201 {
		if r.StatusCode == 401 {
			c.mu.Lock()
			if c.token == token {
				c.token = ""
				c.expires = time.Time{}
			}
			c.mu.Unlock()
		}
		return responseFailure(r, kind)
	}
	if err = readJSON(r, target); err != nil {
		return failure(kind, "invalid provider response; lookup required")
	}
	return nil
}

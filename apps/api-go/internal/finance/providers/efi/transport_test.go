package efi

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"nexoisp/api-go/internal/finance/providers"
)

func labConfig(t *testing.T) (Config, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "synthetic-client"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	priv, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(cert)
	return Config{Scope: providers.Scope{TenantID: "tenant", ConnectionID: "connection", Provider: "efi", Environment: "sandbox", AccountRef: "account"}, ClientID: "synthetic-id", ClientSecret: "synthetic-secret", CertificatePEM: cert, PrivateKeyPEM: pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: priv})}, roots
}
func labClient(t *testing.T, handler http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	cfg, roots := labConfig(t)
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS12, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: roots}
	server.StartTLS()
	t.Cleanup(server.Close)
	c, err := NewSandbox(cfg)
	if err != nil {
		t.Fatal(err)
	}
	// Only test code can replace fixed endpoint and roots. No config/env URL override.
	c.base = server.URL
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	c.http.Transport.(*http.Transport).TLSClientConfig.RootCAs = pool
	t.Cleanup(c.Close)
	return c, server
}
func oauth(w http.ResponseWriter) {
	_, _ = w.Write([]byte(`{"access_token":"synthetic-token","token_type":"Bearer","expires_in":3600}`))
}
func fixture(c *Client) providers.Create {
	return providers.Create{Scope: c.scope, IntentKey: "durable-intent", InvoiceID: "invoice", Money: providers.Money{Cents: 12345, Currency: "BRL"}, DueDate: "2026-11-15"}
}
func response(r providers.Create) map[string]any {
	return map[string]any{"txid": TxID(r), "status": "ATIVA", "chave": "synthetic-pix-key", "valor": map[string]string{"original": "123.45"}}
}

func TestMutualTLSConcurrentOAuthAndRotation(t *testing.T) {
	var calls atomic.Int64
	c, _ := labClient(t, func(w http.ResponseWriter, r *http.Request) {
		if len(r.TLS.VerifiedChains) == 0 {
			t.Error("client not authenticated")
		}
		id, secret, ok := r.BasicAuth()
		if !ok || id != "synthetic-id" || secret != "synthetic-secret" {
			t.Error("bad credentials")
		}
		calls.Add(1)
		oauth(w)
	})
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			token, err := c.accessToken(context.Background())
			if err != nil || token != "synthetic-token" {
				t.Errorf("token: %v", err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("OAuth calls %d", calls.Load())
	}
	c.mu.Lock()
	c.expires = time.Now().Add(-time.Second)
	c.mu.Unlock()
	if _, err := c.accessToken(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatal("expired token not refreshed")
	}
	cfg, _ := labConfig(t)
	cfg.ClientSecret = "rotated"
	replacement, err := NewSandbox(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer replacement.Close()
	if replacement.token != "" || replacement.http.Transport == c.http.Transport {
		t.Fatal("rotation reused old state")
	}
}
func TestSandboxFailsClosed(t *testing.T) {
	cfg, _ := labConfig(t)
	for _, change := range []func(*Config){func(c *Config) { c.Scope.Environment = "production" }, func(c *Config) { c.CertificatePEM = []byte("bad") }, func(c *Config) { c.PrivateKeyPEM = nil }, func(c *Config) { c.ClientSecret = "" }, func(c *Config) { c.Timeout = -time.Second }} {
		bad := cfg
		change(&bad)
		if _, err := NewSandbox(bad); err == nil {
			t.Fatal("bad config accepted")
		}
	}
	if providers.Executable(cfg.Scope, true) {
		t.Fatal("real adapter activated")
	}
}
func TestOAuthMalformedAndRedirect(t *testing.T) {
	for _, body := range []string{`not-json`, `{}`, `{"access_token":"secret","token_type":"Bearer","expires_in":0}`, `{"access_token":"secret","token_type":"wrong","expires_in":3600}`, `{"access_token":"secret","token_type":"Bearer","expires_in":9223372036854775807}`} {
		c, _ := labClient(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) })
		if _, err := c.accessToken(context.Background()); err == nil {
			t.Fatal("bad OAuth accepted")
		}
	}
	var destination atomic.Int64
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { destination.Add(1) }))
	defer other.Close()
	c, _ := labClient(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, other.URL, 307) })
	if _, err := c.accessToken(context.Background()); err == nil {
		t.Fatal("redirect followed")
	}
	if destination.Load() != 0 {
		t.Fatal("credentials redirected")
	}
}
func TestPixImmediateWriteLossAndLookup(t *testing.T) {
	var req providers.Create
	var puts atomic.Int64
	c, _ := labClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/oauth/token" {
			oauth(w)
			return
		}
		if r.Header.Get("Authorization") != "Bearer synthetic-token" {
			t.Error("missing bearer")
		}
		if r.URL.Path != "/v2/cob/"+TxID(req) {
			t.Error("wrong txid")
		}
		if r.Method == "PUT" {
			puts.Add(1)
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body["valor"].(map[string]any)["original"] != "123.45" {
				t.Error("money changed")
			}
			w.WriteHeader(500)
			_, _ = w.Write([]byte("SENSITIVE PROVIDER BODY"))
			return
		}
		_ = json.NewEncoder(w).Encode(response(req))
	})
	req = fixture(c)
	a, err := NewImmediate(c, req, "synthetic-pix-key", 3600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = a.CreateCharge(context.Background(), req)
	if err == nil || strings.Contains(err.Error(), "SENSITIVE") || providers.Recovery(err) != "lookup_same_intention" {
		t.Fatalf("unexpected error %v", err)
	}
	// New adapter instance from persisted request: only GET, no automatic PUT retry.
	restarted, _ := NewImmediate(c, req, "synthetic-pix-key", 3600)
	s, err := restarted.Lookup(context.Background(), providers.Reference{Scope: req.Scope, IntentKey: req.IntentKey})
	if err != nil || s.Charge.ID != TxID(req) || puts.Load() != 1 {
		t.Fatalf("lookup %v writes %d", err, puts.Load())
	}
	changed := req
	changed.Money.Cents++
	if _, err = a.CreateCharge(context.Background(), changed); err == nil {
		t.Fatal("changed intent accepted")
	}
}
func TestUnknownResponsesNeverRetryWrite(t *testing.T) {
	for _, status := range []int{401, 404, 409, 429, 500, 503} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var writes atomic.Int64
			c, _ := labClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/oauth/token" {
					oauth(w)
					return
				}
				writes.Add(1)
				w.Header().Set("Retry-After", "7")
				w.WriteHeader(status)
			})
			req := fixture(c)
			a, _ := NewImmediate(c, req, "synthetic-pix-key", 3600)
			_, err := a.CreateCharge(context.Background(), req)
			var failure *providers.Failure
			if !errors.As(err, &failure) || writes.Load() != 1 {
				t.Fatalf("error %v writes %d", err, writes.Load())
			}
			if status == 429 && failure.RetryAfter != 7*time.Second {
				t.Fatal("retry hint lost")
			}
			if status == 401 && c.token != "" {
				t.Fatal("rejected token cached")
			}
		})
	}
}
func TestPixResponseRequiresIdentityMoneyAndPaymentDetails(t *testing.T) {
	cfg, _ := labConfig(t)
	c, err := NewSandbox(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	req := fixture(c)
	a, _ := NewImmediate(c, req, "synthetic-pix-key", 3600)
	for _, mutate := range []func(map[string]any){func(v map[string]any) { v["txid"] = "other" }, func(v map[string]any) { v["chave"] = "other-account" }, func(v map[string]any) { v["valor"] = map[string]string{"original": "123.451"} }, func(v map[string]any) { v["status"] = "CONCLUIDA" }, func(v map[string]any) { v["status"] = "UNKNOWN" }} {
		data := response(req)
		mutate(data)
		raw, _ := json.Marshal(data)
		var v pixCharge
		_ = json.Unmarshal(raw, &v)
		if _, err := a.normalized(v); err == nil {
			t.Fatal("invalid response accepted")
		}
	}
	for _, value := range []string{"NaN", "1e2", "1.001", "-1.00", "0.00", "21474836.48", "01.00"} {
		if _, err := cents(value); err == nil {
			t.Fatalf("bad amount %s", value)
		}
	}
	data := response(req)
	data["status"] = "CONCLUIDA"
	data["pix"] = []any{map[string]any{"endToEndId": "synthetic-e2e", "txid": TxID(req), "valor": "123.45", "horario": "2026-10-26T12:00:00Z"}}
	raw, _ := json.Marshal(data)
	var v pixCharge
	_ = json.Unmarshal(raw, &v)
	s, err := a.normalized(v)
	if err != nil || len(s.Payments) != 1 {
		t.Fatalf("valid payment %v", err)
	}
}

func TestTLSVerificationCannotBeBypassedByConfiguration(t *testing.T) {
	c, _ := labClient(t, func(w http.ResponseWriter, r *http.Request) { oauth(w) })
	c.http.Transport.(*http.Transport).TLSClientConfig.RootCAs = x509.NewCertPool()
	if _, err := c.accessToken(context.Background()); err == nil {
		t.Fatal("untrusted server accepted")
	}
	missing, _ := labClient(t, func(w http.ResponseWriter, r *http.Request) { oauth(w) })
	missing.http.Transport.(*http.Transport).TLSClientConfig.Certificates = nil
	if _, err := missing.accessToken(context.Background()); err == nil {
		t.Fatal("missing client cert accepted")
	}
}

func TestCanceledWriteAndMalformedSuccessRemainUnknown(t *testing.T) {
	for _, mode := range []string{"cancel-after-effect", "truncated", "oversized"} {
		t.Run(mode, func(t *testing.T) {
			entered := make(chan struct{})
			release := make(chan struct{})
			var writes atomic.Int64
			c, _ := labClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/oauth/token" {
					oauth(w)
					return
				}
				writes.Add(1)
				if mode == "cancel-after-effect" {
					close(entered)
					<-release
					return
				}
				if mode == "truncated" {
					_, _ = w.Write([]byte(`{"txid":`))
					return
				}
				_, _ = w.Write([]byte(strings.Repeat("x", maxBody+1)))
			})
			req := fixture(c)
			a, _ := NewImmediate(c, req, "synthetic-pix-key", 3600)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan error, 1)
			go func() { _, err := a.CreateCharge(ctx, req); result <- err }()
			if mode == "cancel-after-effect" {
				<-entered
				cancel()
				close(release)
			}
			err := <-result
			var f *providers.Failure
			if !errors.As(err, &f) || f.Kind != providers.Unknown || writes.Load() != 1 {
				t.Fatalf("%v writes %d", err, writes.Load())
			}
		})
	}
}

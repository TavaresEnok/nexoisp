// Package psphook receives Pix callbacks on a dedicated verified mTLS listener.
// The public application listener never trusts forwarded client-cert headers.
package psphook

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"github.com/google/uuid"
	"io"
	"net/http"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance"
	"os"
	"time"
)

type Receiver func(context.Context, string, []byte) (finance.NoticeOutcome, error)

func TLSConfig(cert tls.Certificate, providerBundle []byte) (*tls.Config, error) {
	roots := x509.NewCertPool()
	pins := map[[32]byte]bool{}
	for len(providerBundle) > 0 {
		block, rest := pem.Decode(providerBundle)
		if block == nil {
			break
		}
		providerBundle = rest
		if block.Type != "CERTIFICATE" {
			continue
		}
		c, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, errors.New("invalid provider callback certificate")
		}
		roots.AddCert(c)
		pins[sha256.Sum256(c.RawSubjectPublicKeyInfo)] = true
	}
	if len(pins) == 0 || len(cert.Certificate) == 0 || cert.PrivateKey == nil {
		return nil, errors.New("server certificate and pinned provider certificate bundle required")
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: roots, VerifyConnection: func(state tls.ConnectionState) error {
		if len(state.VerifiedChains) == 0 || len(state.PeerCertificates) == 0 || !pins[sha256.Sum256(state.PeerCertificates[0].RawSubjectPublicKeyInfo)] {
			return errors.New("provider callback client key is not pinned")
		}
		return nil
	}}, nil
}
func Handler(receive Receiver) http.Handler {
	mux := http.NewServeMux()
	handle := func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || len(r.TLS.VerifiedChains) == 0 {
			apierr.Write(w, apierr.New(403, "callback exige mTLS verificado"))
			return
		}
		connection := r.PathValue("connection")
		if _, err := uuid.Parse(connection); err != nil {
			apierr.Write(w, apierr.New(400, "conexão inválida"))
			return
		}
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 512<<10))
		if err != nil {
			apierr.Write(w, apierr.New(413, "callback excede o limite"))
			return
		}
		// Efí probes the registered base URL, then appends /pix for real notices.
		if r.PathValue("kind") == "probe" {
			var body map[string]json.RawMessage
			if len(raw) == 0 || (json.Unmarshal(raw, &body) == nil && body["pix"] == nil) {
				raw = nil
			}
		}
		result, err := receive(r.Context(), connection, raw)
		if err != nil {
			apierr.Write(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	}
	mux.HandleFunc("POST /callbacks/efi/{connection}/pix", handle)
	mux.HandleFunc("POST /callbacks/efi/{connection}", func(w http.ResponseWriter, r *http.Request) { r.SetPathValue("kind", "probe"); handle(w, r) })
	return mux
}
func Server(database *db.DB) (*http.Server, error) {
	addr := os.Getenv("NEXO_GO_EFI_WEBHOOK_ADDR")
	if addr == "" {
		return nil, nil
	}
	if !finance.EFISandboxEnabled() {
		return nil, errors.New("Efí callback listener requires explicit sandbox enablement")
	}
	cert, err := tls.LoadX509KeyPair(os.Getenv("NEXO_GO_EFI_WEBHOOK_CERT"), os.Getenv("NEXO_GO_EFI_WEBHOOK_KEY"))
	if err != nil {
		return nil, errors.New("callback server certificate/key invalid")
	}
	bundle, err := os.ReadFile(os.Getenv("NEXO_GO_EFI_WEBHOOK_PROVIDER_CERTS"))
	if err != nil {
		return nil, errors.New("callback provider certificate pins unavailable")
	}
	config, err := TLSConfig(cert, bundle)
	if err != nil {
		return nil, err
	}
	receive := func(ctx context.Context, connection string, body []byte) (finance.NoticeOutcome, error) {
		return finance.AcceptPixNotices(ctx, database, connection, body)
	}
	return &http.Server{Addr: addr, Handler: Handler(receive), TLSConfig: config, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}, nil
}

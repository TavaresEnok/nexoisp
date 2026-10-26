package psphook

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"github.com/google/uuid"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"nexoisp/api-go/internal/finance"
	"sync/atomic"
	"testing"
	"time"
)

func issue(t *testing.T, ca *x509.Certificate, caKey *ecdsa.PrivateKey, serial int64, server bool) (tls.Certificate, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: "synthetic-callback"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature}
	if server {
		cert.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
		cert.IPAddresses = []net.IP{net.ParseIP("127.0.0.1")}
	} else {
		cert.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
	}
	der, err := x509.CreateCertificate(rand.Reader, cert, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	pair, err := tls.X509KeyPair(certPEM, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private}))
	if err != nil {
		t.Fatal(err)
	}
	return pair, certPEM
}
func TestCallbackRequiresVerifiedPinnedMTLS(t *testing.T) {
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "synthetic-ca"}, IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	ca, err = x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	root := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	server, _ := issue(t, ca, caKey, 2, true)
	bank, bankPEM := issue(t, ca, caKey, 3, false)
	outsider, _ := issue(t, ca, caKey, 4, false)
	config, err := TLSConfig(server, append(append([]byte{}, bankPEM...), root...))
	if err != nil {
		t.Fatal(err)
	}
	var received atomic.Int64
	handler := Handler(func(context.Context, string, []byte) (finance.NoticeOutcome, error) {
		received.Add(1)
		return finance.NoticeOutcome{Received: 1}, nil
	})
	srv := httptest.NewUnstartedServer(handler)
	srv.TLS = config
	srv.StartTLS()
	defer srv.Close()
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(root)
	makeClient := func(cert *tls.Certificate) *http.Client {
		cfg := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}
		if cert != nil {
			cfg.Certificates = []tls.Certificate{*cert}
		}
		transport := &http.Transport{TLSClientConfig: cfg}
		t.Cleanup(transport.CloseIdleConnections)
		return &http.Client{Transport: transport, Timeout: time.Second}
	}
	path := "/callbacks/efi/" + uuid.NewString() + "/pix"
	for _, bad := range []*tls.Certificate{nil, &outsider} {
		r, e := makeClient(bad).Post(srv.URL+path, "application/json", bytes.NewBufferString(`{"pix":[]}`))
		if e == nil {
			r.Body.Close()
			t.Fatal("unpinned client reached callback")
		}
	}
	response, err := makeClient(&bank).Post(srv.URL+path, "application/json", bytes.NewBufferString(`{"pix":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 || received.Load() != 1 {
		t.Fatal("pinned callback not accepted")
	}
	// A forged forwarding header on ordinary HTTP is never equivalent to mTLS.
	plain := httptest.NewServer(handler)
	defer plain.Close()
	req, _ := http.NewRequest("POST", plain.URL+path, bytes.NewBufferString(`{"pix":[]}`))
	req.Header.Set("X-SSL-Client-Verify", "SUCCESS")
	req.Header.Set("X-Client-Cert", base64.StdEncoding.EncodeToString(bankPEM))
	result, err := plain.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	result.Body.Close()
	if result.StatusCode != 403 || received.Load() != 1 {
		t.Fatal("forwarded header bypassed TLS")
	}
}

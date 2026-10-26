package finance

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers/efi"
	"nexoisp/api-go/internal/tenancy"
)

func syntheticPixCredentials(t *testing.T) PixCredentials {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "synthetic-vault"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return PixCredentials{ClientID: "synthetic-client", ClientSecret: "synthetic-secret", Certificate: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), PrivateKey: string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private})), PixKey: "synthetic-pix-key"}
}
func TestCredentialVaultRotationScopeAndFrozenIntention(t *testing.T) {
	t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	d, scope := issuanceDatabase(t)
	r := issuanceFixture(t, d, scope)
	ctx := context.Background()
	p := syntheticPixCredentials(t)
	var user string
	if err := d.WithScope(ctx, scope, func(tx *db.Tx) error { return tx.QueryRow(ctx, `select id from users order by id limit 1`).Scan(&user) }); err != nil {
		t.Fatal(err)
	}
	save := func(value PixCredentials) CredentialMetadata {
		t.Helper()
		var m CredentialMetadata
		err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			var e error
			m, e = SavePixCredentials(ctx, tx, r.Scope.ConnectionID, user, value)
			return e
		})
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	first := save(p)
	client, _, err := LoadCredentialClient(ctx, d, scope, r.Scope.ConnectionID, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	adapter, err := efi.NewImmediate(client, r, p.PixKey, 3600)
	if err != nil {
		t.Fatal(err)
	}
	item, err := (SandboxIssuance{DB: d}).PrepareWithCredential(ctx, scope, r, adapter.ConfigurationHash(), first.ID)
	if err != nil {
		t.Fatal(err)
	}
	rotated := p
	rotated.ClientSecret = "synthetic-rotated-secret"
	rotated.PixKey = "synthetic-new-pix-key"
	second := save(rotated)
	if first.ID == second.ID || second.Version != first.Version+1 {
		t.Fatal("credential versions not monotonic")
	}
	newClient, oldSemantics, err := LoadCredentialClient(ctx, d, scope, r.Scope.ConnectionID, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer newClient.Close()
	if oldSemantics.PixKey != p.PixKey {
		t.Fatal("rotation changed old intention's key")
	}
	recovered, err := efi.NewImmediate(newClient, r, oldSemantics.PixKey, 3600)
	if err != nil || recovered.ConfigurationHash() != adapter.ConfigurationHash() {
		t.Fatalf("rotation changed frozen payment semantics %v", err)
	}
	if _, err = (SandboxIssuance{DB: d}).PrepareWithCredential(ctx, scope, r, adapter.ConfigurationHash(), second.ID); err == nil {
		t.Fatal("old intention switched credential identity")
	}
	err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var id string
		return tx.QueryRow(ctx, `select credential_version_id from provider_issuance where id=$1`, item.ID).Scan(&id)
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, denied := range []tenancy.Scope{{TenantID: scope.TenantID, SubscriberID: uuid.NewString()}, {TenantID: scope.TenantID, PopIDs: []string{uuid.NewString()}}} {
		if err = d.WithScope(ctx, denied, func(tx *db.Tx) error {
			var ciphertext *string
			if e := tx.QueryRow(ctx, `select financial_credential_ciphertext($1)`, first.ID).Scan(&ciphertext); e != nil {
				return e
			}
			if ciphertext != nil {
				t.Error("ciphertext leaked through definer")
			}
			list, e := ListCredentials(ctx, tx, r.Scope.ConnectionID)
			if len(list) != 0 {
				t.Error("metadata leaked")
			}
			return e
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error { return tx.Exec(ctx, `select secret_enc from financial_credential_versions`) }); err == nil {
		t.Fatal("raw ciphertext column readable by application")
	}
	// Even a copied encrypted blob cannot be read under another account/version.
	other := issuanceFixture(t, d, scope)
	forged := uuid.NewString()
	err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.Exec(ctx, `insert into financial_credential_versions(id,tenant_id,financial_connection_id,version,kind,secret_enc,certificate_sha256,certificate_expires_at,created_by) values($1,$2,$3,1,'efi_pix',financial_credential_ciphertext($4),$5,$6,$7)`, forged, scope.TenantID, other.Scope.ConnectionID, first.ID, first.Fingerprint, first.Expires, user)
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error { _, e := ReadPixCredentials(ctx, tx, other.Scope, forged); return e }); err == nil {
		t.Fatal("ciphertext accepted under another binding")
	}
	for _, bad := range []PixCredentials{{}, {ClientID: "synthetic", ClientSecret: "x", Certificate: "INVALID-SENSITIVE", PrivateKey: p.PrivateKey, PixKey: p.PixKey}} {
		err = d.WithScope(ctx, scope, func(tx *db.Tx) error { _, e := SavePixCredentials(ctx, tx, r.Scope.ConnectionID, user, bad); return e })
		if err == nil || strings.Contains(err.Error(), "INVALID-SENSITIVE") {
			t.Fatal("invalid credential accepted/leaked")
		}
	}
	t.Setenv("NEXO_SECRET_KEY", "")
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error { _, e := SavePixCredentials(ctx, tx, r.Scope.ConnectionID, user, p); return e }); err == nil {
		t.Fatal("credentials stored with ephemeral encryption key")
	}
}

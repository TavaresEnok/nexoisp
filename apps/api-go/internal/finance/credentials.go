package finance

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/finance/providers/efi"
	"nexoisp/api-go/internal/tenancy"
)

type PixCredentials struct {
	Kind         string `json:"kind,omitempty"`
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	Certificate  string `json:"certificate_pem"`
	PrivateKey   string `json:"private_key_pem"`
	PixKey       string `json:"pix_key"`
}
type CredentialMetadata struct {
	ID          string     `json:"id"`
	Version     int        `json:"version"`
	Kind        string     `json:"kind"`
	Fingerprint string     `json:"certificate_sha256"`
	Expires     *time.Time `json:"certificate_expires_at,omitempty"`
	Current     bool       `json:"current"`
}
type credentialEnvelope struct {
	Binding string         `json:"binding"`
	Value   PixCredentials `json:"value"`
}

func credentialBinding(scope providers.Scope, id string) string {
	return scope.TenantID + ":" + scope.ConnectionID + ":" + scope.Provider + ":" + scope.Environment + ":" + scope.AccountRef + ":" + id
}
func connectionScope(ctx context.Context, tx *db.Tx, id string) (providers.Scope, error) {
	var s providers.Scope
	err := tx.QueryRow(ctx, `select id,tenant_id,provider,environment,account_ref from financial_connections where id=$1`, id).Scan(&s.ConnectionID, &s.TenantID, &s.Provider, &s.Environment, &s.AccountRef)
	return s, err
}
func validatePixCredentials(scope providers.Scope, p PixCredentials) (string, time.Time, error) {
	if len(p.ClientID) > 512 || len(p.ClientSecret) > 4096 || len(p.Certificate) > 131072 || len(p.PrivateKey) > 32768 || len(p.PixKey) > 256 || strings.TrimSpace(p.PixKey) == "" {
		return "", time.Time{}, apierr.New(400, "credenciais Pix inválidas")
	}
	c, err := efi.NewSandbox(efi.Config{Scope: scope, ClientID: p.ClientID, ClientSecret: p.ClientSecret, CertificatePEM: []byte(p.Certificate), PrivateKeyPEM: []byte(p.PrivateKey)})
	if err != nil {
		return "", time.Time{}, apierr.New(400, "credenciais ou certificado Pix sandbox inválidos")
	}
	c.Close()
	cert, err := tls.X509KeyPair([]byte(p.Certificate), []byte(p.PrivateKey))
	if err != nil {
		return "", time.Time{}, apierr.New(400, "par de certificado inválido")
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return "", time.Time{}, apierr.New(400, "certificado inválido")
	}
	digest := sha256.Sum256(cert.Certificate[0])
	return hex.EncodeToString(digest[:]), leaf.NotAfter, nil
}

// SaveFinancialCredentials stores a new encrypted version, validates locally without
// contacting Efí, and changes only the connection's current version pointer.
func SaveFinancialCredentials(ctx context.Context, tx *db.Tx, connection, user string, p PixCredentials) (CredentialMetadata, error) {
	var meta CredentialMetadata
	if os.Getenv("NEXO_SECRET_KEY") == "" {
		return meta, apierr.New(409, "configure a chave persistente do cofre antes de cadastrar credenciais")
	}
	var locked string
	if err := tx.QueryRow(ctx, `select id from financial_connections where id=$1 for update`, connection).Scan(&locked); err != nil {
		return meta, err
	}
	scope, err := connectionScope(ctx, tx, connection)
	if err != nil {
		return meta, err
	}
	if p.Kind == "" {
		p.Kind = "efi_pix"
	}
	var priorKind string
	if err = tx.QueryRow(ctx, `select coalesce(v.kind,'') from financial_connections c left join financial_credential_versions v on v.id=c.credential_version_id where c.id=$1`, connection).Scan(&priorKind); err != nil {
		return meta, err
	}
	if priorKind != "" && priorKind != p.Kind {
		return meta, apierr.New(409, "cadastre conexão própria para outra API de cobrança")
	}

	var fingerprint string
	var expiry *time.Time
	switch p.Kind {
	case "efi_pix":
		fp, date, e := validatePixCredentials(scope, p)
		if e != nil {
			return meta, e
		}
		fingerprint = fp
		expiry = &date
	case "efi_charges":
		if p.Certificate != "" || p.PrivateKey != "" || p.PixKey != "" || len(p.ClientID) > 512 || len(p.ClientSecret) > 4096 {
			return meta, apierr.New(400, "credenciais Cobranças incompatíveis com Pix")
		}
		c, e := efi.NewChargesSandbox(scope, p.ClientID, p.ClientSecret, 0)
		if e != nil {
			return meta, apierr.New(400, "credenciais Cobranças sandbox inválidas")
		}
		c.Close()
	default:
		return meta, apierr.New(400, "tipo de credencial não suportado")
	}
	id := uuid.NewString()
	plain, err := json.Marshal(credentialEnvelope{Binding: credentialBinding(scope, id), Value: p})
	if err != nil {
		return meta, err
	}
	encrypted, err := cryptox.EncryptSecret(string(plain))
	if err != nil {
		return meta, errors.New("financial credential encryption failed")
	}
	if err = tx.QueryRow(ctx, `insert into financial_credential_versions(id,tenant_id,financial_connection_id,version,kind,secret_enc,certificate_sha256,certificate_expires_at,created_by)
 select $1,$2,$3,coalesce(max(version),0)+1,$8,$4,$5,$6,$7 from financial_credential_versions where financial_connection_id=$3
 returning id,version,kind,certificate_sha256,certificate_expires_at`, id, scope.TenantID, connection, encrypted, fingerprint, expiry, user, p.Kind).Scan(&meta.ID, &meta.Version, &meta.Kind, &meta.Fingerprint, &meta.Expires); err != nil {
		return meta, err
	}
	if err = tx.Exec(ctx, `update financial_connections set credential_version_id=$2 where id=$1`, connection, id); err != nil {
		return meta, err
	}
	meta.Current = true
	return meta, nil
}
func ReadPixCredentials(ctx context.Context, tx *db.Tx, scope providers.Scope, id string) (PixCredentials, error) {
	var out PixCredentials
	var cipher *string
	if err := tx.QueryRow(ctx, `select financial_credential_ciphertext(v.id) from financial_credential_versions v where v.id=$1 and v.financial_connection_id=$2`, id, scope.ConnectionID).Scan(&cipher); err != nil {
		return out, err
	}
	if cipher == nil {
		return out, errors.New("financial credential unavailable in scope")
	}
	plain, err := cryptox.DecryptSecret(*cipher)
	if err != nil {
		return out, errors.New("financial credential cannot be decrypted")
	}
	var envelope credentialEnvelope
	if err = json.Unmarshal([]byte(plain), &envelope); err != nil || envelope.Binding != credentialBinding(scope, id) {
		return out, errors.New("financial credential identity mismatch")
	}
	return envelope.Value, nil
}
func ListCredentials(ctx context.Context, tx *db.Tx, connection string) ([]CredentialMetadata, error) {
	rows, err := tx.Objects(ctx, `select v.id,v.version,v.kind,v.certificate_sha256,v.certificate_expires_at,c.credential_version_id=v.id as current from financial_credential_versions v join financial_connections c on c.id=v.financial_connection_id where c.id=$1 order by v.version desc`, connection)
	if err != nil {
		return nil, err
	}
	out := make([]CredentialMetadata, 0, len(rows))
	for _, r := range rows {
		raw, e := json.Marshal(r)
		if e != nil {
			return nil, e
		}
		var m CredentialMetadata
		if e = json.Unmarshal(raw, &m); e != nil {
			return nil, e
		}
		out = append(out, m)
	}
	return out, nil
}

// LoadCredentialClient preserves the frozen version's payment semantics while
// authenticating transport with the current version. Rotation does not rewrite debt.
func LoadCredentialClient(ctx context.Context, database *db.DB, scope tenancy.Scope, connection, version string) (*efi.Client, PixCredentials, error) {
	var cfg, transportCfg PixCredentials
	var bound providers.Scope
	err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
		var e error
		bound, e = connectionScope(ctx, tx, connection)
		if e != nil {
			return e
		}
		cfg, e = ReadPixCredentials(ctx, tx, bound, version)
		if e != nil {
			return e
		}
		var active string
		if e = tx.QueryRow(ctx, `select credential_version_id from financial_connections where id=$1`, connection).Scan(&active); e != nil {
			return e
		}
		transportCfg, e = ReadPixCredentials(ctx, tx, bound, active)
		return e
	})
	if err != nil {
		return nil, PixCredentials{}, err
	}
	// Rotate transport authentication while preserving the old payment semantics
	// (notably Pix key) used to validate the original charge intention.
	var client *efi.Client
	if cfg.Kind != transportCfg.Kind {
		return nil, PixCredentials{}, errors.New("credential API kind changed")
	}
	if cfg.Kind == "efi_charges" {
		client, err = efi.NewChargesSandbox(bound, transportCfg.ClientID, transportCfg.ClientSecret, 0)
	} else {
		client, err = efi.NewSandbox(efi.Config{Scope: bound, ClientID: transportCfg.ClientID, ClientSecret: transportCfg.ClientSecret, CertificatePEM: []byte(transportCfg.Certificate), PrivateKeyPEM: []byte(transportCfg.PrivateKey)})
	}
	if err != nil {
		return nil, PixCredentials{}, errors.New("financial client credentials unavailable or expired")
	}
	return client, cfg, nil
}

// Retained internal Pix entry used by the original vault tests and adapters.
func SavePixCredentials(ctx context.Context, tx *db.Tx, connection, user string, p PixCredentials) (CredentialMetadata, error) {
	if p.Kind != "" && p.Kind != "efi_pix" {
		return CredentialMetadata{}, apierr.New(400, "credencial Pix requerida")
	}
	return SaveFinancialCredentials(ctx, tx, connection, user, p)
}

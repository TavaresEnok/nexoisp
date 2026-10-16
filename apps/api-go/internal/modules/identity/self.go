package identity

import (
	"context"
	"fmt"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
	"strings"
)

func (s Service) self(ctx context.Context, key string, b map[string]any) (endpoint.Result, error) {
	c := auth.From(ctx)
	var secret string
	var err error
	if key == "POST /api/me/mfa/setup" {
		secret, err = cryptox.NewTOTP()
		if err != nil {
			return endpoint.Result{}, err
		}
	}
	err = s.DB.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		u, err := one(ctx, tx, key, 0, c.UserID)
		if err != nil {
			return err
		}
		if u == nil {
			return fmt.Errorf("usuário da sessão não encontrado")
		}
		switch key {
		case "POST /api/me/password":
			if !cryptox.VerifyPassword(b["current"].(string), u.Get("password_hash").(string)) {
				return apierr.New(400, "senha atual incorreta")
			}
			hash, err := cryptox.HashPassword(b["next"].(string))
			if err != nil {
				return err
			}
			if err = tx.Exec(ctx, query(key, 1), c.UserID, hash); err != nil {
				return err
			}
			return tx.Exec(ctx, query(key, 2), c.UserID, c.TokenHash)
		case "POST /api/me/mfa/setup":
			if u.Get("mfa_enabled") == true {
				return apierr.New(400, "verificação em duas etapas já está ativa")
			}
			encrypted, err := cryptox.EncryptSecret(secret)
			if err != nil {
				return err
			}
			return tx.Exec(ctx, query(key, 1), c.UserID, encrypted)
		case "POST /api/me/mfa/enable":
			if u.Get("mfa_secret_enc") == nil || u.Get("mfa_secret_enc") == "" {
				return apierr.New(400, "inicie a configuração primeiro")
			}
			decrypted, err := cryptox.DecryptSecret(u.Get("mfa_secret_enc").(string))
			if err != nil {
				return err
			}
			if !cryptox.CheckTOTP(b["code"].(string), decrypted) {
				return apierr.New(400, "código incorreto")
			}
			if err = tx.Exec(ctx, query(key, 1), c.UserID); err != nil {
				return err
			}
			return tx.Exec(ctx, query(key, 2), c.UserID, c.TokenHash)
		case "POST /api/me/mfa/disable":
			valid := u.Get("mfa_enabled") == true && cryptox.VerifyPassword(b["password"].(string), u.Get("password_hash").(string))
			if valid {
				decrypted, err := cryptox.DecryptSecret(u.Get("mfa_secret_enc").(string))
				if err != nil {
					return err
				}
				valid = cryptox.CheckTOTP(b["code"].(string), decrypted)
			}
			if !valid {
				return apierr.New(400, "senha ou código incorretos")
			}
			return tx.Exec(ctx, query(key, 1), c.UserID)
		}
		return fmt.Errorf("operação de conta desconhecida")
	})
	if err != nil {
		return endpoint.Result{}, err
	}
	if key == "POST /api/me/mfa/setup" {
		return endpoint.Result{Value: map[string]any{"secret": secret, "otpauth_url": cryptox.TOTPURI(c.Email, secret)}}, nil
	}
	action := "user.password_change"
	if strings.HasSuffix(key, "/enable") {
		action = "user.mfa_enable"
	} else if strings.HasSuffix(key, "/disable") {
		action = "user.mfa_disable"
	}
	return endpoint.Result{Value: map[string]any{"ok": true}}, s.Audit.Write(ctx, c, action, "user", c.UserID, nil, "ok")
}
func (s Service) support(ctx context.Context, key string, b map[string]any) (endpoint.Result, error) {
	c := auth.From(ctx)
	if c.Role != "saas_operator" {
		return endpoint.Result{}, apierr.New(403, "sem permissão")
	}
	if key == "POST /api/support/exit" {
		if c.Support {
			if err := s.Audit.Write(ctx, c, "support.exit", "tenant", c.TenantID, nil, "ok"); err != nil {
				return endpoint.Result{}, err
			}
		}
		err := s.DB.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error { return tx.Exec(ctx, query(key, 0), c.TokenHash) })
		return endpoint.Result{Value: map[string]any{"ok": true}}, err
	}
	scope, err := tenancy.OperatorScope("gerenciar_provedores")
	if err != nil {
		return endpoint.Result{}, err
	}
	err = s.DB.WithScope(ctx, scope, func(tx *db.Tx) error {
		t, err := one(ctx, tx, key, 0, b["tenant_id"])
		if err != nil {
			return err
		}
		if t == nil {
			return apierr.New(404, "provedor não encontrado")
		}
		if err = tx.Exec(ctx, query(key, 1), c.TokenHash, b["tenant_id"]); err != nil {
			return err
		}
		raw, err := jsonx.Encode(map[string]any{"reason": b["reason"], "operator": c.Email})
		if err != nil {
			return err
		}
		return tx.Exec(ctx, query(key, 2), b["tenant_id"], c.UserID, raw)
	})
	return endpoint.Result{Value: map[string]any{"ok": true}}, err
}

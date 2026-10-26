package finance

import (
	"context"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"os"
)

// Only an authenticated caller may pass a connection to Event. This directory
// lookup is for webhook authentication; its secret is never an API response.
func LookupConnection(ctx context.Context, database *db.DB, id string) (jsonx.Object, error) {
	rows, _, err := database.Lookup(ctx, "select * from financial_connection_lookup($1)", id)
	if err != nil {
		return nil, err
	}
	if len(rows) != 1 {
		return nil, apierr.New(404, "conexão financeira não encontrada")
	}
	return rows[0], nil
}
func ConnectionSecret(c jsonx.Object) (string, error) {
	if encoded := jsonx.String(c.Get("webhook_secret_enc")); encoded != "" {
		return cryptox.DecryptSecret(encoded)
	}
	if c.Get("legacy_demo") == true && Demo(c.Get("provider")) {
		return os.Getenv("NEXO_GATEWAY_WEBHOOK_SECRET"), nil
	}
	return "", nil
}
func DemoConnection(ctx context.Context, tx *db.Tx, tenant string, company any) (string, error) {
	rows, err := tx.Objects(ctx, `select id,status from financial_connections where tenant_id=$1 and company_id is not distinct from $2::uuid and provider='demo' and environment='sandbox' and is_default`, tenant, company)
	if err != nil {
		return "", err
	}
	if len(rows) == 0 {
		// On-demand equivalent of the explicit legacy-demo backfill, solely in demo.
		if !Demo("demo") {
			return "", apierr.New(409, "gateway demonstrativo desabilitado")
		}
		rows, err = tx.Objects(ctx, `insert into financial_connections(tenant_id,company_id,provider,environment,account_ref,name,status,is_default,legacy_demo) values($1,$2,'demo','sandbox','legacy-demo','Demonstração local','active',true,true) on conflict do nothing returning id,status`, tenant, company)
		if err != nil {
			return "", err
		}
		if len(rows) == 0 {
			rows, err = tx.Objects(ctx, `select id,status from financial_connections where tenant_id=$1 and company_id is not distinct from $2::uuid and provider='demo' and environment='sandbox' and is_default`, tenant, company)
		}
	}
	if err != nil {
		return "", err
	}
	if len(rows) != 1 || rows[0].Get("status") != "active" {
		return "", apierr.New(409, "conexão demonstrativa padrão indisponível")
	}
	return jsonx.String(rows[0].Get("id")), nil
}

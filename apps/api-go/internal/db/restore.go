package db

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"nexoisp/api-go/internal/cryptox"
	"os"
)

// verifyRestore runs only against a temporary restored database, never rotates
// credentials and never prints plaintext, hashes or identifiers.
func verifyRestore(ctx context.Context, c *sql.DB, out io.Writer) error {
	tx, err := c.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	count := 0
	for _, field := range [][2]string{{"service_resources", "secret_enc"}, {"users", "mfa_secret_enc"}, {"webhook_endpoints", "secret_enc"}, {"notice_channels", "headers_enc"}, {"financial_connections", "webhook_secret_enc"}, {"financial_credential_versions", "secret_enc"}} {
		rows, err := tx.QueryContext(ctx, "select "+field[1]+" from "+field[0]+" where "+field[1]+" is not null")
		if err != nil {
			return err
		}
		for rows.Next() {
			var stored string
			if err = rows.Scan(&stored); err == nil {
				_, err = cryptox.DecryptSecret(stored)
			}
			if err != nil {
				rows.Close()
				return fmt.Errorf("chave incompatível ou segredo inválido em %s", field[0])
			}
			count++
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
	}
	radiusCount := 0
	for _, table := range []string{"radius_account", "l2tp_peers"} {
		var n int
		// Only the length leaves PostgreSQL; the secret is never returned/logged.
		err = tx.QueryRowContext(ctx, "select count(length(pgp_sym_decrypt(secret_enc,$1))) from "+table, os.Getenv("NEXO_RADIUS_KEY")).Scan(&n)
		if err != nil {
			return fmt.Errorf("chave RADIUS incompatível ou segredo inválido em %s", table)
		}
		radiusCount += n
	}
	fmt.Fprintf(out, "verify-restore: %d segredos AES e %d segredos RADIUS conferidos sem alteração\n", count, radiusCount)
	return nil
}

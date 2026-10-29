// Fixtures administrativas B15 do laboratório. O servidor HTTP não importa
// este pacote. A conexão fica aqui; não há executor SQL nem callback genérico.
package labtest

import (
	"context"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// FixtureFamily é a família de marcadores que a limpeza pode atingir.
type FixtureFamily string

const (
	// FamilyCloudGate limita a limpeza aos nomes e títulos "cgGate %".
	FamilyCloudGate FixtureFamily = "cgGate"
	// FamilyCloudJournal limita a limpeza à conta "cjJournal %" e à janela fixa do journal.
	FamilyCloudJournal FixtureFamily = "cjJournal"
)

const (
	tenantConfigSQL = `select set_config('app.tenant_id', $1, true)`

	gateAccountSQL     = `delete from cloud_accounts where id = $1::uuid and tenant_id = $2::uuid and name like 'cgGate %'`
	gateMaintenanceSQL = `delete from maintenance_notices where id = $1::uuid and tenant_id = $2::uuid and title like 'cgGate %'`

	journalAccountSQL     = `delete from cloud_accounts where id = $1::uuid and tenant_id = $2::uuid and name like 'cjJournal %'`
	journalMaintenanceSQL = `delete from maintenance_notices where id = $1::uuid and tenant_id = $2::uuid and title = 'cjJournal janela' and message = 'aviso interno de manutencao'`

	exclusiveInsertSQL = `insert into tenants (id, name, slug) values ($1::uuid, 'cjJournal escopo', $2)`
	exclusiveCheckSQL  = `select
			(select count(*) from tenant_cells where tenant_id = $1::uuid),
			(select count(*) from notice_log where tenant_id = $1::uuid and status = 'queued')`
	exclusiveDetachSQL = `delete from tenant_cells tc using tenants t
			where tc.tenant_id = t.id and t.id = $1::uuid and t.slug = $2 and t.name = 'cjJournal escopo'`
)

var exclusiveTenantID = regexp.MustCompile(`^ffffffff-ffff-4fff-bfff-([0-9a-f]{12})$`)

type sessionTone int

const (
	toneGate sessionTone = iota
	toneJournal
)

// DeleteOwnCloudFixture apaga a conta e/ou o aviso de manutenção desta fixture.
// ownerURL é o papel nexo_owner em nexo_test no host local. runtimeURL não pode
// ser a mesma sessão. IDs vazios não abrem conexão. Não apaga payments, notice_log nem tenants.
func DeleteOwnCloudFixture(ctx context.Context, ownerURL, runtimeURL string, family FixtureFamily, tenantID, accountID, maintenanceID string) error {
	return deleteOwnCloudFixture(ctx, ownerURL, runtimeURL, family, tenantID, accountID, maintenanceID, dialOwner)
}

// InsertExclusiveJournalTenant insere o tenant exclusivo do journal e confirma
// uma célula e zero notice_log queued. O id tem de ser o prefixo fixo da fixture.
func InsertExclusiveJournalTenant(ctx context.Context, ownerURL, runtimeURL, tenantID, slug string) error {
	return insertExclusiveJournalTenant(ctx, ownerURL, runtimeURL, tenantID, slug, dialOwner)
}

// DetachExclusiveJournalTenant remove só a tenant_cells do escopo exclusivo.
// A linha de tenants permanece. Payments e filas de outros tenants não entram no comando.
func DetachExclusiveJournalTenant(ctx context.Context, ownerURL, runtimeURL, tenantID, slug string) error {
	return detachExclusiveJournalTenant(ctx, ownerURL, runtimeURL, tenantID, slug, dialOwner)
}

func deleteOwnCloudFixture(ctx context.Context, ownerURL, runtimeURL string, family FixtureFamily, tenantID, accountID, maintenanceID string, dial func(context.Context, *pgx.ConnConfig) (ownerConn, error)) error {
	tone, ok := toneOf(family)
	if !ok {
		return errors.New("família de fixture recusada")
	}
	if _, err := uuid.Parse(tenantID); err != nil {
		return invalidTenant(tone)
	}
	if accountID != "" {
		if _, err := uuid.Parse(accountID); err != nil {
			return invalidAccount(tone)
		}
	}
	if maintenanceID != "" {
		if _, err := uuid.Parse(maintenanceID); err != nil {
			return invalidMaintenance(tone)
		}
	}
	if accountID == "" && maintenanceID == "" {
		return nil
	}
	hold, err := openOwner(ctx, ownerURL, runtimeURL, tone, localOf(tone), dial)
	if err != nil {
		return err
	}
	defer hold.close(ctx)
	if _, err = hold.tx.Exec(ctx, tenantConfigSQL, tenantID); err != nil {
		return hold.scrub(err, "")
	}
	if accountID != "" {
		sqlText := gateAccountSQL
		if tone == toneJournal {
			sqlText = journalAccountSQL
		}
		tag, err := hold.tx.Exec(ctx, sqlText, accountID, tenantID)
		if err != nil {
			return hold.scrub(err, "")
		}
		if tag.RowsAffected() != 1 {
			return accountCount(tone, tag.RowsAffected())
		}
	}
	if maintenanceID != "" {
		sqlText := gateMaintenanceSQL
		if tone == toneJournal {
			sqlText = journalMaintenanceSQL
		}
		tag, err := hold.tx.Exec(ctx, sqlText, maintenanceID, tenantID)
		if err != nil {
			return hold.scrub(err, "")
		}
		if tag.RowsAffected() != 1 {
			return maintenanceCount(tone, tag.RowsAffected())
		}
	}
	if err = hold.tx.Commit(ctx); err != nil {
		return hold.scrub(err, "")
	}
	return nil
}

func insertExclusiveJournalTenant(ctx context.Context, ownerURL, runtimeURL, tenantID, slug string, dial func(context.Context, *pgx.ConnConfig) (ownerConn, error)) error {
	if err := exclusivePair(tenantID, slug); err != nil {
		return err
	}
	hold, err := openOwner(ctx, ownerURL, runtimeURL, toneJournal, cloudJournalLocal, dial)
	if err != nil {
		return err
	}
	defer hold.close(ctx)
	if _, err = hold.tx.Exec(ctx, exclusiveInsertSQL, tenantID, slug); err != nil {
		return hold.scrub(err, "")
	}
	var cells, queued int
	if err = hold.tx.QueryRow(ctx, exclusiveCheckSQL, tenantID).Scan(&cells, &queued); err != nil {
		return hold.scrub(err, "")
	}
	if cells != 1 || queued != 0 {
		return fmt.Errorf("escopo exclusivo inconsistente: cells=%d queued=%d", cells, queued)
	}
	if err = hold.tx.Commit(ctx); err != nil {
		return hold.scrub(err, "")
	}
	return nil
}

func detachExclusiveJournalTenant(ctx context.Context, ownerURL, runtimeURL, tenantID, slug string, dial func(context.Context, *pgx.ConnConfig) (ownerConn, error)) error {
	if err := exclusivePair(tenantID, slug); err != nil {
		return err
	}
	hold, err := openOwner(ctx, ownerURL, runtimeURL, toneJournal, cloudJournalLocal, dial)
	if err != nil {
		return err
	}
	defer hold.close(ctx)
	tag, err := hold.tx.Exec(ctx, exclusiveDetachSQL, tenantID, slug)
	if err != nil {
		return hold.scrub(err, "")
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("limpeza removeu %d tenant_cells", tag.RowsAffected())
	}
	if err = hold.tx.Commit(ctx); err != nil {
		return hold.scrub(err, "")
	}
	return nil
}

type ownerHold struct {
	conn   ownerConn
	tx     ownerTx
	tone   sessionTone
	raw    string
	secret string
}

func (h ownerHold) close(ctx context.Context) {
	if h.tx != nil {
		h.tx.Rollback(ctx)
	}
	if h.conn != nil {
		h.conn.Close(ctx)
	}
}

func (h ownerHold) scrub(err error, journalPrefix string) error {
	if err == nil {
		return nil
	}
	msg := chain(err)
	if secretLeaks(msg, h.raw, h.secret) {
		if h.tone == toneJournal {
			if journalPrefix != "" {
				return errors.New(journalPrefix)
			}
			return errors.New("conexão de preparação recusada")
		}
		return errors.New("conexão de owner do laboratório recusada")
	}
	if h.tone == toneJournal && journalPrefix != "" {
		return fmt.Errorf("%s: %w", journalPrefix, err)
	}
	return err
}

func openOwner(ctx context.Context, ownerURL, runtimeURL string, tone sessionTone, local func(string) bool, dial func(context.Context, *pgx.ConnConfig) (ownerConn, error)) (ownerHold, error) {
	hold := ownerHold{tone: tone, raw: ownerURL}
	if strings.TrimSpace(ownerURL) == "" {
		return ownerHold{}, errors.New(missingOwner(tone))
	}
	if ownerURL == runtimeURL {
		return ownerHold{}, errors.New(sameRuntime(tone))
	}
	cfg, err := pgx.ParseConfig(ownerURL)
	if err != nil {
		return ownerHold{}, errors.New(badURL(tone))
	}
	hold.secret = cfg.Password
	if cfg.Database != labDatabase || cfg.User != labOwner || !local(cfg.Host) {
		return ownerHold{}, errors.New(badDest(tone))
	}
	if cfg.ConnectTimeout <= 0 {
		cfg.ConnectTimeout = 15 * time.Second
	}
	conn, err := dial(ctx, cfg)
	if err != nil {
		return ownerHold{}, hold.scrub(err, connectPrefix(tone))
	}
	hold.conn = conn
	var database, sessionUser, currentUser string
	if err = conn.QueryRow(ctx, identitySQL).Scan(&database, &sessionUser, &currentUser); err != nil {
		hold.close(ctx)
		return ownerHold{}, hold.scrub(err, identityPrefix(tone))
	}
	if database != labDatabase || sessionUser != labOwner || currentUser != labOwner {
		hold.close(ctx)
		return ownerHold{}, badIdentity(tone, database, sessionUser, currentUser)
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		hold.close(ctx)
		return ownerHold{}, hold.scrub(err, "")
	}
	hold.tx = tx
	return hold, nil
}

func toneOf(family FixtureFamily) (sessionTone, bool) {
	switch family {
	case FamilyCloudGate:
		return toneGate, true
	case FamilyCloudJournal:
		return toneJournal, true
	default:
		return 0, false
	}
}

func localOf(tone sessionTone) func(string) bool {
	if tone == toneJournal {
		return cloudJournalLocal
	}
	return cloudGateLoopback
}

func connectPrefix(tone sessionTone) string {
	if tone == toneJournal {
		return "conexão de preparação recusada"
	}
	return ""
}

func identityPrefix(tone sessionTone) string {
	if tone == toneJournal {
		return "identidade de preparação"
	}
	return ""
}

func missingOwner(tone sessionTone) string {
	if tone == toneJournal {
		return "NEXO_GO_TEST_DATABASE_OWNER_URL ausente; a preparação do journal não aprova PostgreSQL e não concede DELETE de cloud_accounts a nexo_app"
	}
	return "NEXO_GO_TEST_DATABASE_OWNER_URL ausente; cloud_accounts ou maintenance_notices da fixture permanecem e o papel nexo_go não recebe DELETE"
}

func sameRuntime(tone sessionTone) string {
	if tone == toneJournal {
		return "URL de preparação coincide com a sessão de produto"
	}
	return "owner recusado; a URL não pode ser a sessão de runtime"
}

func badURL(tone sessionTone) string {
	if tone == toneJournal {
		return "URL de preparação inválida"
	}
	return "URL de owner do laboratório inválida"
}

func badDest(tone sessionTone) string {
	if tone == toneJournal {
		return "URL de preparação recusada; exige host local, banco nexo_test e papel nexo_owner"
	}
	return "owner recusado; limpeza de cloud_accounts e maintenance_notices exige nexo_owner em nexo_test no host local"
}

func invalidTenant(tone sessionTone) error {
	if tone == toneJournal {
		return errors.New("tenant da limpeza inválido")
	}
	return errors.New("tenant da fixture inválido")
}

func invalidAccount(tone sessionTone) error {
	if tone == toneJournal {
		return errors.New("conta da limpeza inválida")
	}
	return errors.New("conta da fixture inválida")
}

func invalidMaintenance(tone sessionTone) error {
	if tone == toneJournal {
		return errors.New("manutenção da limpeza inválida")
	}
	return errors.New("manutenção da fixture inválida")
}

func badIdentity(tone sessionTone, database, sessionUser, currentUser string) error {
	if tone == toneJournal {
		return fmt.Errorf("papel de preparação recusado: database=%s session_user=%s current_user=%s", database, sessionUser, currentUser)
	}
	return errors.New("destino efetivo recusado; limpeza não usa o papel de runtime")
}

func accountCount(tone sessionTone, n int64) error {
	if tone == toneJournal {
		return fmt.Errorf("limpeza removeu %d cloud_accounts", n)
	}
	return errors.New("limpeza de cloud_accounts não removeu exatamente a conta desta fixture")
}

func maintenanceCount(tone sessionTone, n int64) error {
	if tone == toneJournal {
		return fmt.Errorf("limpeza removeu %d maintenance_notices", n)
	}
	return errors.New("limpeza de maintenance_notices não removeu exatamente o aviso desta fixture")
}

func exclusivePair(id, slug string) error {
	match := exclusiveTenantID.FindStringSubmatch(id)
	if match == nil || slug != "cj"+match[1] {
		return errors.New("escopo exclusivo inválido")
	}
	return nil
}

func secretLeaks(msg, raw, secret string) bool {
	if secret != "" && strings.Contains(msg, secret) {
		return true
	}
	if raw != "" && strings.Contains(msg, raw) {
		return true
	}
	return strings.Contains(msg, "://")
}

func cloudGateLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func cloudJournalLocal(host string) bool {
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	switch host {
	case "", "localhost", "127.0.0.1", "::1":
		return true
	}
	if strings.HasPrefix(host, "/") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

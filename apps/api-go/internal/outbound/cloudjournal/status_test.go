package cloudjournal

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/tenancy"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
)

const cjStatusSkip = "NEXO_GO_TEST_DATABASE_URL ausente; skip offline. Este skip não grava cloud_notice_status nem aprova PostgreSQL."

var errCjStatusRollback = errors.New("cjStatus rollback")

func TestCjStatusClosed(t *testing.T) {
	if (UnprovedAuthenticator{}).Proven() {
		t.Fatal("UnprovedAuthenticator aceitou")
	}
	if reflect.TypeOf(UnprovedAuthenticator{}).NumField() != 0 {
		t.Fatal("flag de produção setável")
	}
	if _, ok := any(UnprovedAuthenticator{}).(StatusDecoder); ok {
		t.Fatal("produção implementa decoder")
	}
	if err := (UnprovedAuthenticator{}).Verify(nil, []byte("opaco")); err == nil {
		t.Fatal("Verify de produção aceitou")
	}
	marker := "cjstatus-segredo-5500000000001"
	body := []byte("opaco-" + marker)
	cases := []struct {
		name string
		body []byte
		auth Authenticator
		want error
		call bool
	}{
		{name: "vazio", body: nil, auth: cjStatusGate("cjstatus.one", "obs-a"), want: errStatusShape},
		{name: "acima", body: bytesRepeat(statusBodyMax + 1), auth: &cjStatusDecode{proven: true, decoderProven: true, provider: "cjstatus.one", raw: "obs-a"}, want: errStatusOversize},
		{name: "nulo", body: body, auth: nil, want: errStatusUnproved},
		{name: "unproved", body: body, auth: UnprovedAuthenticator{}, want: errStatusUnproved},
		{name: "verify", body: body, auth: &cjStatusDecode{proven: true, decoderProven: true, refuse: errors.New(marker), provider: "cjstatus.one", raw: "obs-a"}, want: errStatusVerify},
		{name: "sem decoder", body: body, auth: cjStatusPlain{}, want: errStatusDecoder},
		{name: "decoder falso", body: body, auth: &cjStatusDecode{proven: true, provider: "cjstatus.one", raw: "obs-a"}, want: errStatusDecoder},
		{name: "decode", body: body, auth: &cjStatusDecode{proven: true, decoderProven: true, provider: "cjstatus.one", raw: "obs-a", fail: errors.New(marker)}, want: errStatusDecode, call: true},
		{name: "eco", body: []byte("obs-a"), auth: cjStatusGate("cjstatus.one", "obs-a"), want: errStatusShape, call: true},
		{name: "eco id", body: []byte("cjstatus.one"), auth: cjStatusGate("cjstatus.one", "obs-a"), want: errStatusShape, call: true},
		{name: "json", body: []byte(`{"status":"delivered","to":"5500000000001"}`), auth: cjStatusGate("cjstatus.one", "delivered"), want: errStatusTx, call: true},
		{name: "limite", body: bytesRepeat(statusBodyMax), auth: cjStatusGate("cjstatus.one", "obs-a"), want: errStatusTx, call: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			effect, err := AcceptStatus(context.Background(), nil, uuid.NewString(), uuid.NewString(), map[string]string{"X-Test": marker}, tc.body, tc.auth)
			if !errors.Is(err, tc.want) {
				t.Fatalf("erro %v", err)
			}
			if err != nil && strings.Contains(err.Error(), marker) {
				t.Fatal("erro perpetuou o corpo")
			}
			if effect.Applied || effect.Duplicate || effect.MoneyWrites != 0 || effect.Sends != 0 {
				t.Fatalf("effect %+v", effect)
			}
			if decoded, ok := tc.auth.(*cjStatusDecode); ok && decoded.calls > 0 != tc.call {
				t.Fatalf("decoder calls=%d", decoded.calls)
			}
		})
	}
	cjStatusSource(t)
}

func TestCloudJournal_B15_C02(t *testing.T) {
	opened, scope, _ := cjStatusDatabase(t)
	cjStatusTx(t, opened, scope, func(ctx context.Context, tx *db.Tx) error {
		idle, err := cjStatusSeed(ctx, tx, false, "", "")
		if err != nil {
			return err
		}
		body := []byte("cjstatus-opaque-c02-5500000000001")
		effect, err := AcceptStatus(ctx, tx, scope.TenantID, idle.account, nil, body, cjStatusGate(idle.provider, "obs-a"))
		if !errors.Is(err, errStatusAccount) {
			return fmt.Errorf("conta inativa: %v", err)
		}
		if err = cjStatusNeutral(effect, false, false); err != nil {
			return err
		}
		if n, err := cjStatusStatusCount(ctx, tx, idle.account); err != nil || n != 0 {
			return fmt.Errorf("inativa gravou %d %v", n, err)
		}
		row, err := cjStatusSeed(ctx, tx, true, "", "")
		if err != nil {
			return err
		}
		before, err := cjStatusRead(ctx, tx, row.account, row.logID)
		if err != nil {
			return err
		}
		first, err := AcceptStatus(ctx, tx, scope.TenantID, row.account, map[string]string{"X-Test": "um"}, body, cjStatusGate(row.provider, "obs-a"))
		if err != nil {
			return err
		}
		if err = cjStatusNeutral(first, true, false); err != nil {
			return err
		}
		second, err := AcceptStatus(ctx, tx, scope.TenantID, row.account, map[string]string{"X-Test": "dois"}, body, cjStatusGate(row.provider, "obs-b"))
		if err != nil {
			return err
		}
		if err = cjStatusNeutral(second, false, true); err != nil {
			return err
		}
		full := bytesRepeat(statusBodyMax)
		third, err := AcceptStatus(ctx, tx, scope.TenantID, row.account, nil, full, cjStatusGate(row.provider, "obs-c"))
		if err != nil {
			return err
		}
		if err = cjStatusNeutral(third, true, false); err != nil {
			return err
		}
		jsonBody := []byte(`{"messaging_product":"whatsapp","to":"5500000000001","status":"delivered"}`)
		jsonEffect, err := AcceptStatus(ctx, tx, scope.TenantID, row.account, nil, jsonBody, cjStatusGate(row.provider, "delivered"))
		if err != nil {
			return err
		}
		if err = cjStatusNeutral(jsonEffect, true, false); err != nil {
			return err
		}
		unknownBody := []byte("cjstatus-opaque-ausente-5500000000001")
		unknown, err := AcceptStatus(ctx, tx, scope.TenantID, row.account, nil, unknownBody, cjStatusGate("cjstatus.ausente", "obs-z"))
		if !errors.Is(err, errStatusUnknown) {
			return fmt.Errorf("id desconhecido: %v", err)
		}
		if err = cjStatusNeutral(unknown, false, false); err != nil {
			return err
		}
		after, err := cjStatusRead(ctx, tx, row.account, row.logID)
		if err != nil {
			return err
		}
		if after.status != before.status+3 || after.attempts != before.attempts || after.logs != before.logs || after.logStatus != "sent" {
			return fmt.Errorf("journal mudou antes=%+v depois=%+v", before, after)
		}
		if after.payments != before.payments || after.cents != before.cents || after.invoices != before.invoices || after.movements != before.movements || after.effects != before.effects {
			return fmt.Errorf("financeiro mudou")
		}
		raw, provider, hash, n, err := cjStatusStored(ctx, tx, row.account, body)
		if err != nil {
			return err
		}
		if n != 1 || raw != "obs-a" || provider != row.provider || hash != cjStatusHash(body) || strings.Contains(raw, "5500000000001") {
			return fmt.Errorf("observação raw=%s provider=%s linhas=%d", raw, provider, n)
		}
		rawJSON, providerJSON, hashJSON, nJSON, err := cjStatusStored(ctx, tx, row.account, jsonBody)
		if err != nil {
			return err
		}
		if nJSON != 1 || rawJSON != "delivered" || providerJSON != row.provider || hashJSON != cjStatusHash(jsonBody) || strings.Contains(rawJSON, "5500000000001") || strings.Contains(rawJSON, "whatsapp") || strings.Contains(rawJSON, "{") || !strings.Contains(string(jsonBody), "delivered") {
			return fmt.Errorf("json raw=%s provider=%s linhas=%d", rawJSON, providerJSON, nJSON)
		}
		state, httpNull, err := cjStatusAttempt(ctx, tx, row.logID)
		if err != nil {
			return err
		}
		if state != "submitted" || !httpNull {
			return fmt.Errorf("attempt %s http nulo=%v", state, httpNull)
		}
		return nil
	})
}

func TestCloudJournal_B15_C03(t *testing.T) {
	opened, scope, _ := cjStatusDatabase(t)
	cjStatusTx(t, opened, scope, func(ctx context.Context, tx *db.Tx) error {
		row, err := cjStatusSeed(ctx, tx, true, "", "")
		if err != nil {
			return err
		}
		later := []byte("cjstatus-opaque-later-5500000000001")
		earlier := []byte("cjstatus-opaque-earlier-5500000000001")
		before, err := cjStatusRead(ctx, tx, row.account, row.logID)
		if err != nil {
			return err
		}
		second, err := AcceptStatus(ctx, tx, scope.TenantID, row.account, nil, later, cjStatusGate(row.provider, "obs-b"))
		if err != nil {
			return err
		}
		first, err := AcceptStatus(ctx, tx, scope.TenantID, row.account, nil, earlier, cjStatusGate(row.provider, "obs-a"))
		if err != nil {
			return err
		}
		if err = cjStatusNeutral(second, true, false); err != nil {
			return err
		}
		if err = cjStatusNeutral(first, true, false); err != nil {
			return err
		}
		after, err := cjStatusRead(ctx, tx, row.account, row.logID)
		if err != nil {
			return err
		}
		if after.status != before.status+2 || after.attempts != before.attempts || after.logs != before.logs || after.logStatus != before.logStatus || after.cents != before.cents {
			return fmt.Errorf("fora de ordem alterou o log ou o dinheiro")
		}
		var hashes int
		if err = tx.QueryRow(ctx, `select count(distinct body_hash)::int from cloud_notice_status where tenant_id = app_tenant() and cloud_account_id = $1::uuid`, row.account).Scan(&hashes); err != nil {
			return err
		}
		if hashes != 2 {
			return fmt.Errorf("hashes %d", hashes)
		}
		return nil
	})
}

func TestCloudJournal_B15_C04(t *testing.T) {
	opened, scope, other := cjStatusDatabase(t)
	cjStatusTx(t, opened, scope, func(ctx context.Context, tx *db.Tx) error {
		row, err := cjStatusSeed(ctx, tx, true, "", "")
		if err != nil {
			return err
		}
		body := []byte("cjstatus-opaque-cross-tenant-5500000000001")
		if err = tx.Exec(ctx, `select set_config('app.tenant_id', $1, true)`, other); err != nil {
			return err
		}
		effect, err := AcceptStatus(ctx, tx, other, row.account, nil, body, cjStatusGate(row.provider, "obs-a"))
		if err == nil || effect.Applied || effect.Duplicate || effect.MoneyWrites != 0 || effect.Sends != 0 {
			return fmt.Errorf("cross-tenant aplicou effect=%+v err=%v", effect, err)
		}
		var seen int
		if err = tx.QueryRow(ctx, `select count(*)::int from cloud_notice_status where provider_message_id = $1`, row.provider).Scan(&seen); err != nil {
			return err
		}
		if seen != 0 {
			return fmt.Errorf("tenant B viu ou gravou %d", seen)
		}
		if err = tx.Exec(ctx, `select set_config('app.tenant_id', $1, true)`, scope.TenantID); err != nil {
			return err
		}
		if n, err := cjStatusStatusCount(ctx, tx, row.account); err != nil || n != 0 {
			return fmt.Errorf("tenant A ganhou observação %d %v", n, err)
		}
		state, _, err := cjStatusAttempt(ctx, tx, row.logID)
		if err != nil {
			return err
		}
		if state != "submitted" {
			return fmt.Errorf("attempt cross %s", state)
		}
		return nil
	})
}

func TestCloudJournal_B15_C05(t *testing.T) {
	opened, scope, _ := cjStatusDatabase(t)
	cjStatusTx(t, opened, scope, func(ctx context.Context, tx *db.Tx) error {
		owner, err := cjStatusSeed(ctx, tx, true, "", "")
		if err != nil {
			return err
		}
		other, err := cjStatusSeed(ctx, tx, true, "", "")
		if err != nil {
			return err
		}
		body := []byte("cjstatus-opaque-cross-account-5500000000001")
		effect, err := AcceptStatus(ctx, tx, scope.TenantID, other.account, map[string]string{"X-Test": "conta-b"}, body, cjStatusGate(owner.provider, "obs-a"))
		if !errors.Is(err, errStatusUnknown) {
			return fmt.Errorf("cross-account: %v", err)
		}
		if err = cjStatusNeutral(effect, false, false); err != nil {
			return err
		}
		for _, account := range []string{owner.account, other.account} {
			n, err := cjStatusStatusCount(ctx, tx, account)
			if err != nil || n != 0 {
				return fmt.Errorf("conta %s observação %d %v", account, n, err)
			}
		}
		var attempts int
		if err = tx.QueryRow(ctx, `select count(*)::int from cloud_notice_attempts where tenant_id = app_tenant() and cloud_account_id = $1::uuid`, other.account).Scan(&attempts); err != nil {
			return err
		}
		if attempts != 1 {
			return fmt.Errorf("conta B criou attempt extra: %d", attempts)
		}
		var providerOnB int
		if err = tx.QueryRow(ctx, `select count(*)::int from cloud_notice_attempts where tenant_id = app_tenant() and cloud_account_id = $1::uuid and provider_message_id = $2`, other.account, owner.provider).Scan(&providerOnB); err != nil {
			return err
		}
		if providerOnB != 0 {
			return fmt.Errorf("id da conta A foi parar na conta B")
		}
		state, _, err := cjStatusAttempt(ctx, tx, owner.logID)
		if err != nil {
			return err
		}
		if state != "submitted" {
			return fmt.Errorf("attempt da conta A %s", state)
		}
		return nil
	})
}

func TestCloudJournal_B15_C06(t *testing.T) {
	opened, scope, _ := cjStatusDatabase(t)
	cjStatusTx(t, opened, scope, func(ctx context.Context, tx *db.Tx) error {
		row, err := cjStatusSeed(ctx, tx, true, "", "")
		if err != nil {
			return err
		}
		marker := "cjstatus-assinatura-5500000000001"
		body := []byte("cjstatus-opaque-c06-" + marker)
		checks := []struct {
			name string
			body []byte
			auth Authenticator
			want error
		}{
			{name: "unproved", body: body, auth: UnprovedAuthenticator{}, want: errStatusUnproved},
			{name: "verify", body: body, auth: &cjStatusDecode{proven: true, decoderProven: true, refuse: errors.New(marker), provider: row.provider, raw: "obs-a"}, want: errStatusVerify},
			{name: "sem decoder", body: body, auth: cjStatusPlain{}, want: errStatusDecoder},
			{name: "decoder falso", body: body, auth: &cjStatusDecode{proven: true, provider: row.provider, raw: "obs-a"}, want: errStatusDecoder},
			{name: "acima", body: bytesRepeat(statusBodyMax + 1), auth: &cjStatusDecode{proven: true, decoderProven: true, provider: row.provider, raw: "obs-a"}, want: errStatusOversize},
			{name: "eco", body: []byte("obs-a"), auth: cjStatusGate(row.provider, "obs-a"), want: errStatusShape},
			{name: "eco id", body: []byte(row.provider), auth: cjStatusGate(row.provider, "obs-a"), want: errStatusShape},
		}
		for _, check := range checks {
			effect, err := AcceptStatus(ctx, tx, scope.TenantID, row.account, nil, check.body, check.auth)
			if !errors.Is(err, check.want) {
				return fmt.Errorf("%s: %v", check.name, err)
			}
			if err != nil && (strings.Contains(err.Error(), marker) || strings.Contains(err.Error(), "5500000000001")) {
				return fmt.Errorf("%s perpetuou corpo", check.name)
			}
			if err = cjStatusNeutral(effect, false, false); err != nil {
				return fmt.Errorf("%s %w", check.name, err)
			}
			if decoded, ok := check.auth.(*cjStatusDecode); ok && decoded.calls != 0 && check.want != errStatusShape {
				return fmt.Errorf("%s chamou o decoder", check.name)
			}
		}
		if err = tx.Exec(ctx, `select set_config('app.subscriber_id', $1, true)`, uuid.NewString()); err != nil {
			return err
		}
		effect, err := AcceptStatus(ctx, tx, scope.TenantID, row.account, nil, []byte("cjstatus-opaque-portal-5500000000001"), cjStatusGate(row.provider, "obs-a"))
		if !errors.Is(err, errStatusScope) {
			return fmt.Errorf("portal: %v", err)
		}
		if err = cjStatusNeutral(effect, false, false); err != nil {
			return err
		}
		if err = tx.Exec(ctx, `select set_config('app.subscriber_id', '', true)`); err != nil {
			return err
		}
		n, err := cjStatusStatusCount(ctx, tx, row.account)
		if err != nil {
			return err
		}
		if n != 0 {
			return fmt.Errorf("recusa gravou %d", n)
		}
		after, err := cjStatusRead(ctx, tx, row.account, row.logID)
		if err != nil {
			return err
		}
		if after.logStatus != "sent" || after.attempts != 1 {
			return fmt.Errorf("recusa alterou log ou attempt %+v", after)
		}
		state, _, err := cjStatusAttempt(ctx, tx, row.logID)
		if err != nil {
			return err
		}
		if state != "submitted" {
			return fmt.Errorf("attempt %s", state)
		}
		return nil
	})
}

func TestCloudJournal_B15_C20(t *testing.T) {
	opened, scope, _ := cjStatusDatabase(t)
	cjStatusTx(t, opened, scope, func(ctx context.Context, tx *db.Tx) error {
		invoice, subscriber, err := cjStatusInvoice(ctx, tx)
		if err != nil {
			return err
		}
		row, err := cjStatusSeed(ctx, tx, true, invoice, subscriber)
		if err != nil {
			return err
		}
		before, err := cjStatusRead(ctx, tx, row.account, row.logID)
		if err != nil {
			return err
		}
		if before.cents == 0 || before.payments == 0 {
			return fmt.Errorf("fixture sem pagamento")
		}
		body := []byte(`{"messaging_product":"whatsapp","to":"5500000000001","status":"delivered","marker":"cjstatus-c20"}`)
		effect, err := AcceptStatus(ctx, tx, scope.TenantID, row.account, nil, body, cjStatusGate(row.provider, "delivered"))
		if err != nil {
			return err
		}
		if err = cjStatusNeutral(effect, true, false); err != nil {
			return err
		}
		after, err := cjStatusRead(ctx, tx, row.account, row.logID)
		if err != nil {
			return err
		}
		if after.cents != before.cents || after.payments != before.payments || after.invoices != before.invoices || after.movements != before.movements || after.effects != before.effects {
			return fmt.Errorf("dinheiro mudou antes=%+v depois=%+v", before, after)
		}
		if after.logs != before.logs || after.attempts != before.attempts || after.logStatus != "sent" || after.status != before.status+1 {
			return fmt.Errorf("aviso ou attempt mudou antes=%+v depois=%+v", before, after)
		}
		if after.providerNotices != before.providerNotices || after.notifications != before.notifications || after.deliveries != before.deliveries {
			return fmt.Errorf("fila alheia recebeu o corpo")
		}
		raw, provider, _, n, err := cjStatusStored(ctx, tx, row.account, body)
		if err != nil {
			return err
		}
		if n != 1 || raw != "delivered" || provider != row.provider || !strings.Contains(string(body), `"status":"delivered"`) || strings.Contains(raw, "5500000000001") || strings.Contains(raw, "whatsapp") || strings.Contains(raw, "{") {
			return fmt.Errorf("raw perpetuou o corpo %s", raw)
		}
		return nil
	})
}

type cjStatusRow struct {
	account  string
	logID    int64
	provider string
}

type cjStatusSnap struct {
	status, attempts, logs    int
	payments, invoices        int
	movements, effects        int
	providerNotices           int
	notifications, deliveries int
	cents                     int64
	logStatus                 string
}

type cjStatusPlain struct{}

func (cjStatusPlain) Proven() bool { return true }

func (cjStatusPlain) Verify(map[string]string, []byte) error { return nil }

type cjStatusDecode struct {
	proven, decoderProven bool
	provider, raw         string
	refuse, fail          error
	calls                 int
}

func (d *cjStatusDecode) Proven() bool { return d.proven }

func (d *cjStatusDecode) Verify(map[string]string, []byte) error { return d.refuse }

func (d *cjStatusDecode) DecoderProven() bool { return d.decoderProven }

func (d *cjStatusDecode) DecodeStatus([]byte) (string, string, error) {
	d.calls++
	return d.provider, d.raw, d.fail
}

func cjStatusGate(provider, raw string) *cjStatusDecode {
	return &cjStatusDecode{proven: true, decoderProven: true, provider: provider, raw: raw}
}

func cjStatusNeutral(effect StatusEffect, applied, duplicate bool) error {
	if effect.Applied != applied || effect.Duplicate != duplicate || effect.MoneyWrites != 0 || effect.Sends != 0 {
		return fmt.Errorf("effect applied=%v duplicate=%v money=%d sends=%d", effect.Applied, effect.Duplicate, effect.MoneyWrites, effect.Sends)
	}
	return nil
}

func cjStatusHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func bytesRepeat(n int) []byte {
	return []byte(strings.Repeat("x", n))
}

func cjStatusTx(t *testing.T, opened *db.DB, scope tenancy.Scope, fn func(context.Context, *db.Tx) error) {
	t.Helper()
	ctx := context.Background()
	err := opened.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := cjStatusAssume(ctx, tx); err != nil {
			return err
		}
		if err := fn(ctx, tx); err != nil {
			return err
		}
		return errCjStatusRollback
	})
	if !errors.Is(err, errCjStatusRollback) {
		t.Fatal(cjStatusRedact(err))
	}
}

func cjStatusSeed(ctx context.Context, tx *db.Tx, active bool, invoice, subscriber string) (cjStatusRow, error) {
	mark := strings.ReplaceAll(uuid.NewString(), "-", "")
	var row cjStatusRow
	row.provider = "cjstatus." + mark[:20]
	// v0.0 é rótulo de fixture. Não é versão Graph homologada e o texto cifrado não é segredo.
	err := tx.QueryRow(ctx, `
insert into cloud_accounts (tenant_id, name, phone_number_id, graph_version, token_enc, webhook_secret_enc, active)
values (app_tenant(), $1, $2, 'v0.0', 'v1.cjstatus.not-a-token', 'v1.cjstatus.not-a-hook', $3)
returning id::text`, "cjStatus "+mark[:12], "p"+mark[:20], active).Scan(&row.account)
	if err != nil {
		return row, err
	}
	if invoice == "" {
		err = tx.QueryRow(ctx, `insert into notice_log (tenant_id, status) values (app_tenant(), 'sent') returning id`).Scan(&row.logID)
	} else {
		err = tx.QueryRow(ctx, `insert into notice_log (tenant_id, status, invoice_id, subscriber_id) values (app_tenant(), 'sent', $1::uuid, $2::uuid) returning id`, invoice, subscriber).Scan(&row.logID)
	}
	if err != nil {
		return row, err
	}
	err = tx.Exec(ctx, `
insert into cloud_notice_attempts (tenant_id, cloud_account_id, notice_log_id, attempt_no, state, provider_message_id)
values (app_tenant(), $1::uuid, $2, 1, 'submitted', $3)`, row.account, row.logID, row.provider)
	return row, err
}

func cjStatusInvoice(ctx context.Context, tx *db.Tx) (string, string, error) {
	mark := strings.ReplaceAll(uuid.NewString(), "-", "")
	var subscriber, plan, version, contract, invoice string
	if err := tx.QueryRow(ctx, `insert into subscribers (tenant_id, name) values (app_tenant(), $1) returning id::text`, "cjStatus "+mark[:12]).Scan(&subscriber); err != nil {
		return "", "", err
	}
	if err := tx.QueryRow(ctx, `insert into plans (tenant_id, name) values (app_tenant(), $1) returning id::text`, "cjStatus plano "+mark[:12]).Scan(&plan); err != nil {
		return "", "", err
	}
	if err := tx.QueryRow(ctx, `insert into plan_versions (tenant_id, plan_id, version, price_cents, down_kbps, up_kbps, profile_name) values (app_tenant(), $1::uuid, 1, 6400, 100000, 50000, 'cjstatus') returning id::text`, plan).Scan(&version); err != nil {
		return "", "", err
	}
	if err := tx.QueryRow(ctx, `insert into contracts (tenant_id, subscriber_id, plan_version_id, due_day) values (app_tenant(), $1::uuid, $2::uuid, 15) returning id::text`, subscriber, version).Scan(&contract); err != nil {
		return "", "", err
	}
	if err := tx.QueryRow(ctx, `insert into invoices (tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents) values (app_tenant(), $1::uuid, $2::uuid, 'manual', '2026-12-20', 6400) returning id::text`, contract, subscriber).Scan(&invoice); err != nil {
		return "", "", err
	}
	if err := tx.Exec(ctx, `insert into payments (tenant_id, invoice_id, amount_cents, paid_at, method, source, note) values (app_tenant(), $1::uuid, 6400, '2026-10-29T12:00:00Z', 'pix', 'manual', 'cjStatus recebimento de teste')`, invoice); err != nil {
		return "", "", err
	}
	return invoice, subscriber, nil
}

func cjStatusRead(ctx context.Context, tx *db.Tx, account string, logID int64) (cjStatusSnap, error) {
	var snap cjStatusSnap
	err := tx.QueryRow(ctx, `
select
    (select count(*)::int from cloud_notice_status where tenant_id = app_tenant() and cloud_account_id = $1::uuid),
    (select count(*)::int from cloud_notice_attempts where tenant_id = app_tenant() and cloud_account_id = $1::uuid),
    (select count(*)::int from notice_log where tenant_id = app_tenant()),
    (select count(*)::int from payments where tenant_id = app_tenant()),
    (select coalesce(sum(signed_cents), 0)::bigint from payments where tenant_id = app_tenant()),
    (select count(*)::int from invoices where tenant_id = app_tenant()),
    (select count(*)::int from invoice_movements where tenant_id = app_tenant()),
    (select count(*)::int from payment_effects where tenant_id = app_tenant()),
    (select count(*)::int from provider_notices where tenant_id = app_tenant()),
    (select count(*)::int from notifications where tenant_id = app_tenant()),
    (select count(*)::int from webhook_deliveries where tenant_id = app_tenant()),
    (select status from notice_log where id = $2 and tenant_id = app_tenant())`, account, logID).Scan(
		&snap.status, &snap.attempts, &snap.logs, &snap.payments, &snap.cents, &snap.invoices, &snap.movements, &snap.effects,
		&snap.providerNotices, &snap.notifications, &snap.deliveries, &snap.logStatus)
	return snap, err
}

func cjStatusStatusCount(ctx context.Context, tx *db.Tx, account string) (int, error) {
	var n int
	err := tx.QueryRow(ctx, `select count(*)::int from cloud_notice_status where tenant_id = app_tenant() and cloud_account_id = $1::uuid`, account).Scan(&n)
	return n, err
}

func cjStatusStored(ctx context.Context, tx *db.Tx, account string, body []byte) (string, string, string, int, error) {
	var raw, provider, hash string
	var n int
	err := tx.QueryRow(ctx, `
select count(*)::int,
       coalesce(min(raw_status), ''),
       coalesce(min(provider_message_id), ''),
       coalesce(min(body_hash), '')
from cloud_notice_status
where tenant_id = app_tenant() and cloud_account_id = $1::uuid and body_hash = $2`, account, cjStatusHash(body)).Scan(&n, &raw, &provider, &hash)
	return raw, provider, hash, n, err
}

func cjStatusAttempt(ctx context.Context, tx *db.Tx, logID int64) (string, bool, error) {
	var state string
	var httpNull bool
	err := tx.QueryRow(ctx, `select state, http_status is null from cloud_notice_attempts where tenant_id = app_tenant() and notice_log_id = $1`, logID).Scan(&state, &httpNull)
	return state, httpNull, err
}

func cjStatusDatabase(t *testing.T) (*db.DB, tenancy.Scope, string) {
	t.Helper()
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_CLOUD_PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente com NEXO_CLOUD_PG_REQUIRED=1; PostgreSQL não está aprovado")
		}
		t.Skip(cjStatusSkip)
	}
	if err := cjStatusRejectLabURL(url); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	opened, err := db.Open(ctx, url, "force_custom_plan", 4, prometheus.NewRegistry())
	if err != nil {
		t.Fatalf("db.Open falhou com URL presente; skip não se aplica: %v", cjStatusRedact(err))
	}
	t.Cleanup(opened.Close)
	var name, sessionUser, currentUser, tenant, other string
	if err = opened.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		if err := tx.QueryRow(ctx, `select current_database(), session_user::text, current_user::text`).Scan(&name, &sessionUser, &currentUser); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `select tenant_id::text from nexo_go_directory() order by tenant_id limit 1`).Scan(&tenant); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `select coalesce((select tenant_id::text from nexo_go_directory() where tenant_id::text <> $1 order by tenant_id limit 1), '')`, tenant).Scan(&other)
	}); err != nil {
		t.Fatalf("identidade do laboratório: %v", cjStatusRedact(err))
	}
	if name != "nexo_test" || sessionUser != "nexo_go" || currentUser != "nexo_go" || tenant == "" {
		t.Fatalf("conexão fora de nexo_test/nexo_go: database=%s session_user=%s current_user=%s", name, sessionUser, currentUser)
	}
	if other == "" {
		other = uuid.NewString()
	}
	return opened, tenancy.Scope{TenantID: tenant}, other
}

func cjStatusAssume(ctx context.Context, tx *db.Tx) error {
	var name, sessionUser, currentUser string
	if err := tx.QueryRow(ctx, `select current_database(), session_user::text, current_user::text`).Scan(&name, &sessionUser, &currentUser); err != nil {
		return err
	}
	if name != "nexo_test" || sessionUser != "nexo_go" || currentUser != "nexo_go" {
		return fmt.Errorf("sessão antes do papel: database=%s session_user=%s current_user=%s", name, sessionUser, currentUser)
	}
	if err := tx.Exec(ctx, `set local role nexo_app`); err != nil {
		return err
	}
	var super, bypass bool
	if err := tx.QueryRow(ctx, `select current_database(), session_user::text, current_user::text, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user`).Scan(&name, &sessionUser, &currentUser, &super, &bypass); err != nil {
		return err
	}
	if name != "nexo_test" || sessionUser != "nexo_go" || currentUser != "nexo_app" || super || bypass {
		return fmt.Errorf("papel nexo_app recusado: database=%s session_user=%s current_user=%s", name, sessionUser, currentUser)
	}
	return nil
}

func cjStatusRejectLabURL(raw string) error {
	cfg, err := pgx.ParseConfig(raw)
	if err != nil {
		return fmt.Errorf("URL de laboratório inválida")
	}
	if cfg.User != "nexo_go" || cfg.Database != "nexo_test" {
		return fmt.Errorf("URL recusada; este pacote só usa nexo_go em nexo_test")
	}
	return nil
}

func cjStatusRedact(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	if url := os.Getenv("NEXO_GO_TEST_DATABASE_URL"); url != "" {
		text = strings.ReplaceAll(text, url, "NEXO_GO_TEST_DATABASE_URL")
	}
	return text
}

func cjStatusSource(t *testing.T) {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("origem do teste indisponível")
	}
	path := filepath.Join(filepath.Dir(file), "status.go")
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	for _, banned := range []string{"cloudapi", "net/http", "os.Getenv", "encoding/json", "graph.facebook", "X-Hub-Signature", "finance.", "enqueueNotices", "delivered", "webhook_secret", "token_enc"} {
		if strings.Contains(text, banned) {
			t.Fatalf("status.go contém %s", banned)
		}
	}
	parsed, err := parser.ParseFile(token.NewFileSet(), path, src, parser.SkipObjectResolution)
	if err != nil {
		t.Fatal(err)
	}
	for _, imp := range parsed.Imports {
		if imp.Path.Value != `"context"` && imp.Path.Value != `"crypto/sha256"` && imp.Path.Value != `"encoding/hex"` && imp.Path.Value != `"errors"` && imp.Path.Value != `"regexp"` && imp.Path.Value != `"unicode/utf16"` && imp.Path.Value != `"unicode/utf8"` && imp.Path.Value != `"nexoisp/api-go/internal/db"` {
			t.Fatalf("import inesperado %s", imp.Path.Value)
		}
	}
	method, ok := reflect.TypeOf(AcceptStatus).In(6).MethodByName("Proven")
	if !ok || method.Type.NumIn() != 0 || method.Type.NumOut() != 1 {
		t.Fatal("assinatura de Authenticator ausente")
	}
	if reflect.TypeOf(AcceptStatus).NumIn() != 7 || reflect.TypeOf(AcceptStatus).NumOut() != 2 {
		t.Fatal("assinatura de AcceptStatus divergiu")
	}
	if reflect.TypeOf(AcceptStatus).Out(0) != reflect.TypeOf(StatusEffect{}) {
		t.Fatal("retorno não é StatusEffect")
	}
}

package escrita

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	compensateCreatedCap   = 200
	compensateEvidenceNote = "compensação append-only; nenhuma linha financeira, lote ou auditoria foi apagada"
)

// importCompensateBeforeCommit is nil in production. Tests in this package set
// it to fail the same transaction after the cash effects, the marker and the
// audit insert. It is not an HTTP route and it does not split the batch.
var importCompensateBeforeCommit func() error

// importCompensate is the C25-v1 core of POST /api/import/batches/{id}/compensate.
// The standard registry calls it inside the request transaction. This function
// does not open a transaction, register a route or call a PSP.
func (s Service) importCompensate(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	batchID, key, reason, err := validateCompensateRequest(ctx, id, b)
	if err != nil {
		return nil, err
	}
	actor := auth.From(ctx)
	if err = validate.UUID(actor.UserID); err != nil {
		return nil, apierr.New(400, "ator inválido")
	}
	return applyImportCompensation(ctx, tx, actor, batchID, key, reason)
}

func validateCompensateRequest(ctx context.Context, id string, b map[string]any) (string, string, string, error) {
	if err := compensateScope(ctx); err != nil {
		return "", "", "", err
	}
	actor := auth.From(ctx)
	if !slices.Contains(actor.Permissions, "import:run") {
		return "", "", "", apierr.New(403, "sem permissão para esta ação")
	}
	if req := httpx.Request(ctx); req != nil {
		for _, values := range req.URL.Query() {
			if len(values) != 1 {
				return "", "", "", apierr.New(400, "filtro repetido")
			}
			return "", "", "", apierr.New(400, "filtro desconhecido")
		}
		if values := req.Header.Values("Idempotency-Key"); len(values) != 1 || !printableIdempotencyKey(values[0]) {
			return "", "", "", apierr.New(400, "Idempotency-Key ausente ou inválida")
		}
	} else {
		return "", "", "", apierr.New(400, "Idempotency-Key ausente ou inválida")
	}
	if err := validate.UUID(id); err != nil {
		return "", "", "", err
	}
	parsed, err := uuid.Parse(id)
	if err != nil {
		return "", "", "", apierr.New(400, "dados: Invalid uuid")
	}
	reason, err := compensateReason(b)
	if err != nil {
		return "", "", "", err
	}
	return parsed.String(), httpx.Request(ctx).Header.Get("Idempotency-Key"), reason, nil
}

// compensateScope matches importRevertEligibilityScope: full tenant, no portal,
// no POP list (including an empty non-nil list) and no support session.
func compensateScope(ctx context.Context) error {
	actor := auth.From(ctx)
	if actor == nil || actor.TenantID == "" || actor.SubscriberID != "" || actor.PopIDs != nil || actor.Support {
		return apierr.New(403, "a reconciliação do lote exige escopo integral do provedor, fora do suporte")
	}
	return nil
}

func printableIdempotencyKey(value string) bool {
	n := utf8.RuneCountInString(value)
	if n < 8 || n > 200 {
		return false
	}
	for _, r := range value {
		if !unicode.IsPrint(r) {
			return false
		}
	}
	return true
}

func compensateReason(b map[string]any) (string, error) {
	raw, ok := b["reason"].(string)
	if !ok {
		return "", apierr.New(400, "motivo inválido")
	}
	reason := validate.Trim(raw)
	if n := utf8.RuneCountInString(reason); n < 10 || n > 200 {
		return "", apierr.New(400, "motivo inválido")
	}
	return reason, nil
}

func compensateHash(batchID, reason string) string {
	payload, _ := json.Marshal(struct {
		BatchID string `json:"batch_id"`
		Reason  string `json:"reason"`
	}{batchID, reason})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

type compensateFailure struct {
	status   int
	message  string
	Blockers []map[string]any
}

func (e *compensateFailure) Error() string  { return e.message }
func (e *compensateFailure) GetStatus() int { return e.status }
func (e *compensateFailure) MarshalJSON() ([]byte, error) {
	payload := map[string]any{"error": e.message, "blockers": e.Blockers}
	return json.Marshal(payload)
}

func compensateErr(status int, message string, blockers []map[string]any) error {
	if len(blockers) == 0 {
		return apierr.New(status, message)
	}
	return &compensateFailure{status: status, message: message, Blockers: blockers}
}

type createdRef struct {
	EntityID, ExternalID string
}

type batchSnapshot struct {
	Kind, Source       string
	Created            []createdRef
	Updated, Unchanged int
	ErrorRows          int
	UpdatedIDs         []string
	BareCreated        int
}

func loadBatchSnapshot(ctx context.Context, tx *db.Tx, batchID string) (batchSnapshot, error) {
	var snap batchSnapshot
	err := tx.QueryRow(ctx, `select kind, source from import_batches where id = $1::uuid`, batchID).Scan(&snap.Kind, &snap.Source)
	if errors.Is(err, pgx.ErrNoRows) {
		return snap, apierr.New(404, "lote não encontrado")
	}
	if err != nil {
		return snap, err
	}
	rows, err := tx.Objects(ctx, `select status, entity_id::text as entity_id, external_id
		from import_rows where batch_id = $1::uuid order by row_number, id`, batchID)
	if err != nil {
		return snap, err
	}
	for _, row := range rows {
		status, _ := row.Get("status").(string)
		entity, _ := row.Get("entity_id").(string)
		external, _ := row.Get("external_id").(string)
		switch status {
		case "created":
			if entity == "" {
				snap.BareCreated++
				continue
			}
			snap.Created = append(snap.Created, createdRef{EntityID: entity, ExternalID: external})
		case "updated":
			snap.Updated++
			if entity != "" {
				snap.UpdatedIDs = append(snap.UpdatedIDs, entity)
			}
		case "unchanged":
			snap.Unchanged++
		case "error":
			snap.ErrorRows++
		}
	}
	return snap, nil
}

func applyImportCompensation(ctx context.Context, tx *db.Tx, actor *auth.Ctx, batchID, key, reason string) (any, error) {
	before, err := loadBatchSnapshot(ctx, tx, batchID)
	if err != nil {
		return nil, err
	}
	if refuse, ok := refuseBatchShape(before); ok {
		return nil, refuse
	}
	ids := createdIDs(before.Created)
	if err = finance.LockInvoices(ctx, tx, actor.TenantID, ids...); err != nil {
		return nil, err
	}
	snap, err := loadBatchSnapshot(ctx, tx, batchID)
	if err != nil {
		return nil, err
	}
	if refuse, ok := refuseBatchShape(snap); ok {
		return nil, refuse
	}
	if !sameCreated(before.Created, snap.Created) || before.Updated != snap.Updated {
		return nil, compensateErr(409, "provenance_movement", blockers("provenance_movement", ids, "O conjunto de linhas created mudou debaixo da trava."))
	}
	hash := compensateHash(batchID, reason)
	if replay, done, err := readCompensationMarker(ctx, tx, actor.TenantID, batchID, key, hash); done || err != nil {
		return replay, err
	}
	plan, blocked, err := revalidateCreatedInvoices(ctx, tx, actor.TenantID, batchID, snap)
	if err != nil || blocked != nil {
		return nil, errOr(err, blocked)
	}
	reversed, err := compensateInvoices(ctx, tx, actor, batchID, reason, plan)
	if err != nil {
		return nil, err
	}
	result := compensateResult(batchID, uuid.NewString(), false, len(snap.Created), len(reversed), countActions(plan, "cancel"), countActions(plan, "leave"), snap.Unchanged, snap.ErrorRows)
	if err = insertCompensationMarker(ctx, tx, actor, batchID, key, hash, reason, result); err != nil {
		return nil, err
	}
	if err = record(ctx, tx, "import.compensate_batch", "import_batch", batchID, map[string]any{
		"reason": reason, "created_rows": result["created_rows"], "reversed_payments": result["reversed_payments"],
		"canceled_invoices": result["canceled_invoices"], "left_canceled": result["left_canceled"],
		"skipped_unchanged": result["skipped_unchanged"], "skipped_error": result["skipped_error"],
		"reversed_payment_ids": reversed,
	}); err != nil {
		return nil, err
	}
	if importCompensateBeforeCommit != nil {
		if err = importCompensateBeforeCommit(); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func errOr(err error, blocked error) error {
	if err != nil {
		return err
	}
	return blocked
}

func refuseBatchShape(snap batchSnapshot) (error, bool) {
	if snap.Kind != "invoices" {
		return apierr.New(409, "kind_not_compensatable"), true
	}
	if snap.Updated > 0 || snap.BareCreated > 0 {
		sample := snap.UpdatedIDs
		return compensateErr(409, "provenance_movement", blockers("provenance_movement", sample, "Linha updated ou created sem entidade não tem preimagem para compensar.")), true
	}
	if len(snap.Created) == 0 {
		return apierr.New(409, "nothing_created"), true
	}
	if len(snap.Created) > compensateCreatedCap {
		return apierr.New(409, "row_cap"), true
	}
	seen := map[string]struct{}{}
	var dup []string
	for _, row := range snap.Created {
		if _, ok := seen[row.EntityID]; ok {
			dup = append(dup, row.EntityID)
			continue
		}
		seen[row.EntityID] = struct{}{}
	}
	if len(dup) > 0 {
		return compensateErr(409, "provenance_movement", blockers("provenance_movement", dup, "Mais de uma linha created aponta para a mesma fatura.")), true
	}
	return nil, false
}

func createdIDs(rows []createdRef) []string {
	ids := make([]string, len(rows))
	for i, row := range rows {
		ids[i] = row.EntityID
	}
	slices.Sort(ids)
	return ids
}

func sameCreated(a, b []createdRef) bool {
	if len(a) != len(b) {
		return false
	}
	left := append([]createdRef{}, a...)
	right := append([]createdRef{}, b...)
	slices.SortFunc(left, func(x, y createdRef) int { return strings.Compare(x.EntityID, y.EntityID) })
	slices.SortFunc(right, func(x, y createdRef) int { return strings.Compare(x.EntityID, y.EntityID) })
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func readCompensationMarker(ctx context.Context, tx *db.Tx, tenant, batchID, key, hash string) (any, bool, error) {
	var existingID, existingKey, existingHash string
	var raw []byte
	err := tx.QueryRow(ctx, `select id::text, idempotency_key, request_hash, result
		from import_batch_compensations where tenant_id = $1::uuid and batch_id = $2::uuid`, tenant, batchID).Scan(&existingID, &existingKey, &existingHash, &raw)
	if err == nil {
		if existingKey == key && existingHash == hash {
			replay, conv := replayCompensation(raw, existingID)
			return replay, true, conv
		}
		if existingKey == key {
			return nil, true, apierr.New(409, "idempotency_conflict")
		}
		return nil, true, apierr.New(409, "already_compensated")
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, true, err
	}
	var otherBatch, otherHash string
	err = tx.QueryRow(ctx, `select batch_id::text, request_hash from import_batch_compensations
		where tenant_id = $1::uuid and idempotency_key = $2`, tenant, key).Scan(&otherBatch, &otherHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, true, err
	}
	return nil, true, apierr.New(409, "idempotency_conflict")
}

func replayCompensation(raw []byte, id string) (map[string]any, error) {
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	body["compensation_id"] = id
	body["idempotent_replay"] = true
	for _, name := range []string{"created_rows", "reversed_payments", "canceled_invoices", "left_canceled", "skipped_unchanged", "skipped_error"} {
		body[name] = asInt(body[name])
	}
	evidence, _ := body["evidence"].(map[string]any)
	if evidence == nil {
		evidence = map[string]any{}
	}
	evidence["reverted"] = false
	if _, ok := evidence["note"].(string); !ok {
		evidence["note"] = compensateEvidenceNote
	}
	body["evidence"] = evidence
	delete(body, "idempotency_key")
	delete(body, "request_hash")
	return body, nil
}

func asInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int32:
		return int(n)
	case int64:
		return int(n)
	case float64:
		return int(n)
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	default:
		return 0
	}
}

type invoicePlan struct {
	ID, PaymentID, Action string
}

func revalidateCreatedInvoices(ctx context.Context, tx *db.Tx, tenant, batchID string, snap batchSnapshot) ([]invoicePlan, error, error) {
	ids := createdIDs(snap.Created)
	external := map[string]string{}
	for _, row := range snap.Created {
		external[row.EntityID] = row.ExternalID
	}
	invoices, err := tx.Objects(ctx, `select id::text as id, status, (paid_at is null) as paid_at_null,
		fee_cents, discount_cents, agreement_id::text as agreement_id, gateway_charge_id,
		provider_issuance_id::text as provider_issuance_id, external_source, external_id
		from invoices where tenant_id = $1::uuid and id = any($2::uuid[]) order by id`, tenant, ids)
	if err != nil {
		return nil, nil, err
	}
	byID := map[string]jsonx.Object{}
	for _, row := range invoices {
		byID[row.Get("id").(string)] = row
	}
	payments, err := tx.Objects(ctx, `select p.invoice_id::text as invoice_id, p.id::text as id, p.kind, p.source,
		p.reversal_of::text as reversal_of, p.created_by::text as created_by, p.gateway, p.gateway_payment_id,
		p.financial_connection_id::text as financial_connection_id, p.provider_refund_id, p.provider_return_id, p.note,
		(p.created_at = b.created_at) as created_eq
		from payments p
		join import_batches b on b.tenant_id = p.tenant_id and b.id = $2::uuid
		where p.tenant_id = $1::uuid and p.invoice_id = any($3::uuid[])
		order by p.invoice_id, p.id`, tenant, batchID, ids)
	if err != nil {
		return nil, nil, err
	}
	movements, err := tx.Objects(ctx, `select m.invoice_id::text as invoice_id, m.origin, m.status_after,
		(m.recorded_at = b.created_at) as recorded_eq
		from invoice_movements m
		join import_batches b on b.tenant_id = m.tenant_id and b.id = $2::uuid
		where m.tenant_id = $1::uuid and m.invoice_id = any($3::uuid[])
		order by m.invoice_id, m.id`, tenant, batchID, ids)
	if err != nil {
		return nil, nil, err
	}
	effects, err := groupedIDs(ctx, tx, `select invoice_id::text as id from payment_effects
		where tenant_id = $1::uuid and invoice_id = any($2::uuid[])`, tenant, ids)
	if err != nil {
		return nil, nil, err
	}
	notices, err := groupedIDs(ctx, tx, `select invoice_id::text as id from notice_log
		where tenant_id = $1::uuid and invoice_id = any($2::uuid[])`, tenant, ids)
	if err != nil {
		return nil, nil, err
	}
	issuanceRows, err := groupedIDs(ctx, tx, `select invoice_id::text as id from provider_issuance
		where tenant_id = $1::uuid and invoice_id = any($2::uuid[])`, tenant, ids)
	if err != nil {
		return nil, nil, err
	}
	dependents, err := tx.Objects(ctx, `select distinct ob.id::text as id
		from import_rows o
		join import_batches ob on ob.tenant_id = o.tenant_id and ob.id = o.batch_id
		where o.tenant_id = $1::uuid and o.batch_id <> $2::uuid
		  and o.status in ('created', 'updated', 'unchanged') and o.entity_id = any($3::uuid[])
		order by 1`, tenant, batchID, ids)
	if err != nil {
		return nil, nil, err
	}
	group := map[string]*blockerGroup{}
	if len(dependents) > 0 {
		var sample []string
		for _, row := range dependents {
			sample = append(sample, row.Get("id").(string))
		}
		addBlock(group, "dependent_batches", sample, "Outro lote referencia fatura criada por este lote.")
	}
	var missing []string
	plans := make([]invoicePlan, 0, len(ids))
	for _, id := range ids {
		row, ok := byID[id]
		if !ok {
			missing = append(missing, id)
			continue
		}
		_, hasEffect := effects[id]
		_, hasNotice := notices[id]
		_, hasIssuance := issuanceRows[id]
		plan, issues := classifyImportedInvoice(snap.Source, external[id], row, rowsFor(payments, id), rowsFor(movements, id), hasEffect, hasNotice, hasIssuance)
		if len(issues) > 0 {
			for _, issue := range issues {
				sample := issue.ids
				if len(sample) == 0 {
					sample = []string{id}
				}
				addBlock(group, issue.kind, sample, issue.desc)
			}
			continue
		}
		plans = append(plans, plan)
	}
	if len(missing) > 0 {
		addBlock(group, "missing", missing, "Fatura criada pelo lote não está visível neste provedor.")
	}
	if len(group) > 0 {
		return nil, compensateErr(409, primaryBlocker(group), exportBlockers(group)), nil
	}
	return plans, nil, nil
}

func groupedIDs(ctx context.Context, tx *db.Tx, sql string, tenant string, ids []string) (map[string]struct{}, error) {
	rows, err := tx.Objects(ctx, sql, tenant, ids)
	if err != nil {
		return nil, err
	}
	out := map[string]struct{}{}
	for _, row := range rows {
		if id, _ := row.Get("id").(string); id != "" {
			out[id] = struct{}{}
		}
	}
	return out, nil
}

func rowsFor(rows []jsonx.Object, invoice string) []jsonx.Object {
	var out []jsonx.Object
	for _, row := range rows {
		if row.Get("invoice_id") == invoice {
			out = append(out, row)
		}
	}
	return out
}

type compensateIssue struct {
	kind, desc string
	ids        []string
}

func classifyImportedInvoice(source, externalID string, inv jsonx.Object, payments, movements []jsonx.Object, effect bool, notice bool, issuanceRow bool) (invoicePlan, []compensateIssue) {
	id, _ := inv.Get("id").(string)
	status, _ := inv.Get("status").(string)
	plan := invoicePlan{ID: id}
	var issues []compensateIssue
	if textOf(inv.Get("external_source")) != source || textOf(inv.Get("external_id")) != externalID || externalID == "" {
		issues = append(issues, compensateIssue{"provenance_movement", "A fatura não conserva a origem e o id externo da linha created.", []string{id}})
	}
	if asInt(inv.Get("fee_cents")) != 0 || asInt(inv.Get("discount_cents")) != 0 || textOf(inv.Get("agreement_id")) != "" || status == "reconciling" || (status != "open" && status != "paid" && status != "canceled") {
		issues = append(issues, compensateIssue{"provenance_movement", "A fatura tem acordo, encargo, desconto, conciliação ou estado fora da importação.", []string{id}})
	}
	if textOf(inv.Get("gateway_charge_id")) != "" || textOf(inv.Get("provider_issuance_id")) != "" || issuanceRow {
		issues = append(issues, compensateIssue{"provider_issuance", "Fatura com emissão no PSP ou identificador de cobrança.", []string{id}})
	}
	if effect {
		issues = append(issues, compensateIssue{"payment_effects", "Efeito de pagamento ligado à fatura importada.", []string{id}})
	}
	if notice {
		issues = append(issues, compensateIssue{"notices", "Aviso ligado à fatura importada.", []string{id}})
	}
	if !importMovement(movements, status) {
		issues = append(issues, compensateIssue{"provenance_movement", "O único movimento anterior à compensação tem de ser o created da importação, com o mesmo instante do lote.", movementSamples(movements, id)})
	}
	proven, foreign := splitPayments(payments, source, externalID)
	if len(foreign) > 0 || len(proven) > 1 {
		issues = append(issues, compensateIssue{"provenance_payment", "Pagamento da fatura não é a baixa única comprovada da importação.", paymentSamples(foreign, proven)})
	} else if len(proven) == 0 {
		if status == "paid" || !truth(inv.Get("paid_at_null")) {
			issues = append(issues, compensateIssue{"provenance_payment", "Fatura paga ou com paid_at sem a baixa comprovada da importação.", []string{id}})
		} else if status == "canceled" {
			plan.Action = "leave"
		} else if status == "open" {
			plan.Action = "cancel"
		}
	} else if status != "open" && status != "paid" {
		issues = append(issues, compensateIssue{"provenance_payment", "A baixa comprovada está numa fatura que não está aberta nem paga.", []string{proven[0]}})
	} else {
		plan.Action = "reverse"
		plan.PaymentID = proven[0]
	}
	if len(issues) > 0 {
		plan.Action = ""
	}
	return plan, issues
}

func importMovement(movements []jsonx.Object, status string) bool {
	if len(movements) != 1 {
		return false
	}
	row := movements[0]
	return row.Get("origin") == "created" && truth(row.Get("recorded_eq")) && row.Get("status_after") == status
}

func splitPayments(payments []jsonx.Object, source, externalID string) (proven, foreign []string) {
	note := fmt.Sprintf("Importado de %s (id %s)", source, externalID)
	for _, row := range payments {
		id := textOf(row.Get("id"))
		if row.Get("kind") == "payment" && row.Get("source") == "manual" && textOf(row.Get("reversal_of")) == "" &&
			textOf(row.Get("created_by")) == "" && textOf(row.Get("gateway")) == "" && textOf(row.Get("gateway_payment_id")) == "" &&
			textOf(row.Get("financial_connection_id")) == "" && textOf(row.Get("provider_refund_id")) == "" &&
			textOf(row.Get("provider_return_id")) == "" && truth(row.Get("created_eq")) && row.Get("note") == note {
			proven = append(proven, id)
			continue
		}
		foreign = append(foreign, id)
	}
	return proven, foreign
}

func truth(v any) bool {
	b, _ := v.(bool)
	return b
}

func textOf(v any) string {
	s, _ := v.(string)
	return s
}

func movementSamples(rows []jsonx.Object, invoice string) []string {
	if len(rows) == 0 {
		return []string{invoice}
	}
	return []string{invoice}
}

func paymentSamples(groups ...[]string) []string {
	var out []string
	for _, group := range groups {
		out = append(out, group...)
	}
	return out
}

type blockerGroup struct {
	ids  []string
	desc string
}

func addBlock(dst map[string]*blockerGroup, kind string, ids []string, desc string) {
	g := dst[kind]
	if g == nil {
		g = &blockerGroup{desc: desc}
		dst[kind] = g
	}
	g.ids = append(g.ids, ids...)
}

func blockers(kind string, ids []string, desc string) []map[string]any {
	group := map[string]*blockerGroup{}
	addBlock(group, kind, ids, desc)
	return exportBlockers(group)
}

func exportBlockers(group map[string]*blockerGroup) []map[string]any {
	var out []map[string]any
	for _, kind := range blockerOrder {
		g := group[kind]
		if g == nil {
			continue
		}
		seen := map[string]struct{}{}
		var ids []string
		for _, id := range g.ids {
			if id == "" {
				continue
			}
			if _, ok := seen[id]; ok {
				continue
			}
			seen[id] = struct{}{}
			ids = append(ids, id)
		}
		slices.Sort(ids)
		count := len(ids)
		if count == 0 {
			continue
		}
		if count > 20 {
			ids = ids[:20]
		}
		out = append(out, map[string]any{"kind": kind, "count": count, "sample_ids": append([]string{}, ids...), "description": g.desc})
	}
	return out
}

var blockerOrder = []string{"missing", "dependent_batches", "provenance_payment", "provider_issuance", "payment_effects", "notices", "provenance_movement"}

func primaryBlocker(group map[string]*blockerGroup) string {
	for _, kind := range blockerOrder {
		if group[kind] != nil {
			return kind
		}
	}
	return "provenance_movement"
}

func compensateInvoices(ctx context.Context, tx *db.Tx, actor *auth.Ctx, batchID, reason string, plan []invoicePlan) ([]string, error) {
	var reversed []string
	cancelReason := reason
	reverseReason := fmt.Sprintf("compensação do lote %s: %s", batchID, reason)
	for _, item := range plan {
		if item.Action == "reverse" {
			if _, err := finance.Reverse(ctx, tx, item.ID, item.PaymentID, actor.UserID, reverseReason); err != nil {
				return nil, err
			}
			if err := record(ctx, tx, "invoice.payment_reverse", "invoice", item.ID, map[string]any{"payment_id": item.PaymentID, "reason": reverseReason, "batch_id": batchID}); err != nil {
				return nil, err
			}
			reversed = append(reversed, item.PaymentID)
			item.Action = "cancel"
		}
		if item.Action == "leave" {
			continue
		}
		if item.Action != "cancel" {
			return nil, apierr.New(409, "provenance_movement")
		}
		var canceled string
		err := tx.QueryRow(ctx, `update invoices set status = 'canceled', canceled_at = now(), status_note = $2
			where id = $1 and status = 'open' returning id::text`, item.ID, cancelReason).Scan(&canceled)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apierr.New(409, "provenance_movement")
		}
		if err != nil {
			return nil, err
		}
		if err = record(ctx, tx, "invoice.cancel", "invoice", item.ID, map[string]any{"reason": cancelReason, "batch_id": batchID}); err != nil {
			return nil, err
		}
	}
	return reversed, nil
}

func insertCompensationMarker(ctx context.Context, tx *db.Tx, actor *auth.Ctx, batchID, key, hash, reason string, result map[string]any) error {
	raw, err := json.Marshal(result)
	if err != nil {
		return err
	}
	err = tx.Exec(ctx, `insert into import_batch_compensations
		(id, tenant_id, batch_id, idempotency_key, request_hash, reason, actor_id, result)
		values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, $8::jsonb)`,
		result["compensation_id"], actor.TenantID, batchID, key, hash, reason, actor.UserID, string(raw))
	if err != nil {
		return mapCompensationUnique(err)
	}
	return nil
}

func countActions(plan []invoicePlan, action string) int {
	n := 0
	for _, item := range plan {
		if item.Action == action || (action == "cancel" && item.Action == "reverse") {
			n++
		}
	}
	return n
}

func compensateResult(batchID, compensationID string, replay bool, created, reversed, canceled, left, unchanged, erro int) map[string]any {
	return map[string]any{
		"batch_id": batchID, "compensation_id": compensationID, "idempotent_replay": replay,
		"created_rows": created, "reversed_payments": reversed, "canceled_invoices": canceled,
		"left_canceled": left, "skipped_unchanged": unchanged, "skipped_error": erro,
		"evidence": map[string]any{"reverted": false, "note": compensateEvidenceNote},
	}
}

func mapCompensationUnique(err error) error {
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == "23505" {
		if strings.Contains(pe.ConstraintName, "idempotency_key") {
			return apierr.New(409, "idempotency_conflict")
		}
		if strings.Contains(pe.ConstraintName, "batch_id") {
			return apierr.New(409, "already_compensated")
		}
	}
	return err
}

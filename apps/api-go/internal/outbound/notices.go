package outbound

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
	"nexoisp/api-go/internal/validate"
	"os"
	"regexp"
	"slices"
	"strings"
	"unicode/utf16"
)

//go:embed rotinas.json sql/*.sql
var routines embed.FS
var routineQueries = func() map[string][]string {
	data, e := routines.ReadFile("rotinas.json")
	if e != nil {
		panic(e)
	}
	var list []struct {
		Path    string
		Queries []string
	}
	if e = json.Unmarshal(data, &list); e != nil {
		panic(e)
	}
	out := map[string][]string{}
	for _, r := range list {
		out[strings.TrimPrefix(r.Path, "helper:")] = r.Queries
	}
	return out
}()

func RoutineSQL(name string, index int) string {
	b, e := routines.ReadFile("sql/" + routineQueries[name][index])
	if e != nil {
		panic(e)
	}
	return string(b)
}
func numeric(v any) float64 { return validate.JSNumber(fmt.Sprint(v)) }
func utf16cut(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}
func Notices(ctx context.Context, database *db.DB, tenant string, force bool) (map[string]any, error) {
	out := map[string]any{"sent": 0, "failed": 0, "skipped": 0}
	scope := tenancy.Scope{TenantID: tenant}
	enabled := false
	err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
		var e error
		enabled, e = enqueueNotices(ctx, tx, tenant, force, out)
		return e
	})
	if err != nil || !enabled {
		return out, err
	}
	return out, deliverQueuedNotices(ctx, database, scope, tenant, productionNoticeRuntime(), out)
}

// enqueueNotices writes notice_log rows. Message delivery stays in Notices, after commit.
// Invoice ids are the union of every open rule, locked once through finance.LockInvoices
// (advisory 7411005, then FOR UPDATE, both in canonical UUID order) before any upsert.
// Each rule then reads candidates again, so an earlier upsert still dedups the next rule.
// An invoice that shows up only after the wait was not in that locked set and is skipped;
// the next run discovers it and locks it. Balance and status are read after the lock;
// a canceled or settled invoice is skipped.
func enqueueNotices(ctx context.Context, tx *db.Tx, tenant string, force bool, out map[string]any) (bool, error) {
	sql := func(i int) string { return RoutineSQL("runNotices", i) }
	rs, err := tx.Objects(ctx, sql(0), tenant)
	if err != nil {
		return false, err
	}
	t := rs[0]
	if t.Get("enabled") != true && !force {
		return false, nil
	}
	if err = sweepNotices(ctx, tx, tenant); err != nil {
		return false, err
	}
	rules, err := tx.Objects(ctx, sql(2))
	if err != nil {
		return false, err
	}
	openRules := make([]jsonx.Object, 0, len(rules))
	seen := map[string]struct{}{}
	ids := make([]string, 0)
	for _, r := range rules {
		if !noticeRuleOpen(t, r) {
			continue
		}
		openRules = append(openRules, r)
		cands, err := tx.Objects(ctx, sql(3), t.Get("tz"), r.Get("days_relative"), r.Get("plan_id"), r.Get("pop_id"), r.Get("tag_id"), r.Get("id"), 3, r.Get("min_interval_days"))
		if err != nil {
			return false, err
		}
		for _, k := range cands {
			id, err := noticeInvoiceID(k.Get("invoice_id"))
			if err != nil {
				return false, err
			}
			if _, ok := seen[id]; ok {
				continue
			}
			seen[id] = struct{}{}
			ids = append(ids, id)
		}
	}
	if err = finance.LockInvoices(ctx, tx, tenant, ids...); err != nil {
		return false, err
	}
	for _, r := range openRules {
		cands, err := tx.Objects(ctx, sql(3), t.Get("tz"), r.Get("days_relative"), r.Get("plan_id"), r.Get("pop_id"), r.Get("tag_id"), r.Get("id"), 3, r.Get("min_interval_days"))
		if err != nil {
			return false, err
		}
		queued := map[string]bool{}
		for _, k := range cands {
			sid := k.Get("subscriber_id").(string)
			if queued[sid] {
				continue
			}
			id, err := noticeInvoiceID(k.Get("invoice_id"))
			if err != nil {
				return false, err
			}
			if _, locked := seen[id]; !locked {
				continue
			}
			due, payable, err := noticeInvoicePayable(ctx, tx, tenant, id)
			if err != nil {
				return false, err
			}
			if !payable {
				continue
			}
			k.Set("due_cents", due)
			contacts, err := tx.Objects(ctx, sql(4), sid)
			if err != nil {
				return false, err
			}
			var contact, message, channel any
			status := "skipped_no_consent"
			if len(contacts) > 0 {
				contact = contacts[0].Get("value")
				channel = r.Get("channel_id")
				status = "queued"
				base := os.Getenv("NEXO_PUBLIC_URL")
				if base != "" {
					base = strings.TrimSuffix(base, "/") + "/"
				}
				parts := strings.Split(k.Get("due").(string), "-")
				if len(parts) == 3 {
					parts[0], parts[2] = parts[2], parts[0]
				}
				vars := map[string]string{"nome": strings.Split(fmt.Sprint(k.Get("name")), " ")[0], "valor": "R$ " + strings.ReplaceAll(fmt.Sprintf("%.2f", numeric(k.Get("due_cents"))/100), ".", ","), "vencimento": strings.Join(parts, "/"), "plano": fmt.Sprint(k.Get("plan_name")), "link": base}
				rx := regexp.MustCompile(`\{([a-z_]+)\}`)
				text := rx.ReplaceAllStringFunc(fmt.Sprint(r.Get("body")), func(v string) string { return vars[v[1:len(v)-1]] })
				text = regexp.MustCompile(`\s{2,}`).ReplaceAllString(text, " ")
				message = utf16cut(strings.TrimSpace(text), 600)
				queued[sid] = true
			} else {
				out["skipped"] = out["skipped"].(int) + 1
			}
			if err = tx.Exec(ctx, sql(5), tenant, r.Get("id"), k.Get("invoice_id"), k.Get("contract_id"), sid, contact, status, channel, message); err != nil {
				return false, err
			}
		}
	}
	return true, nil
}

func noticeRuleOpen(t, r jsonx.Object) bool {
	if numeric(t.Get("hour")) < numeric(r.Get("hour_from")) || numeric(t.Get("hour")) >= numeric(r.Get("hour_to")) {
		return false
	}
	days := []float64{}
	switch a := r.Get("weekdays").(type) {
	case []any:
		for _, v := range a {
			days = append(days, numeric(v))
		}
	case []int32:
		for _, v := range a {
			days = append(days, float64(v))
		}
	}
	return slices.Contains(days, numeric(t.Get("dow")))
}

func noticeInvoiceID(v any) (string, error) {
	id, ok := v.(string)
	if !ok || id == "" {
		return "", fmt.Errorf("fatura do aviso inválida")
	}
	return id, nil
}

func noticeInvoicePayable(ctx context.Context, tx *db.Tx, tenant, id string) (float64, bool, error) {
	rows, err := tx.Objects(ctx, `select i.status::text as status,
		(i.amount_cents + i.fee_cents - i.discount_cents - coalesce((select sum(p.signed_cents) from payments p where p.invoice_id = i.id), 0))::float8 as due_cents
		from invoices i where i.tenant_id = $1::uuid and i.id = $2::uuid`, tenant, id)
	if err != nil || len(rows) == 0 {
		return 0, false, err
	}
	due := numeric(rows[0].Get("due_cents"))
	return due, rows[0].Get("status") == "open" && due > 0, nil
}

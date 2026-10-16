package outbound

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"nexoisp/api-go/internal/db"
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
	sql := func(i int) string { return RoutineSQL("runNotices", i) }
	err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
		rs, e := tx.Objects(ctx, sql(0), tenant)
		if e != nil {
			return e
		}
		t := rs[0]
		if t.Get("enabled") != true && !force {
			return nil
		}
		enabled = true
		if e = tx.Exec(ctx, sql(1), tenant, 10); e != nil {
			return e
		}
		rules, e := tx.Objects(ctx, sql(2))
		if e != nil {
			return e
		}
		for _, r := range rules {
			if numeric(t.Get("hour")) < numeric(r.Get("hour_from")) || numeric(t.Get("hour")) >= numeric(r.Get("hour_to")) {
				continue
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
			if !slices.Contains(days, numeric(t.Get("dow"))) {
				continue
			}
			cands, e := tx.Objects(ctx, sql(3), t.Get("tz"), r.Get("days_relative"), r.Get("plan_id"), r.Get("pop_id"), r.Get("tag_id"), r.Get("id"), 3, r.Get("min_interval_days"))
			if e != nil {
				return e
			}
			queued := map[string]bool{}
			for _, k := range cands {
				sid := k.Get("subscriber_id").(string)
				if queued[sid] {
					continue
				}
				contacts, e := tx.Objects(ctx, sql(4), sid)
				if e != nil {
					return e
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
				if e = tx.Exec(ctx, sql(5), tenant, r.Get("id"), k.Get("invoice_id"), k.Get("contract_id"), sid, contact, status, channel, message); e != nil {
					return e
				}
			}
		}
		return nil
	})
	if err != nil || !enabled {
		return out, err
	}
	for n := 0; n < 500; n++ {
		var job jsonx.Object
		err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
			rs, e := tx.Objects(ctx, sql(6), tenant)
			if len(rs) > 0 {
				job = rs[0]
			}
			return e
		})
		if err != nil {
			return out, err
		}
		if job == nil {
			break
		}
		channel, _ := job.Get("channel").(jsonx.Object)
		var sendErr error
		if channel == nil {
			sendErr = errors.New("canal de envio removido ou desativado")
		} else {
			sendErr = Message(ctx, channel, fmt.Sprint(job.Get("contact_value")), fmt.Sprint(job.Get("message")))
		}
		status := "sent"
		var message any
		if sendErr != nil {
			status = "failed"
			message = utf16cut(sendErr.Error(), 300)
		}
		err = database.WithScope(ctx, scope, func(tx *db.Tx) error { return tx.Exec(ctx, sql(7), job.Get("id"), status, message) })
		if err != nil {
			return out, err
		}
		counter := "sent"
		if sendErr != nil {
			counter = "failed"
		}
		out[counter] = out[counter].(int) + 1
	}
	return out, nil
}

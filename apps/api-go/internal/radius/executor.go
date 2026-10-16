// Package network records signed, versioned network intentions atomically.
package radius

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/network"
	"nexoisp/api-go/internal/tenancy"
	"os"
	"strings"
	"sync"
	"time"
)

//go:embed executor.json sql/*.sql
var executorFiles embed.FS
var queries = func() map[string][]string {
	data, err := executorFiles.ReadFile("executor.json")
	if err != nil {
		panic(err)
	}
	var list []struct {
		Path    string
		Queries []string
	}
	if err = json.Unmarshal(data, &list); err != nil {
		panic(err)
	}
	out := map[string][]string{}
	for _, entry := range list {
		out[strings.TrimPrefix(entry.Path, "helper:")] = entry.Queries
	}
	return out
}()

func query(name string, index int) string {
	data, err := executorFiles.ReadFile("sql/" + queries[name][index])
	if err != nil {
		panic(err)
	}
	if strings.Contains(string(data), "{{") {
		panic("SQL RADIUS não resolvido")
	}
	return string(data)
}
func one(ctx context.Context, tx *db.Tx, name string, index int, args ...any) (jsonx.Object, error) {
	rows, err := tx.Objects(ctx, query(name, index), args...)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

type Executor struct {
	DB        *db.DB
	mu        sync.Mutex
	watermark map[string]any
}

func (x *Executor) scope(ctx context.Context, tenant string, f func(*db.Tx) error) error {
	return x.DB.WithScope(ctx, tenancy.Scope{TenantID: tenant}, f)
}
func (x *Executor) Run(ctx context.Context, syncAccounting bool) error {
	if _, e := Key(); e != nil {
		return nil
	}
	var agents []jsonx.Object
	e := x.DB.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error { var e error; agents, e = tx.Objects(ctx, query("runHostedOnce", 0)); return e })
	if e != nil {
		return e
	}
	for _, a := range agents {
		tenant, agent := a.Get("tenant_id").(string), a.Get("agent_id").(string)
		if e = x.scope(ctx, tenant, func(tx *db.Tx) error { return tx.Exec(ctx, query("runHostedOnce", 1), agent) }); e != nil {
			return e
		}
		for i := 0; i < 200; i++ {
			var task any
			e = x.scope(ctx, tenant, func(tx *db.Tx) error { var e error; task, e = network.Reserve(ctx, tx, agent); return e })
			if e != nil {
				return e
			}
			if task == nil {
				break
			}
			encoded, e := jsonx.Encode(task)
			if e != nil {
				return e
			}
			delivery := object(jsonx.JSON(encoded))
			if e = x.execute(ctx, tenant, agent, delivery); e != nil {
				return e
			}
		}
		if syncAccounting {
			if e = x.Sync(ctx, tenant); e != nil {
				return e
			}
		}
	}
	return nil
}
func readAccount(ctx context.Context, tx *db.Tx, tenant string, user any) (jsonx.Object, error) {
	return one(ctx, tx, "readAccount", 0, tenant, user)
}
func account(ctx context.Context, tx *db.Tx, tenant string, p jsonx.Object, version, secret any, dev jsonx.Object) (jsonx.Object, []Attribute, error) {
	cur, e := readAccount(ctx, tx, tenant, p.Get("username"))
	if e != nil {
		return nil, nil, e
	}
	checks, reply, profile, blocked := attributes(fmt.Sprint(dev.Get("vendor")), p, dev.Get("down_kbps"), dev.Get("up_kbps"))
	if cur == nil && secret == nil {
		return nil, nil, fmt.Errorf("conta sem credencial no RADIUS e senha não fornecida")
	}
	if secret != nil {
		key, keyErr := Key()
		if keyErr != nil {
			return nil, nil, keyErr
		}
		e = tx.Exec(ctx, query("applyAccount", 0), tenant, p.Get("username"), secret, key, p.Get("policy"), profile, blocked, version)
	} else {
		e = tx.Exec(ctx, query("applyAccount", 1), tenant, p.Get("username"), p.Get("policy"), profile, blocked, version)
	}
	if e != nil {
		return nil, nil, e
	}
	for _, group := range []struct {
		table string
		rows  []Attribute
	}{{"radius_check", checks}, {"radius_reply", reply}} {
		if e = tx.Exec(ctx, strings.ReplaceAll(template("applyAccount", 2), "{{table}}", group.table), tenant, p.Get("username")); e != nil {
			return nil, nil, e
		}
		for _, r := range group.rows {
			if e = tx.Exec(ctx, strings.ReplaceAll(template("applyAccount", 3), "{{table}}", group.table), tenant, p.Get("username"), r.Attribute, r.Op, r.Value); e != nil {
				return nil, nil, e
			}
		}
	}
	cur, e = readAccount(ctx, tx, tenant, p.Get("username"))
	return cur, reply, e
}
func date(v any) time.Time {
	if t, ok := v.(jsonx.Time); ok {
		return t.Time
	}
	t, _ := time.Parse(time.RFC3339Nano, fmt.Sprint(v))
	return t
}
func mustDrop(p, acc, s jsonx.Object) bool {
	predates := date(s.Get("started_at")).Before(date(acc.Get("updated_at")))
	profile := acc.Get("profile")
	if predates && acc.Get("prev_profile") != nil {
		profile = acc.Get("prev_profile")
	}
	if p.Get("reconnect") == true {
		return predates
	}
	susp := object(p.Get("suspension"))
	if p.Get("policy") == "suspended" {
		if susp.Get("session") != "disconnect" {
			return false
		}
		if susp.Get("mode") == "profile" && jsonx.Truthy(susp.Get("profile")) {
			return profile != susp.Get("profile")
		}
		return true
	}
	if jsonx.Truthy(p.Get("framed_ip")) && jsonx.Truthy(s.Get("framed_ip")) && s.Get("framed_ip") != p.Get("framed_ip") {
		return true
	}
	return profile != p.Get("profile")
}
func sessionView(s jsonx.Object, profile any) any {
	if s == nil {
		return nil
	}
	seconds := max(0, int(time.Since(date(s.Get("started_at"))).Seconds()))
	days := seconds / 86400
	hours := seconds % 86400 / 3600
	minutes := seconds % 3600 / 60
	uptime := ""
	if days > 0 {
		uptime += fmt.Sprintf("%dd", days)
	}
	if hours > 0 {
		uptime += fmt.Sprintf("%dh", hours)
	}
	if minutes > 0 {
		uptime += fmt.Sprintf("%dm", minutes)
	}
	uptime += fmt.Sprintf("%ds", seconds%60)
	return map[string]any{"online": true, "ip": s.Get("framed_ip"), "caller_id": s.Get("calling_station"), "uptime": uptime, "since": s.Get("started_at"), "profile": profile}
}
func (x *Executor) execute(ctx context.Context, tenant, agent string, d jsonx.Object) error {
	env := object(jsonx.JSON([]byte(d.Get("envelope").(string))))
	p := object(env.Get("parameters"))
	attempt := d.Get("attempt_id").(string)
	var begin map[string]any
	e := x.scope(ctx, tenant, func(tx *db.Tx) error { var e error; begin, e = network.Begin(ctx, tx, agent, attempt); return e })
	if e != nil || begin["go"] != true {
		return e
	}
	steps := []map[string]any{}
	step := func(name, status string, detail any) {
		v := map[string]any{"name": name, "status": status, "at": time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}
		if detail != nil {
			v["detail"] = detail
		}
		steps = append(steps, v)
	}
	finish := func(outcome string, observed any, message any) error {
		return x.scope(ctx, tenant, func(tx *db.Tx) error {
			b := map[string]any{"outcome": outcome, "steps": steps}
			if observed != nil {
				b["observed"] = observed
			}
			if message != nil {
				b["error"] = message
			}
			r, e := network.Result(ctx, tx, agent, attempt, b)
			if e != nil {
				return e
			}
			encoded, _ := jsonx.Encode(map[string]any{"status": r["status"]})
			result := "failed"
			if outcome == "SUCCEEDED" {
				result = "ok"
			}
			return tx.Exec(ctx, query("executeOne", 0), tenant, attempt, result, encoded)
		})
	}
	var dev, acc jsonx.Object
	var sessions []jsonx.Object
	fresh, everSeen := false, false
	e = x.scope(ctx, tenant, func(tx *db.Tx) error {
		var e error
		dev, e = one(ctx, tx, "executeOne", 1, env.Get("resource_id"))
		if e != nil {
			return e
		}
		if dev == nil {
			return fmt.Errorf("concentrador sem cadastro no RADIUS integrado")
		}
		before, e := readAccount(ctx, tx, tenant, p.Get("username"))
		if e != nil {
			return e
		}
		fresh = before == nil
		if before != nil && number(before.Get("applied_version")) == number(env.Get("desired_version")) && before.Get("policy") == p.Get("policy") {
			acc = before
			step("autorização no RADIUS", "ok", "já aplicada nesta versão")
		} else {
			var reply []Attribute
			acc, reply, e = account(ctx, tx, tenant, p, env.Get("desired_version"), begin["secret"], dev)
			if e != nil {
				return e
			}
			names := []string{}
			for _, r := range reply {
				names = append(names, r.Attribute)
			}
			step("autorização no RADIUS", "ok", map[string]any{"policy": p.Get("policy"), "profile": acc.Get("profile"), "atributos": names})
		}
		seen, e := one(ctx, tx, "executeOne", 2, tenant, p.Get("username"))
		if e != nil {
			return e
		}
		everSeen = seen != nil
		sessions, e = tx.Objects(ctx, query("openSessions", 0), tenant, p.Get("username"))
		return e
	})
	fail := func(e error) error {
		message := e.Error()
		if len(message) > 300 {
			message = message[:300]
		}
		step("execução", "falha", message)
		_ = finish("FAILED", nil, message)
		return nil
	}
	if e != nil {
		return fail(e)
	}
	if e = x.scope(ctx, tenant, func(tx *db.Tx) error { _, e := network.Progress(ctx, tx, agent, attempt, "EXECUTING", steps); return e }); e != nil {
		return fail(e)
	}
	targets := []jsonx.Object{}
	ipoe := p.Get("access_type") == "ipoe"
	if !fresh && !ipoe {
		for _, session := range sessions {
			if mustDrop(p, acc, session) {
				targets = append(targets, session)
			}
		}
	}
	pending := 0
	gone := func(r DisconnectResult) bool {
		return r.Outcome == "nak" && r.Cause != nil && (*r.Cause == 503 || (dev.Get("vendor") == "mikrotik" && *r.Cause == 406))
	}
	drop := func(session jsonx.Object) DisconnectResult {
		host := dev.Get("coa_host")
		if !jsonx.Truthy(host) {
			host = dev.Get("nas_host")
		}
		sid, ip := "", ""
		if session != nil {
			sid = fmt.Sprint(session.Get("session_id"))
			if session.Get("framed_ip") != nil {
				ip = fmt.Sprint(session.Get("framed_ip"))
			}
		}
		return SendDisconnect(ctx, fmt.Sprint(host), int(number(dev.Get("coa_port"))), fmt.Sprint(dev.Get("secret")), fmt.Sprint(p.Get("username")), sid, ip)
	}
	for _, session := range targets {
		r := drop(session)
		detail := map[string]any{"sessao": session.Get("session_id")}
		if r.Outcome == "ack" {
			detail["resposta"] = "aceita pelo concentrador"
			step("desconexão da sessão", "ok", detail)
		} else if gone(r) {
			if e = x.scope(ctx, tenant, func(tx *db.Tx) error { return tx.Exec(ctx, query("executeOne", 3), session.Get("id")) }); e != nil {
				return fail(e)
			}
			detail["resposta"] = "o concentrador não tem mais essa sessão"
			step("desconexão da sessão", "ok", detail)
		} else {
			pending++
			detail["resposta"] = "sem resposta do concentrador"
			if r.Outcome == "nak" {
				cause := "?"
				if r.Cause != nil {
					cause = fmt.Sprint(*r.Cause)
				}
				detail["resposta"] = "recusada (causa " + cause + ")"
			}
			step("desconexão da sessão", "incerto", detail)
		}
	}
	wants := p.Get("reconnect") == true || (p.Get("policy") == "suspended" && object(p.Get("suspension")).Get("session") == "disconnect")
	if ipoe {
		step("desconexão da sessão", "ok", fmt.Sprintf("IPoE: vale na próxima renovação da concessão (até %g s)", leaseSeconds()))
	} else if len(targets) == 0 && wants && !fresh && !everSeen {
		r := drop(nil)
		if r.Outcome == "ack" {
			step("desconexão da sessão", "ok", map[string]any{"resposta": "aceita pelo concentrador (sessão sem registro de accounting)"})
		} else if gone(r) {
			step("desconexão da sessão", "ok", "o concentrador não tem sessão desta conta")
		} else {
			pending++
			reply := "sem resposta do concentrador"
			if r.Outcome == "nak" {
				cause := "?"
				if r.Cause != nil {
					cause = fmt.Sprint(*r.Cause)
				}
				reply = "recusada (causa " + cause + ")"
			}
			step("desconexão da sessão", "incerto", map[string]any{"resposta": reply})
		}
	} else if len(targets) == 0 {
		step("desconexão da sessão", "ok", "nenhuma sessão a tratar")
	}
	e = x.scope(ctx, tenant, func(tx *db.Tx) error {
		if _, e := network.Progress(ctx, tx, agent, attempt, "VERIFYING", steps); e != nil {
			return e
		}
		var e error
		acc, e = readAccount(ctx, tx, tenant, p.Get("username"))
		if e != nil {
			return e
		}
		sessions, e = tx.Objects(ctx, query("openSessions", 0), tenant, p.Get("username"))
		return e
	})
	if e != nil {
		return fail(e)
	}
	var last jsonx.Object
	for _, s := range sessions {
		target := false
		for _, t := range targets {
			target = target || s.Get("id") == t.Get("id")
		}
		if !target {
			last = s
		}
	}
	ok := number(acc.Get("applied_version")) == number(env.Get("desired_version")) && acc.Get("policy") == p.Get("policy") && pending == 0
	status := "falha"
	outcome := "FAILED"
	var message any = "o concentrador não confirmou a desconexão da sessão"
	if ok {
		status, outcome, message = "ok", "SUCCEEDED", nil
	}
	step("verificação", status, map[string]any{"policy": acc.Get("policy"), "profile": acc.Get("profile"), "applied_version": acc.Get("applied_version"), "sessoes_sem_desfecho": pending})
	return finish(outcome, map[string]any{"policy": acc.Get("policy"), "profile": acc.Get("profile"), "session": sessionView(last, acc.Get("profile")), "at": time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}, message)
}
func hours() int {
	n := number(os.Getenv("NEXO_USAGE_HOURLY_HOURS"))
	if n == 0 {
		n = 48
	}
	return int(min(24*31, max(24, n)))
}
func (x *Executor) Sync(ctx context.Context, tenant string) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.watermark == nil {
		x.watermark = map[string]any{}
	}
	since := x.watermark[tenant]
	var next any
	e := x.scope(ctx, tenant, func(tx *db.Tx) error {
		r, e := one(ctx, tx, "syncAccounting", 0)
		if e != nil {
			return e
		}
		next = r.Get("t")
		for i := 1; i < 7; i++ {
			args := []any{since}
			if i == 2 {
				args = []any{since, tenant, hours()}
			}
			if i == 6 {
				args = nil
			}
			if e = tx.Exec(ctx, query("syncAccounting", i), args...); e != nil {
				return e
			}
		}
		return nil
	})
	if e == nil {
		x.watermark[tenant] = next
	}
	return e
}
func Purge(ctx context.Context, tx *db.Tx, tenant string) error {
	s, e := one(ctx, tx, "purgeRadius", 0, tenant)
	if e != nil {
		return e
	}
	days := func(name string, fallback, minValue float64) float64 {
		v := number(os.Getenv(name))
		if v == 0 {
			v = fallback
		}
		return max(minValue, v)
	}
	auth, keep, notice := s.Get("a"), s.Get("s"), s.Get("n")
	if auth == nil {
		auth = days("NEXO_RADIUS_LOG_DAYS", 30, 1)
	}
	if keep == nil {
		keep = days("NEXO_SESSION_KEEP_DAYS", 400, 30)
	}
	if notice == nil {
		notice = days("NEXO_NOTICE_LOG_DAYS", 400, 30)
	}
	if e = tx.Exec(ctx, query("purgeRadius", 1), tenant, notice, 5000); e != nil {
		return e
	}
	for _, r := range []struct {
		table, col string
		days       any
	}{{"radius_postauth", "at", auth}, {"radius_acct", "stopped_at", keep}, {"service_sessions", "stopped_at", keep}} {
		sql := strings.NewReplacer("{{table}}", r.table, "{{col}}", r.col).Replace(template("purgeRadius", 2))
		if e = tx.Exec(ctx, sql, tenant, r.days, 5000); e != nil {
			return e
		}
	}
	if e = tx.Exec(ctx, query("purgeRadius", 3), tenant, hours(), 20000); e != nil {
		return e
	}
	return tx.Exec(ctx, query("purgeRadius", 4), tenant, days("NEXO_USAGE_DAILY_DAYS", 800, 400), 5000)
}

func template(name string, index int) string {
	if !((name == "applyAccount" && (index == 2 || index == 3)) || (name == "purgeRadius" && index == 2)) {
		panic("template RADIUS não autorizado")
	}
	data, e := executorFiles.ReadFile("sql/" + queries[name][index])
	if e != nil {
		panic(e)
	}
	return string(data)
}

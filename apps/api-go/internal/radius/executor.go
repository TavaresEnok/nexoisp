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

// RunOperation executes only the operation identified by a transactional River job.
func (x *Executor) RunOperation(ctx context.Context, tenant, id string) (bool, error) {
	var op jsonx.Object
	var task any
	e := x.scope(ctx, tenant, func(tx *db.Tx) error {
		rs, e := tx.Objects(ctx, `select o.agent_id,o.status from operations o join agents a on a.id=o.agent_id where o.id=$1 and a.internal`, id)
		if e != nil || len(rs) == 0 {
			return e
		}
		op = rs[0]
		if e = tx.Exec(ctx, query("runHostedOnce", 1), op.Get("agent_id")); e != nil {
			return e
		}
		task, e = network.ReserveOperation(ctx, tx, jsonx.String(op.Get("agent_id")), id)
		return e
	})
	if e != nil {
		return false, e
	}
	if op == nil {
		return true, nil
	}
	if task == nil {
		return op.Get("status") != "PENDING" && op.Get("status") != "UNCERTAIN", nil
	}
	b, e := jsonx.Encode(task)
	if e != nil {
		return false, e
	}
	e = x.execute(ctx, tenant, jsonx.String(op.Get("agent_id")), object(jsonx.JSON(b)))
	if e != nil {
		return false, e
	}
	var state string
	e = x.scope(ctx, tenant, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select status from operations where id=$1`, id).Scan(&state)
	})
	return state != "PENDING" && state != "UNCERTAIN", e
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
		limit := int(number(os.Getenv("NEXO_RADIUS_MAX_OPS_PER_TENANT")))
		if limit <= 0 {
			limit = 8
		}
		limit = min(limit, 32)
		for i := 0; i < limit; i++ {
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
	uncertain := d.Get("recover") == true
	history := map[string]disconnectMarker{}
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
			var r map[string]any
			var e error
			if outcome == "UNCERTAIN" {
				r, e = network.MarkUncertain(ctx, tx, agent, attempt, steps, jsonx.String(message))
			} else {
				r, e = network.Result(ctx, tx, agent, attempt, b)
			}
			if e != nil {
				return e
			}
			if r["ack"] == false {
				return fmt.Errorf("posse da operação mudou antes de registrar o resultado")
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
		history, e = disconnectHistory(ctx, tx, jsonx.String(env.Get("operation_id")))
		if e != nil {
			return e
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
			if d.Get("recover") == true {
				return fmt.Errorf("recuperação exige autorização já confirmável; nenhuma nova escrita será enviada")
			}
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
		seen, e := one(ctx, tx, "executeOne", 2, tenant, p.Get("username"), dev.Get("nas_host"), dev.Get("nas_device_id"))
		if e != nil {
			return e
		}
		everSeen = seen != nil
		sessions, e = tx.Objects(ctx, query("openSessions", 0), tenant, p.Get("username"), dev.Get("nas_host"), dev.Get("nas_device_id"))
		return e
	})
	fail := func(e error) error {
		message := e.Error()
		if len(message) > 300 {
			message = message[:300]
		}
		step("execução", "falha", message)
		outcome := "FAILED"
		if uncertain {
			outcome = "UNCERTAIN"
		}
		return finish(outcome, nil, message)
	}
	if e != nil {
		return fail(e)
	}
	if e = x.scope(ctx, tenant, func(tx *db.Tx) error { return persistDisconnectSteps(ctx, tx, agent, attempt, steps) }); e != nil {
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
	uncertain = false // Rebuild external uncertainty from the durable target history.
	pending := 0
	// Recover every frozen target, including a target no longer in the open list.
	for _, marker := range history {
		if marker.Outcome == "invalid" || marker.Outcome == "unavailable" || marker.Outcome == "nak" {
			continue
		}
		var closed bool
		if e = x.scope(ctx, tenant, func(tx *db.Tx) error {
			var e error
			closed, e = disconnectedByAccounting(ctx, tx, tenant, jsonx.String(p.Get("username")), marker)
			return e
		}); e != nil {
			return fail(e)
		}
		if closed {
			marker.Outcome = "observed"
			steps = append(steps, markerStep(marker))
		} else {
			pending++
			uncertain = true
			step("consulta da sessão", "incerto", "o accounting ainda não confirmou o encerramento da sessão identificada; comando não repetido")
		}
	}
	for _, session := range targets {
		marker := markerFor(session)
		if prior, exists := history[marker.AccountingID]; exists && prior.Outcome != "invalid" && prior.Outcome != "unavailable" && prior.Outcome != "nak" {
			continue
		}
		if d.Get("recover") == true {
			pending++
			prior, known := history[marker.AccountingID]
			if !known || (prior.Outcome != "invalid" && prior.Outcome != "unavailable" && prior.Outcome != "nak") {
				uncertain = true
			}
			step("desconexão da sessão", "incerto", "recuperação sem prova de envio individual: somente leitura")
			continue
		}
		if os.Getenv("NEXO_RADIUS_DISCONNECT_WRITE") != "1" {
			pending++
			step("desconexão da sessão", "pendente", "envio de Disconnect desabilitado; autorização vale para a próxima conexão")
			continue
		}
		host := dev.Get("coa_host")
		if !jsonx.Truthy(host) {
			host = dev.Get("nas_host")
		}
		ip := ""
		if session.Get("framed_ip") != nil {
			ip = jsonx.String(session.Get("framed_ip"))
		}
		wasUncertain := uncertain
		markerIndex := len(steps)
		steps = append(steps, markerStep(marker))
		uncertain = true
		if e = x.scope(ctx, tenant, func(tx *db.Tx) error { return persistDisconnectSteps(ctx, tx, agent, attempt, steps) }); e != nil {
			return fail(e)
		}
		reply := SendDisconnect(ctx, jsonx.String(host), int(number(dev.Get("coa_port"))), jsonx.String(dev.Get("secret")), jsonx.String(p.Get("username")), marker.SessionID, ip)
		marker.Outcome = reply.Outcome
		steps[markerIndex] = markerStep(marker)
		if reply.Outcome == "ack" || (reply.Outcome == "nak" && reply.Cause != nil && *reply.Cause == 503) {
			reason := "Disconnect-ACK"
			if reply.Outcome == "nak" {
				reason = "Session-Context-Not-Found"
			}
			if e = x.scope(ctx, tenant, func(tx *db.Tx) error {
				if e := closeDisconnected(ctx, tx, tenant, jsonx.String(p.Get("username")), marker, reason); e != nil {
					return e
				}
				return persistDisconnectSteps(ctx, tx, agent, attempt, steps)
			}); e != nil {
				return fail(e)
			}
			uncertain = wasUncertain
			step("desconexão da sessão", "ok", "encerramento confirmado por resposta autenticada do concentrador")
		} else {
			pending++
			if reply.Outcome != "timeout" {
				uncertain = wasUncertain
			}
			detail := map[string]any{"resultado": reply.Outcome}
			if reply.Cause != nil {
				detail["causa"] = *reply.Cause
			}
			step("desconexão da sessão", "pendente", detail)
			if e = x.scope(ctx, tenant, func(tx *db.Tx) error { return persistDisconnectSteps(ctx, tx, agent, attempt, steps) }); e != nil {
				return fail(e)
			}
		}
	}
	wants := p.Get("reconnect") == true || (p.Get("policy") == "suspended" && object(p.Get("suspension")).Get("session") == "disconnect")
	if ipoe {
		step("desconexão da sessão", "ok", fmt.Sprintf("IPoE: autorização vale na próxima renovação (até %g s)", leaseSeconds()))
	} else if len(targets) == 0 && wants && !fresh && !everSeen {
		pending++
		uncertain = true
		step("desconexão da sessão", "incerto", "sem identidade de accounting: nenhum Disconnect genérico por usuário foi enviado")
	} else if d.Get("recover") == true && wants && len(history) == 0 {
		pending++
		uncertain = true
		step("consulta da sessão", "incerto", "tentativa anterior sem journal de desconexão; não presumir efeito nem repetir")
	} else if len(targets) == 0 && pending == 0 {
		step("desconexão da sessão", "ok", "nenhuma sessão identificada exige desconexão")
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
		sessions, e = tx.Objects(ctx, query("openSessions", 0), tenant, p.Get("username"), dev.Get("nas_host"), dev.Get("nas_device_id"))
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
	if pending > 0 && uncertain {
		outcome = "UNCERTAIN"
	}
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
		// The mutex covers one process. Hold this tenant lock until commit so a
		// concurrent replica reads the stored service_sessions and adds a zero delta.
		if e := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1,77))`, "nexo-radius-usage:"+tenant); e != nil {
			return e
		}
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
		protection := ""
		// Unknown Disconnects retain the exact accounting proof needed for recovery.
		if r.table == "radius_acct" {
			protection = ` and not exists(select 1 from operation_attempts a join operations o on o.id=a.operation_id cross join lateral jsonb_array_elements(a.steps) item where o.tenant_id=$1 and o.status in ('RESERVED','EXECUTING','VERIFYING','UNCERTAIN') and item->'radius_disconnect'->>'accounting_id'=radius_acct.id::text)`
		}
		sql := strings.NewReplacer("{{table}}", r.table, "{{col}}", r.col, "{{protection}}", protection).Replace(template("purgeRadius", 2))
		if e = tx.Exec(ctx, sql, tenant, r.days, 5000); e != nil {
			return e
		}
	}
	if e = tx.Exec(ctx, `select radius_purge_accounting_events($1,5000)`, days("NEXO_RADIUS_EVENT_KEEP_DAYS", 60, 35)); e != nil {
		return e
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

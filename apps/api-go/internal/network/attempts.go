package network

import (
	"context"
	"fmt"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/domain"
	"nexoisp/api-go/internal/jsonx"
	"slices"
	"strings"
	"time"
)

func Reserve(ctx context.Context, tx *db.Tx, agent string) (any, error) {
	return ReserveOperation(ctx, tx, agent, "")
}
func ReserveOperation(ctx context.Context, tx *db.Tx, agent, operation string) (any, error) {
	if err := Sweep(ctx, tx); err != nil {
		return nil, err
	}
	find := func(status string) (jsonx.Object, error) {
		if operation == "" {
			return one(ctx, tx, "reserve", 0, agent, status)
		}
		sql := strings.Replace(query("reserve", 0), "where o.agent_id = $1", "where o.id = $3 and o.agent_id = $1", 1)
		rs, e := tx.Objects(ctx, sql, agent, status, operation)
		if len(rs) > 0 {
			return rs[0], e
		}
		return nil, e
	}
	op, err := find("UNCERTAIN")
	if err != nil {
		return nil, err
	}
	if op == nil {
		op, err = find("PENDING")
		if err != nil {
			return nil, err
		}
	}
	if op == nil {
		return nil, nil
	}
	recover := op.Get("status") == "UNCERTAIN"
	attempt, err := one(ctx, tx, "reserve", 1, op.Get("tenant_id"), op.Get("id"), agent, recover)
	if err != nil {
		return nil, err
	}
	if err = tx.Exec(ctx, query("reserve", 2), op.Get("id"), attempt.Get("id")); err != nil {
		return nil, err
	}
	return map[string]any{"attempt_id": attempt.Get("id"), "recover": recover, "envelope": op.Get("envelope"), "signature": op.Get("signature")}, nil
}
func lockAttempt(ctx context.Context, tx *db.Tx, agent, attempt string) (jsonx.Object, error) {
	row, err := one(ctx, tx, "lockAttempt", 0, attempt, agent)
	if err == nil && row == nil {
		err = apierr.New(404, "tentativa não encontrada")
	}
	return row, err
}
func finishAttempt(ctx context.Context, tx *db.Tx, id, status string, steps any) error {
	var raw any
	if jsonx.Truthy(steps) {
		v, err := encode(steps)
		if err != nil {
			return err
		}
		raw = v
	}
	return tx.Exec(ctx, query("finishAttempt", 0), id, status, raw)
}
func Begin(ctx context.Context, tx *db.Tx, agent, attempt string) (map[string]any, error) {
	op, err := lockAttempt(ctx, tx, agent, attempt)
	if err != nil {
		return nil, err
	}
	no := func(reason string) map[string]any { return map[string]any{"go": false, "reason": reason} }
	if op.Get("status") != "RESERVED" || op.Get("current_attempt_id") != attempt {
		return no("not_owner"), nil
	}
	if op.Get("lease_expired") == true {
		if op.Get("attempt_recover") == true {
			_, err := MarkUncertain(ctx, tx, agent, attempt, []any{}, "reserva de recuperação expirou; efeito anterior preservado")
			return no("recovery_lease_expired"), err
		}
		if err = tx.Exec(ctx, query("begin", 0), op.Get("id")); err != nil {
			return nil, err
		}
		return no("lease_expired"), finishAttempt(ctx, tx, attempt, "ABANDONED", nil)
	}
	index, id := 2, op.Get("resource_id")
	if op.Get("onu_id") != nil {
		index, id = 1, op.Get("onu_id")
	}
	r, err := one(ctx, tx, "begin", index, id)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, fmt.Errorf("recurso de operação ausente")
	}
	stop := func(status, note, reason string) (map[string]any, error) {
		if err := tx.Exec(ctx, query("begin", 3), op.Get("id"), status, note); err != nil {
			return nil, err
		}
		return no(reason), finishAttempt(ctx, tx, attempt, status, nil)
	}
	if number(r.Get("desired_version")) != number(op.Get("desired_version")) {
		if op.Get("attempt_recover") == true {
			_, err := MarkUncertain(ctx, tx, agent, attempt, []any{}, "versão mudou durante efeito desconhecido; revisão sem novo comando")
			return no("recovery_version_changed"), err
		}
		return stop("SUPERSEDED", fmt.Sprintf("intenção atual é a versão %s; esta tarefa (v%s) não foi aplicada", jsonx.String(r.Get("desired_version")), jsonx.String(op.Get("desired_version"))), "superseded")
	}
	if op.Get("validity_expired") == true && !(op.Get("attempt_recover") == true && op.Get("internal_agent") == true) {
		if op.Get("attempt_recover") == true {
			_, err := MarkUncertain(ctx, tx, agent, attempt, []any{}, "efeito anterior sem confirmação após validade; revisão de recuperação necessária")
			return no("recovery_expired"), err
		}
		return stop("EXPIRED", "prazo de validade vencido", "expired")
	}
	if op.Get("action") != "subscriber.suspend" && op.Get("action") != "onu.deauthorize" && r.Get("contract_status") != "active" && !(op.Get("attempt_recover") == true && op.Get("internal_agent") == true) {
		if op.Get("attempt_recover") == true {
			_, err := MarkUncertain(ctx, tx, agent, attempt, []any{}, "contrato encerrado durante efeito desconhecido; revisão de recuperação necessária")
			return no("recovery_contract_changed"), err
		}
		return stop("CANCELED", "contrato não está mais vigente", "contract_ineligible")
	}
	if r.Get("maintenance") == true && !(op.Get("attempt_recover") == true && op.Get("internal_agent") == true) {
		if op.Get("attempt_recover") == true {
			_, err := MarkUncertain(ctx, tx, agent, attempt, []any{}, "equipamento em manutenção; efeito anterior preservado para conferência")
			return no("recovery_maintenance"), err
		}
		if err = tx.Exec(ctx, query("begin", 4), op.Get("id")); err != nil {
			return nil, err
		}
		return no("maintenance"), finishAttempt(ctx, tx, attempt, "ABANDONED", nil)
	}
	if err = tx.Exec(ctx, query("begin", 5), op.Get("id")); err != nil {
		return nil, err
	}
	if err = tx.Exec(ctx, query("begin", 6), attempt); err != nil {
		return nil, err
	}
	out := map[string]any{"go": true}
	if op.Get("action") == "subscriber.provision" && jsonx.Truthy(r.Get("secret_enc")) {
		secret, err := cryptox.DecryptSecret(r.Get("secret_enc").(string))
		if err != nil {
			return nil, err
		}
		out["secret"] = secret
	}
	return out, nil
}
func Progress(ctx context.Context, tx *db.Tx, agent, attempt, status string, steps any) (map[string]any, error) {
	op, err := lockAttempt(ctx, tx, agent, attempt)
	if err != nil {
		return nil, err
	}
	if !slices.Contains([]any{"EXECUTING", "VERIFYING"}, op.Get("status")) || op.Get("current_attempt_id") != attempt {
		return map[string]any{"ok": false}, nil
	}
	if err = tx.Exec(ctx, query("progress", 0), op.Get("id"), status); err != nil {
		return nil, err
	}
	if steps == nil {
		steps = []any{}
	}
	raw, err := encode(steps)
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, tx.Exec(ctx, query("progress", 1), attempt, status, raw)
}
func ApplyObservation(ctx context.Context, tx *db.Tx, id any, obs map[string]any, confirmed any) error {
	var session any
	if jsonx.Truthy(obs["session"]) {
		raw, err := encode(obs["session"])
		if err != nil {
			return err
		}
		session = raw
	}
	return tx.Exec(ctx, query("applyObservation", 0), id, obs["policy"], obs["profile"], session, obs["at"], confirmed)
}
func ApplyOnuObservation(ctx context.Context, tx *db.Tx, id any, obs map[string]any, confirmed any) error {
	var detail any
	if jsonx.Truthy(obs["detail"]) {
		raw, err := encode(obs["detail"])
		if err != nil {
			return err
		}
		detail = raw
	}
	return tx.Exec(ctx, query("applyOnuObservation", 0), id, obs["state"], obs["online"], obs["rx_dbm"], obs["tx_dbm"], detail, obs["at"], confirmed)
}
func Result(ctx context.Context, tx *db.Tx, agent, attempt string, b map[string]any) (map[string]any, error) {
	op, err := lockAttempt(ctx, tx, agent, attempt)
	if err != nil {
		return nil, err
	}
	status := op.Get("status")
	duplicate := func() map[string]any { return map[string]any{"ack": true, "duplicate": true, "status": status} }
	if !slices.Contains([]any{"PENDING", "RESERVED", "EXECUTING", "VERIFYING", "UNCERTAIN"}, status) {
		return duplicate(), nil
	}
	if status == "PENDING" && op.Get("current_attempt_id") != attempt && b["outcome"] != "SUCCEEDED" {
		return duplicate(), nil
	}
	observed := b["observed"]
	if observed == nil {
		observed = b["onu_observed"]
	}
	recovered := b["recovered"] == true
	res := map[string]any{"outcome": b["outcome"], "steps": b["steps"], "observed": observed, "error": b["error"], "recovered": recovered, "attempt_id": attempt}
	raw, err := encode(res)
	if err != nil {
		return nil, err
	}
	var confirmed any
	if b["outcome"] == "SUCCEEDED" {
		confirmed = op.Get("desired_version")
	}
	if b["observed"] != nil && op.Get("resource_id") != nil {
		if err = ApplyObservation(ctx, tx, op.Get("resource_id"), b["observed"].(map[string]any), confirmed); err != nil {
			return nil, err
		}
	}
	if b["onu_observed"] != nil && op.Get("onu_id") != nil {
		if err = ApplyOnuObservation(ctx, tx, op.Get("onu_id"), b["onu_observed"].(map[string]any), confirmed); err != nil {
			return nil, err
		}
	}
	if b["outcome"] == "SUCCEEDED" {
		var note any
		if recovered {
			note = "efeito confirmado por consulta, sem repetir o comando"
		}
		if err = tx.Exec(ctx, query("result", 0), op.Get("id"), raw, note); err != nil {
			return nil, err
		}
		if err = finishAttempt(ctx, tx, attempt, "SUCCEEDED", b["steps"]); err != nil {
			return nil, err
		}
		return map[string]any{"ack": true, "status": "SUCCEEDED"}, accessEvent(ctx, tx, op, "confirmed", nil)
	}
	index, id := 2, op.Get("resource_id")
	if op.Get("onu_id") != nil {
		index, id = 1, op.Get("onu_id")
	}
	current, err := one(ctx, tx, "result", index, id)
	if err != nil {
		return nil, err
	}
	if current == nil {
		return nil, fmt.Errorf("recurso de operação ausente")
	}
	target, note := "PENDING", any(nil)
	if number(current.Get("desired_version")) != number(op.Get("desired_version")) {
		target = "SUPERSEDED"
		note = "não aplicada; intenção atual é a versão " + jsonx.String(current.Get("desired_version"))
	} else if b["outcome"] == "NOT_APPLIED" {
		note = "consulta confirmou que o efeito não ocorreu; nova tentativa liberada"
	} else if number(op.Get("attempts")) >= 5 {
		target = "FAILED"
		note = b["error"]
		if note == nil {
			note = "falha após tentativas"
		}
	} else {
		message := b["error"]
		if message == nil {
			message = "erro"
		}
		note = "tentativa " + jsonx.String(op.Get("attempts")) + " falhou: " + jsonx.String(message)
	}
	if err = tx.Exec(ctx, query("result", 3), op.Get("id"), target, note, raw, b["outcome"] == "FAILED"); err != nil {
		return nil, err
	}
	if err = finishAttempt(ctx, tx, attempt, b["outcome"].(string), b["steps"]); err != nil {
		return nil, err
	}
	if target == "FAILED" {
		if err = accessEvent(ctx, tx, op, "failed", note); err != nil {
			return nil, err
		}
	}
	return map[string]any{"ack": true, "status": target}, nil
}
func accessEvent(ctx context.Context, tx *db.Tx, op jsonx.Object, outcome string, message any) error {
	if op.Get("resource_id") == nil || op.Get("action") != "subscriber.suspend" && op.Get("action") != "subscriber.resume" {
		return nil
	}
	r, err := one(ctx, tx, "accessEvent", 0, op.Get("resource_id"))
	if err != nil || r == nil {
		return err
	}
	data := map[string]any{"contract_id": r.Get("contract_id"), "operation_id": op.Get("id")}
	event := "access.resumed"
	if outcome == "failed" {
		event = "access.change_failed"
		data["action"] = "resume"
		if op.Get("action") == "subscriber.suspend" {
			data["action"] = "suspend"
		}
		data["error"] = message
	} else if op.Get("action") == "subscriber.suspend" {
		event = "access.suspended"
		data["stage"] = r.Get("desired_stage")
		if data["stage"] == nil {
			data["stage"] = "blocked"
		}
	}
	return domain.Emit(ctx, tx, op.Get("tenant_id").(string), event, data)
}
func RequestONU(ctx context.Context, tx *db.Tx, tenant, onu, action string, authz Authz) (jsonx.Object, error) {
	const name = "requestOnuOperation"
	n, err := one(ctx, tx, name, 0, onu)
	if err != nil {
		return nil, err
	}
	if n == nil {
		return nil, apierr.New(404, "ONU não encontrada")
	}
	var unresolved bool
	if err = tx.QueryRow(ctx, `select exists(select 1 from operations where onu_id=$1 and status in ('RESERVED','EXECUTING','VERIFYING','UNCERTAIN'))`, onu).Scan(&unresolved); err != nil {
		return nil, err
	}
	if unresolved {
		return nil, apierr.New(409, "ONU possui operação em execução ou efeito desconhecido; aguarde confirmação antes de nova intenção")
	}
	if n.Get("agent_id") == nil {
		return nil, apierr.New(400, fmt.Sprintf("OLT \"%v\" não tem agente associado", n.Get("device_name")))
	}
	if action == "onu.authorize" && n.Get("contract_status") != "active" {
		return nil, apierr.New(400, "contrato encerrado: a ONU não pode ser autorizada")
	}
	state := "removed"
	if action == "onu.authorize" {
		state = "authorized"
	}
	version := number(n.Get("desired_version")) + 1
	if err = tx.Exec(ctx, query(name, 1), onu, version, state, authz.Reason); err != nil {
		return nil, err
	}
	if err = tx.Exec(ctx, query(name, 2), onu, jsonx.String(version)); err != nil {
		return nil, err
	}
	identity, err := one(ctx, tx, name, 3)
	if err != nil {
		return nil, err
	}
	id := identity.Get("id")
	validUntil := time.Now().Add(24 * time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")
	parameters := jsonx.Object{{Name: "serial", Value: n.Get("serial")}, {Name: "pon_port", Value: n.Get("pon_port")}, {Name: "line_profile", Value: n.Get("line_profile")}, {Name: "service_profile", Value: n.Get("service_profile")}, {Name: "service_vlan", Value: n.Get("service_vlan")}, {Name: "state", Value: state}, {Name: "description", Value: "nexo:" + onu[:8] + ":v" + jsonx.String(version)}}
	key := "onu:" + onu + ":v" + jsonx.String(version)
	authorization := jsonx.Object{{Name: "type", Value: authz.Type}, {Name: "id", Value: authz.ID}}
	envelope, err := encode(jsonx.Object{{Name: "operation_id", Value: id}, {Name: "tenant_id", Value: tenant}, {Name: "resource_id", Value: onu}, {Name: "device_id", Value: n.Get("device_id")}, {Name: "agent_id", Value: n.Get("agent_id")}, {Name: "action", Value: action}, {Name: "schema_version", Value: 1}, {Name: "desired_version", Value: version}, {Name: "parameters", Value: parameters}, {Name: "idempotency_key", Value: key}, {Name: "valid_until", Value: validUntil}, {Name: "authorization", Value: authorization}})
	if err != nil {
		return nil, err
	}
	signature, err := cryptox.SignEnvelope(envelope)
	if err != nil {
		return nil, err
	}
	params, err := encode(parameters)
	if err != nil {
		return nil, err
	}
	auth, err := encode(authorization)
	if err != nil {
		return nil, err
	}
	return one(ctx, tx, name, 4, id, tenant, onu, n.Get("device_id"), n.Get("agent_id"), action, version, params, key, validUntil, auth, envelope, signature, authz.Reason)
}

// MarkUncertain preserves an internal executor's unknown external effect. It
// cannot be turned into FAILED/PENDING simply by exhausting automatic retries.
func MarkUncertain(ctx context.Context, tx *db.Tx, agent, attempt string, steps any, message string) (map[string]any, error) {
	op, err := lockAttempt(ctx, tx, agent, attempt)
	if err != nil {
		return nil, err
	}
	if op.Get("current_attempt_id") != attempt || !(slices.Contains([]any{"EXECUTING", "VERIFYING"}, op.Get("status")) || (op.Get("status") == "RESERVED" && op.Get("attempt_recover") == true)) {
		return map[string]any{"ack": false}, nil
	}
	raw, err := encode(map[string]any{"outcome": "UNCERTAIN", "steps": steps, "error": message, "attempt_id": attempt})
	if err != nil {
		return nil, err
	}
	if err = tx.Exec(ctx, `update operations set status='UNCERTAIN',result=$2,note=$3,lease_until=null,current_attempt_id=null,next_attempt_at=now()+interval '30 seconds',updated_at=now(),finished_at=null where id=$1`, op.Get("id"), raw, message); err != nil {
		return nil, err
	}
	if err = finishAttempt(ctx, tx, attempt, "UNCERTAIN", steps); err != nil {
		return nil, err
	}
	return map[string]any{"ack": true, "status": "UNCERTAIN"}, nil
}

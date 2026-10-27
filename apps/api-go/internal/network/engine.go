// Package network records signed, versioned network intentions atomically.
package network

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/domain"
	"nexoisp/api-go/internal/jsonx"
	"regexp"
	"strconv"
	"strings"
	"time"
)

//go:embed motor.json sql/*.sql
var files embed.FS
var queries = func() map[string][]string {
	data, err := files.ReadFile("motor.json")
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
	data, err := files.ReadFile("sql/" + queries[name][index])
	if err != nil {
		panic(err)
	}
	if strings.Contains(string(data), "{{") {
		panic("SQL de rede não resolvido")
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
func number(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int32:
		return float64(n)
	case int64:
		return float64(n)
	case int:
		return float64(n)
	}
	return 0
}
func encode(value any) (string, error) { data, err := jsonx.Encode(value); return string(data), err }
func AgentAtLeast(version any, minimum string) bool {
	parts := func(v string) []int {
		out := []int{}
		for _, piece := range strings.Split(v, ".") {
			digits := regexp.MustCompile(`^[+-]?\d+`).FindString(piece)
			n, _ := strconv.Atoi(digits)
			out = append(out, n)
		}
		for len(out) < 3 {
			out = append(out, 0)
		}
		return out
	}
	actual := parts(jsonx.String(version))
	wanted := parts(minimum)
	for i := 0; i < 3; i++ {
		if actual[i] != wanted[i] {
			return actual[i] > wanted[i]
		}
	}
	return true
}

type Authz struct {
	Type, ID string
	Reason   any
}

func Request(ctx context.Context, tx *db.Tx, tenant, resource, action string, authz Authz, idempotency, requestedStage string) (jsonx.Object, error) {
	const name = "requestOperation"
	r, err := one(ctx, tx, name, 0, resource)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, apierr.New(404, "conta PPPoE não encontrada")
	}
	if idempotency != "" {
		dup, err := one(ctx, tx, name, 1, idempotency)
		if err != nil {
			return nil, err
		}
		if dup != nil {
			return dup, nil
		}
	}
	var unresolved bool
	if err = tx.QueryRow(ctx, `select exists(select 1 from operations where resource_id=$1 and status in ('RESERVED','EXECUTING','VERIFYING','UNCERTAIN'))`, resource).Scan(&unresolved); err != nil {
		return nil, err
	}
	if unresolved {
		return nil, apierr.New(409, "recurso possui operação em execução ou efeito desconhecido; aguarde confirmação antes de nova intenção")
	}
	if r.Get("agent_id") == nil {
		return nil, apierr.New(400, fmt.Sprintf("equipamento \"%v\" não tem agente associado", r.Get("device_name")))
	}
	disconnect := action == "subscriber.disconnect"
	if action != "subscriber.suspend" && !disconnect && r.Get("contract_status") != "active" {
		return nil, apierr.New(400, "contrato encerrado não pode ser provisionado ou reativado")
	}
	if disconnect && number(r.Get("desired_version")) == 0 {
		return nil, apierr.New(400, "a conta ainda não foi provisionada: não há sessão a derrubar")
	}
	var stage any
	if requestedStage != "" {
		stage = requestedStage
	}
	if disconnect {
		stage = r.Get("desired_stage")
	}
	if action == "subscriber.provision" && (r.Get("secret_enc") == nil || r.Get("secret_enc") == "") {
		return nil, apierr.New(400, "credencial PPPoE indisponível: defina a senha antes de provisionar")
	}
	policy := r.Get("desired_policy")
	if action == "subscriber.suspend" {
		policy = "suspended"
	} else if action == "subscriber.resume" {
		policy = "active"
	}
	version := number(r.Get("desired_version")) + 1
	reason := authz.Reason
	if disconnect {
		reason = r.Get("desired_reason")
	}
	var desiredStage any
	if policy == "suspended" {
		desiredStage = stage
		if desiredStage == nil {
			desiredStage = "blocked"
		}
	}
	if err = tx.Exec(ctx, query(name, 2), resource, version, policy, r.Get("profile_name"), reason, desiredStage, disconnect); err != nil {
		return nil, err
	}
	if err = tx.Exec(ctx, query(name, 3), resource, jsonx.String(version)); err != nil {
		return nil, err
	}
	identity, err := one(ctx, tx, name, 4)
	if err != nil {
		return nil, err
	}
	id := identity.Get("id")
	validUntil := time.Now().Add(24 * time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")
	fixed, err := one(ctx, tx, name, 5, r.Get("contract_id"))
	if err != nil {
		return nil, err
	}
	var suspension any
	agentVersion := r.Get("agent_version")
	displayVersion := agentVersion
	if displayVersion == nil {
		displayVersion = "desconhecida"
	}
	if policy == "suspended" {
		settings, err := one(ctx, tx, name, 6, tenant)
		if err != nil {
			return nil, err
		}
		suspension = jsonx.Object{{Name: "mode", Value: "reject"}, {Name: "session", Value: "disconnect"}}
		if stage == "reduced" && r.Get("contract_status") == "active" {
			if r.Get("reduced_profile") == nil || r.Get("reduced_profile") == "" {
				return nil, apierr.New(400, "o plano não tem perfil de velocidade reduzida configurado")
			}
			if !AgentAtLeast(agentVersion, "0.4.0") {
				return nil, apierr.New(409, fmt.Sprintf("o agente do equipamento \"%v\" (versão %v) não suporta velocidade reduzida; atualize para 0.4.0", r.Get("device_name"), displayVersion))
			}
			suspension = jsonx.Object{{Name: "mode", Value: "profile"}, {Name: "profile", Value: r.Get("reduced_profile")}, {Name: "session", Value: "disconnect"}}
		} else if settings.Get("suspension_mode") == "profile" && r.Get("contract_status") == "active" {
			if !AgentAtLeast(agentVersion, "0.4.0") {
				return nil, apierr.New(409, fmt.Sprintf("o agente do equipamento \"%v\" (versão %v) não suporta suspensão por perfil; atualize para 0.4.0 ou use a modalidade de rejeição", r.Get("device_name"), displayVersion))
			}
			suspension = jsonx.Object{{Name: "mode", Value: "profile"}, {Name: "profile", Value: settings.Get("suspension_profile")}, {Name: "session", Value: "disconnect"}}
		}
	}
	var secretRef any
	if action == "subscriber.provision" {
		secretRef = "resource:" + resource
	}
	params := jsonx.Object{{Name: "username", Value: r.Get("pppoe_username")}, {Name: "profile", Value: r.Get("profile_name")}, {Name: "policy", Value: policy}, {Name: "secret_ref", Value: secretRef}, {Name: "suspension", Value: suspension}}
	profileSuspension := false
	if v, ok := suspension.(jsonx.Object); ok {
		profileSuspension = v.Get("mode") == "profile"
	}
	if fixed != nil && !profileSuspension {
		params.Set("framed_ip", fixed.Get("ip"))
	}
	if r.Get("mac") != nil && r.Get("mac") != "" {
		params.Set("mac", r.Get("mac"))
	}
	// Prefixo IPv6 delegado (IPAM) entregue como Delegated-IPv6-Prefix. Só o
	// RADIUS integrado e agentes 0.6.0+ recebem o parâmetro.
	if !profileSuspension && policy != "suspended" {
		delegated, err := tx.Objects(ctx, "select host(prefix) || '/' || masklen(prefix) as prefix from ip6_delegations where contract_id = $1", r.Get("contract_id"))
		if err != nil {
			return nil, err
		}
		if len(delegated) > 0 {
			if r.Get("agent_internal") != true && !AgentAtLeast(agentVersion, "0.6.0") {
				return nil, apierr.New(409, "delegação IPv6 exige agente 0.6.0 ou superior; atualize o agente antes de provisionar")
			}
			params.Set("delegated_ipv6_prefix", delegated[0].Get("prefix"))
		}
	}
	if disconnect {
		params.Set("reconnect", true)
	}
	for _, key := range []string{"rate_limit", "address_pool", "simultaneous_use", "acct_interim_seconds"} {
		v := r.Get(key)
		if v != nil && v != "" && v != float64(0) && v != int32(0) {
			name := key
			if key == "acct_interim_seconds" {
				name = "acct_interim"
			}
			params.Set(name, v)
		}
	}
	if r.Get("access_type") != "pppoe" {
		params.Set("access_type", r.Get("access_type"))
		if r.Get("agent_internal") != true {
			access := "hotspot"
			if r.Get("access_type") == "ipoe" {
				access = "IPoE"
			}
			return nil, apierr.New(409, "acesso "+access+" só funciona com o concentrador no RADIUS integrado")
		}
	}
	hasParams := disconnect
	for _, key := range []string{"rate_limit", "address_pool", "simultaneous_use", "acct_interim_seconds"} {
		v := r.Get(key)
		if v != nil && v != "" && v != float64(0) && v != int32(0) {
			hasParams = true
		}
	}
	if hasParams && !AgentAtLeast(agentVersion, "0.5.0") {
		what := "os parâmetros de rede do plano/NAS"
		if disconnect {
			what = "desconexão pedida"
		}
		return nil, apierr.New(409, fmt.Sprintf("o agente do equipamento \"%v\" (versão %v) não suporta %s; atualize para 0.5.0", r.Get("device_name"), displayVersion, what))
	}
	if r.Get("mac") != nil && r.Get("mac") != "" && !AgentAtLeast(agentVersion, "0.4.0") {
		return nil, apierr.New(409, fmt.Sprintf("o agente do equipamento \"%v\" (versão %v) não suporta vínculo de MAC; atualize para 0.4.0 ou remova o MAC", r.Get("device_name"), displayVersion))
	}
	key := idempotency
	if key == "" {
		key = resource + ":v" + jsonx.String(version)
	}
	authorization := jsonx.Object{{Name: "type", Value: authz.Type}, {Name: "id", Value: authz.ID}}
	envelope, err := encode(jsonx.Object{{Name: "operation_id", Value: id}, {Name: "tenant_id", Value: tenant}, {Name: "resource_id", Value: resource}, {Name: "device_id", Value: r.Get("device_id")}, {Name: "agent_id", Value: r.Get("agent_id")}, {Name: "action", Value: action}, {Name: "schema_version", Value: 1}, {Name: "desired_version", Value: version}, {Name: "parameters", Value: params}, {Name: "idempotency_key", Value: key}, {Name: "valid_until", Value: validUntil}, {Name: "authorization", Value: authorization}})
	if err != nil {
		return nil, err
	}
	signature, err := cryptox.SignEnvelope(envelope)
	if err != nil {
		return nil, err
	}
	paramsJSON, err := encode(params)
	if err != nil {
		return nil, err
	}
	authorizationJSON, err := encode(authorization)
	if err != nil {
		return nil, err
	}
	op, err := one(ctx, tx, name, 7, id, tenant, resource, r.Get("device_id"), r.Get("agent_id"), action, version, paramsJSON, key, validUntil, authorizationJSON, envelope, signature, authz.Reason)
	if err != nil {
		return nil, err
	}
	if r.Get("agent_internal") == true {
		if err = tx.EnqueueOperation(ctx, tenant, jsonx.String(id)); err != nil {
			return nil, err
		}
	}
	if action == "subscriber.suspend" || action == "subscriber.resume" {
		event := "access.resume_requested"
		if action == "subscriber.suspend" {
			event = "access.suspend_requested"
		}
		if err = domain.Emit(ctx, tx, tenant, event, map[string]any{"contract_id": r.Get("contract_id"), "operation_id": id, "stage": desiredStage, "reason": authz.Reason}); err != nil {
			return nil, err
		}
	}
	return op, nil
}
func Sweep(ctx context.Context, tx *db.Tx) error {
	for i := 0; i < 3; i++ {
		if err := tx.Exec(ctx, query("sweep", i)); err != nil {
			return err
		}
	}
	return nil
}

package escrita

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/audit"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/network"
	"nexoisp/api-go/internal/validate"
)

func (s Service) networkOperations(ops map[string]operation) {
	f, o, str, n, b, e := validate.F, validate.Object, validate.String, validate.Number, validate.Boolean, validate.Enum
	uuid := str().UUID()
	ops["POST /api/agents"] = operation{s.createAgent, obj(o(f("name", str().Trimmed().Min(2).Max(80))))}
	ops["PATCH /api/agents/:id"] = operation{s.updateAgent, obj(o(f("status", e("active", "revoked").Opt()), f("rotate_token", b().Opt()), f("reset_certificate", b().Opt())))}
	device := []validate.Field{f("name", str().Trimmed().Min(2).Max(80)), f("driver", e("demo", "mikrotik_radius", "olt_demo", "olt_huawei", "radius")), f("host", text(200).Nullish().Then(nilEmpty, true)), f("api_port", n().Int().Min(1).Max(65535).Nullish()), f("credential_ref", str().Trimmed().Pattern(`^[A-Za-z0-9_.-]{0,60}$`, "").Nullish().Then(nilEmpty, true)), f("agent_id", uuid.Nullish()), f("simultaneous_use", n().Int().Min(1).Max(10).Nullish()), f("acct_interim_seconds", n().Int().Min(60).Max(3600).Nullish())}
	ops["POST /api/devices"] = operation{s.createDevice, obj(o(device...))}
	partial := []validate.Field{}
	for _, field := range device {
		rule := field.Rule.Opt()
		rule.TransformMissing = false
		partial = append(partial, f(field.Name, rule))
	}
	partial = append(partial, f("maintenance", b().Opt()))
	ops["PATCH /api/devices/:id"] = operation{s.updateDevice, obj(o(partial...))}
	ops["POST /api/devices/:id/reapply"] = operation{s.reapplyDevice, nil}
	ops["GET /api/contracts/:id/service"] = operation{s.contractService, nil}
	ops["POST /api/contracts/:id/service"] = operation{s.provisionService, obj(o(f("device_id", uuid), f("access_type", e("pppoe", "ipoe", "hotspot").Def("pppoe")), f("pppoe_username", str().Trimmed().Pattern(`^[A-Za-z0-9_.@-]{3,64}$`, "usuário: 3 a 64 caracteres (letras, números, _ . @ -)").Opt()), f("mac", str().Trimmed().Opt()), f("password", str().Min(6, "senha: mínimo de 6 caracteres").Max(64).Opt())))}
	ops["POST /api/resources/:id/:action"] = operation{s.resourceAction, obj(o(f("reason", text(200).Opt())))}
	ops["PUT /api/plans/:id/network"] = operation{s.planNetwork, obj(o(f("rate_limit", str().Trimmed().Pattern(`^\d{1,7}[kKmM]?/\d{1,7}[kKmM]?( \d{1,7}[kKmM]?/\d{1,7}[kKmM]?){0,3}( [1-8]( \d{1,7}[kKmM]?/\d{1,7}[kKmM]?)?)?$`, "velocidade no formato do MikroTik: subida/descida [rajada limiar tempo prioridade mínimo], ex.: 50M/100M 60M/120M 40M/80M 10/10").Null()), f("address_pool", str().Trimmed().Pattern(`^[A-Za-z0-9_.-]{1,60}$`, "pool: letras, números, _ . - (até 60)").Null())))}
	ops["POST /api/plans/:id/reapply"] = operation{nil, nil}
	ops["PATCH /api/resources/:id/mac"] = operation{s.resourceMAC, obj(o(f("mac", str().Trimmed().Apply(func(v any) any { return strings.NewReplacer("-", ":", ".", ":").Replace(strings.ToUpper(v.(string))) }).Pattern(`^([0-9A-F]{2}:){5}[0-9A-F]{2}$`, "MAC inválido (ex.: 02:4E:58:00:00:02)").Null())))}
	ops["PATCH /api/resources/:id/secret"] = operation{s.resourceSecret, obj(o(f("password", str().Min(6).Max(64))))}
	ops["GET /api/operations"] = operation{s.operationsList, nil}
	ops["GET /api/operations/:id"] = operation{s.operationDetail, nil}
	ops["GET /api/network/health"] = operation{s.networkHealth, nil}
}
func (s Service) createAgent(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	token, err := cryptox.RandomToken(32)
	if err != nil {
		return nil, err
	}
	row, err := one(ctx, tx, "POST /api/agents", 0, auth.From(ctx).TenantID, b["name"], cryptox.SHA256(token))
	if err != nil {
		return nil, err
	}
	if err = record(ctx, tx, "agent.create", "agent", row.Get("id"), nil); err != nil {
		return nil, err
	}
	key, err := cryptox.SigningPublicKey()
	if err != nil {
		return nil, err
	}
	row.Set("token", token)
	row.Set("tenant_id", auth.From(ctx).TenantID)
	row.Set("signing_public_key", key)
	return row, nil
}
func (s Service) updateAgent(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	var token, hash any
	if b["rotate_token"] == true {
		value, err := cryptox.RandomToken(32)
		if err != nil {
			return nil, err
		}
		token, hash = value, cryptox.SHA256(value)
	}
	row, err := mustRow(ctx, tx, "PATCH /api/agents/:id", 0, "agente não encontrado", id, b["status"], hash, b["reset_certificate"] == true)
	if err != nil {
		return nil, err
	}
	action := "agent.update"
	if token != nil {
		action = "agent.rotate_token"
	} else if b["reset_certificate"] == true {
		action = "agent.reset_certificate"
	}
	detail := map[string]any{}
	if has(b, "status") {
		detail["status"] = b["status"]
	}
	if err = record(ctx, tx, action, "agent", id, detail); err != nil {
		return nil, err
	}
	key, err := cryptox.SigningPublicKey()
	if err != nil {
		return nil, err
	}
	row.Set("token", token)
	row.Set("signing_public_key", key)
	return row, nil
}
func deviceAllowed(ctx context.Context, driver string) error {
	if strings.HasSuffix(driver, "demo") && os.Getenv("NEXO_DEMO_MODE") != "1" {
		return apierr.New(400, "driver de demonstração só é permitido em ambiente de demonstração")
	}
	if strings.HasPrefix(driver, "olt") && !slices.Contains(auth.From(ctx).Modules, "olt") {
		return &apierr.Error{Status: 403, Message: "a integração com OLT não está liberada para o provedor", Code: "module_disabled"}
	}
	return nil
}
func (s Service) createDevice(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	driver := b["driver"].(string)
	if err := deviceAllowed(ctx, driver); err != nil {
		return nil, err
	}
	if driver == "radius" {
		return nil, apierr.New(400, "concentrador do RADIUS integrado é cadastrado em /api/radius/devices")
	}
	row, err := one(ctx, tx, "POST /api/devices", 0, auth.From(ctx).TenantID, b["name"], driver, b["host"], b["api_port"], b["credential_ref"], b["agent_id"], b["simultaneous_use"], b["acct_interim_seconds"])
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "device.create", "device", row.Get("id"), map[string]any{"driver": driver})
}
func (s Service) updateDevice(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PATCH /api/devices/:id"
	cur, err := mustRow(ctx, tx, key, 0, "equipamento não encontrado", id)
	if err != nil {
		return nil, err
	}
	if has(b, "driver") && b["driver"] != cur.Get("driver") && (b["driver"] == "radius" || cur.Get("driver") == "radius") {
		return nil, apierr.New(400, "para passar um equipamento ao RADIUS integrado use a conversão do equipamento")
	}
	if cur.Get("driver") == "radius" && has(b, "agent_id") && b["agent_id"] != cur.Get("agent_id") {
		return nil, apierr.New(400, "o RADIUS integrado não usa agente local")
	}
	for k, v := range b {
		cur.Set(k, v)
	}
	if err = deviceAllowed(ctx, cur.Get("driver").(string)); err != nil {
		return nil, err
	}
	row, err := one(ctx, tx, key, 1, id, cur.Get("name"), cur.Get("driver"), cur.Get("host"), cur.Get("api_port"), cur.Get("credential_ref"), cur.Get("agent_id"), cur.Get("maintenance"), cur.Get("simultaneous_use"), cur.Get("acct_interim_seconds"))
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "device.update", "device", id, b)
}
func requestNetwork(ctx context.Context, tx *db.Tx, resource, action, reason, idempotency string) (jsonx.Object, error) {
	c := auth.From(ctx)
	return network.Request(ctx, tx, c.TenantID, resource, action, network.Authz{Type: "user", ID: c.UserID, Reason: reason}, idempotency, "")
}
func (s Service) reapplyDevice(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	resources, err := rows(ctx, tx, "POST /api/devices/:id/reapply", 0, id)
	if err != nil {
		return nil, err
	}
	requested := 0
	for _, r := range resources {
		if r.Get("status") != "active" {
			continue
		}
		if _, err = requestNetwork(ctx, tx, r.Get("id").(string), "subscriber.provision", "reaplicação em massa do equipamento", ""); err != nil {
			return nil, err
		}
		requested++
	}
	return map[string]any{"requested": requested}, record(ctx, tx, "device.reapply_all", "device", id, map[string]any{"requested": requested})
}
func (s Service) contractService(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	const key = "GET /api/contracts/:id/service"
	if err := network.Sweep(ctx, tx); err != nil {
		return nil, err
	}
	row, err := one(ctx, tx, key, 0, id)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return map[string]any{"resource": nil, "operations": []any{}}, nil
	}
	operations, err := rows(ctx, tx, key, 1, row.Get("id"))
	return map[string]any{"resource": row, "operations": operations}, err
}
func (s Service) provisionService(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/contracts/:id/service"
	ipoe := b["access_type"] == "ipoe"
	mac := ""
	if b["mac"] != nil {
		mac = regexp.MustCompile(`[^0-9A-F]`).ReplaceAllString(strings.ToUpper(b["mac"].(string)), "")
	}
	if ipoe && len(mac) != 12 {
		return nil, apierr.New(400, "IPoE: informe o MAC do equipamento do assinante (12 dígitos hexadecimais)")
	}
	if !ipoe && b["pppoe_username"] == nil {
		return nil, apierr.New(400, "informe o usuário da conta")
	}
	username := b["pppoe_username"]
	if ipoe {
		username = strings.Join(regexp.MustCompile(`..`).FindAllString(mac, -1), ":")
	}
	var generated any
	if b["password"] == nil && !ipoe {
		token, err := cryptox.RandomToken(9)
		if err != nil {
			return nil, err
		}
		generated = token
	}
	contract, err := mustRow(ctx, tx, key, 0, "contrato não encontrado", id)
	if err != nil {
		return nil, err
	}
	if contract.Get("status") != "active" {
		return nil, apierr.New(400, "contrato encerrado")
	}
	device, err := one(ctx, tx, key, 1, b["device_id"])
	if err != nil {
		return nil, err
	}
	if device != nil && strings.HasPrefix(fmt.Sprint(device.Get("driver")), "olt") {
		return nil, apierr.New(400, "o equipamento escolhido é uma OLT; a conta PPPoE precisa de um concentrador (NAS)")
	}
	password := b["password"]
	if password == nil {
		password = generated
	}
	if password == nil {
		password, err = cryptox.RandomToken(18)
		if err != nil {
			return nil, err
		}
	}
	encrypted, err := cryptox.EncryptSecret(password.(string))
	if err != nil {
		return nil, err
	}
	r, err := one(ctx, tx, key, 2, auth.From(ctx).TenantID, id, b["device_id"], username, encrypted, contract.Get("profile_name"), b["access_type"])
	if err != nil {
		return nil, err
	}
	op, err := requestNetwork(ctx, tx, r.Get("id").(string), "subscriber.provision", "provisionamento inicial", "")
	if err != nil {
		return nil, err
	}
	return map[string]any{"resource_id": r.Get("id"), "operation_id": op.Get("id"), "generated_password": generated}, record(ctx, tx, "service.provision", "service_resource", r.Get("id"), map[string]any{"operation_id": op.Get("id"), "username": username, "access_type": b["access_type"]})
}
func (s Service) resourceAction(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	action := parameter(ctx, "action")
	q := validate.Query{Values: url.Values{"action": []string{action}}}
	q.Enum("action", "", "provision", "suspend", "resume", "disconnect")
	if err := q.Err(); err != nil {
		return nil, err
	}
	reason := "solicitação manual"
	if jsonx.Truthy(b["reason"]) {
		reason = b["reason"].(string)
	}
	idempotency := httpx.Request(ctx).Header.Get("Idempotency-Key")
	if idempotency != "" {
		idempotency = "user:" + idempotency
	}
	op, err := requestNetwork(ctx, tx, id, "subscriber."+action, reason, idempotency)
	if err != nil {
		return nil, err
	}
	detail := map[string]any{"operation_id": op.Get("id")}
	if has(b, "reason") {
		detail["reason"] = b["reason"]
	}
	return map[string]any{"operation_id": op.Get("id"), "status": op.Get("status"), "desired_version": op.Get("desired_version")}, record(ctx, tx, "service."+action, "service_resource", id, detail)
}
func (s Service) planNetwork(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PUT /api/plans/:id/network"
	p, err := mustRow(ctx, tx, key, 0, "plano não encontrado", id, b["rate_limit"], b["address_pool"])
	if err != nil {
		return nil, err
	}
	pending, err := one(ctx, tx, key, 1, id)
	if err != nil {
		return nil, err
	}
	p.Set("accounts_to_reapply", pending.Get("n"))
	return p, record(ctx, tx, "plan.network", "plan", id, b)
}
func (s Service) resourceMAC(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PATCH /api/resources/:id/mac"
	r, err := mustRow(ctx, tx, key, 0, "conta PPPoE não encontrada", id)
	if err != nil {
		return nil, err
	}
	if r.Get("mac") == b["mac"] {
		return map[string]any{"operation_id": nil, "changed": false}, nil
	}
	if err = tx.Exec(ctx, query(key, 1), id, b["mac"]); err != nil {
		return nil, err
	}
	var operation any
	if num(r.Get("desired_version")) > 0 {
		action := "subscriber.provision"
		if r.Get("desired_policy") == "suspended" {
			action = "subscriber.suspend"
		}
		reason := "MAC desvinculado"
		if b["mac"] != nil {
			reason = "vínculo do MAC " + b["mac"].(string)
		}
		op, err := requestNetwork(ctx, tx, id, action, reason, "")
		if err != nil {
			return nil, err
		}
		operation = op.Get("id")
	}
	return map[string]any{"operation_id": operation, "changed": true}, record(ctx, tx, "service.mac_change", "service_resource", id, map[string]any{"mac": b["mac"], "previous": r.Get("mac"), "operation_id": operation})
}
func (s Service) resourceSecret(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	encrypted, err := cryptox.EncryptSecret(b["password"].(string))
	if err != nil {
		return nil, err
	}
	r, err := mustRow(ctx, tx, "PATCH /api/resources/:id/secret", 0, "conta PPPoE não encontrada", id, encrypted)
	if err != nil {
		return nil, err
	}
	var operation any
	if num(r.Get("desired_version")) > 0 && r.Get("desired_policy") == "active" {
		op, err := requestNetwork(ctx, tx, id, "subscriber.provision", "troca de senha PPPoE", "")
		if err != nil {
			return nil, err
		}
		operation = op.Get("id")
	}
	out := map[string]any{"operation_id": operation}
	return out, record(ctx, tx, "service.secret_change", "service_resource", id, out)
}
func (s Service) reapplyPlan(ctx context.Context, id string) (any, error) {
	c := auth.From(ctx)
	var resources []jsonx.Object
	err := s.DB.WithScope(ctx, c.Scope, func(tx *db.Tx) error {
		var err error
		resources, err = rows(ctx, tx, "POST /api/plans/:id/reapply", 0, id)
		return err
	})
	if err != nil {
		return nil, err
	}
	requested := 0
	messages := []string{}
	for _, r := range resources {
		err = s.DB.WithScope(ctx, c.Scope, func(tx *db.Tx) error {
			_, err := requestNetwork(ctx, tx, r.Get("id").(string), "subscriber.provision", "parâmetros de rede do plano", "")
			return err
		})
		if err == nil {
			requested++
			continue
		}
		var httpError *apierr.Error
		if !errors.As(err, &httpError) {
			return nil, err
		}
		if !slices.Contains(messages, httpError.Message) {
			messages = append(messages, httpError.Message)
		}
	}
	detail := map[string]any{"requested": requested, "refused": len(resources) - requested}
	if err = (audit.Writer{DB: s.DB}).Write(ctx, c, "plan.reapply", "plan", id, detail, "ok"); err != nil {
		return nil, err
	}
	detail["errors"] = messages[:min(len(messages), 5)]
	return detail, nil
}
func (s Service) operationsList(ctx context.Context, tx *db.Tx, _ string, _ map[string]any) (any, error) {
	q := validate.Query{Values: httpx.Request(ctx).URL.Query()}
	filter := q.Enum("filter", "all", "all", "open", "problem")
	page := q.Page()
	if err := q.Err(); err != nil {
		return nil, err
	}
	if err := network.Sweep(ctx, tx); err != nil {
		return nil, err
	}
	limit := 200
	if page.HasLimit {
		limit = min(page.Limit, 200)
	}
	sql := query("GET /api/operations", 0)
	args := []any{filter, []string{"PENDING", "RESERVED", "EXECUTING", "VERIFYING", "UNCERTAIN"}}
	result, err := tx.Objects(ctx, sql+fmt.Sprintf(" limit %d offset %s", limit, jsonx.String(page.Offset)), args...)
	if err != nil {
		return nil, err
	}
	total := float64(len(result))
	if page.Offset != 0 || len(result) >= limit {
		count, err := tx.Objects(ctx, "select count(*) as n from ("+sql+") cnt", args...)
		if err != nil {
			return nil, err
		}
		total = num(count[0].Get("n"))
	}
	return endpoint.Result{Value: result, Total: jsonx.String(total)}, nil
}
func (s Service) operationDetail(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	const key = "GET /api/operations/:id"
	if err := network.Sweep(ctx, tx); err != nil {
		return nil, err
	}
	row, err := mustRow(ctx, tx, key, 0, "operação não encontrada", id)
	if err != nil {
		return nil, err
	}
	attempts, err := rows(ctx, tx, key, 1, id)
	if err != nil {
		return nil, err
	}
	row.Set("attempt_list", attempts)
	return row, nil
}
func (s Service) networkHealth(ctx context.Context, tx *db.Tx, _ string, _ map[string]any) (any, error) {
	if err := network.Sweep(ctx, tx); err != nil {
		return nil, err
	}
	return one(ctx, tx, "GET /api/network/health", 0)
}

package escrita

import (
	"context"
	"fmt"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/modules/leitura"
	"nexoisp/api-go/internal/network"
	"nexoisp/api-go/internal/validate"
	"strings"
)

func (s Service) infrastructureOperations(ops map[string]operation) {
	f, o, str, n, e := validate.F, validate.Object, validate.String, validate.Number, validate.Enum
	uuid := str().UUID()
	name := str().Trimmed().Min(2).Max(80)
	box := []validate.Field{f("name", name), f("kind", e("cto", "ceo")), f("ports", n().Int().Min(1).Max(144)), f("parent_id", uuid.Nullish()), f("device_id", uuid.Nullish()), f("pon_port", str().Trimmed().Pattern(`^[0-9]{1,3}(/[0-9]{1,3}){0,3}$`, "porta PON no formato 0/1/3").Nullish().OrEmpty().Then(nilEmpty, true)), f("address", text(200).Nullish().Then(nilEmpty, true)), f("notes", text(500).Nullish().Then(nilEmpty, true)), f("latitude", n().Min(-90).Max(90).Nullish()), f("longitude", n().Min(-180).Max(180).Nullish())}
	ops["POST /api/ftth/boxes"] = operation{s.createBox, obj(o(box...))}
	partial := []validate.Field{}
	for _, f := range box {
		rule := f.Rule.Opt()
		rule.TransformMissing = false
		partial = append(partial, validate.F(f.Name, rule))
	}
	ops["PATCH /api/ftth/boxes/:id"] = operation{s.updateBox, obj(o(partial...))}
	ops["DELETE /api/ftth/boxes/:id"] = operation{s.deleteBox, nil}
	ops["POST /api/ftth/boxes/:id/drops"] = operation{s.createDrop, obj(o(f("port", n().Int().Min(1).Max(144)), f("contract_id", uuid.Nullish()), f("note", text(200).Nullish())))}
	ops["DELETE /api/ftth/drops/:id"] = operation{s.deleteDrop, nil}
	ops["POST /api/ipam/pools"] = operation{s.createPool, obj(o(f("name", name), f("cidr", str().Trimmed().Pattern(`^[0-9a-fA-F:.]{2,45}/\d{1,3}$`, "bloco no formato 100.64.0.0/22")), f("kind", e("public", "cgnat", "private", "management")), f("device_id", uuid.Nullish()), f("notes", text(500).Nullish()), f("delegation_len", n().Int().Min(48).Max(64).Nullish())))}
	ops["PATCH /api/ipam/pools/:id"] = operation{s.updatePool, obj(o(f("name", name.Opt()), f("notes", text(500).Nullish()), f("device_id", uuid.Nullish())))}
	ops["DELETE /api/ipam/allocations/:id"] = operation{s.releaseIPv4, nil}
	ops["DELETE /api/ipam/pools/:id"] = operation{s.deletePool, nil}
	plan := o(f("name", name), f("public_pool_id", uuid), f("private_pool_id", uuid), f("ports_per_subscriber", n().Int().Min(64).Max(32768)), f("port_start", n().Int().Min(1024).Max(65000).Def(float64(1024))))
	ops["POST /api/cgnat/plans/check"] = operation{s.checkCGNAT, obj(plan)}
	ops["POST /api/cgnat/plans"] = operation{s.createCGNAT, obj(plan)}
	ops["POST /api/cgnat/plans/:id/retire"] = operation{s.retireCGNAT, nil}
	for _, table := range []string{"contracts", "pops"} {
		key := "PUT /api/" + table + "/:id/location"
		entity, action := "contract", "contract.location"
		if table == "pops" {
			entity, action = "pop", "pop.location"
		}
		ops[key] = operation{schema: obj(o(f("latitude", n().Min(-90).Max(90).Null()), f("longitude", n().Min(-180).Max(180).Null()))), handle: func(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
			if (b["latitude"] == nil) != (b["longitude"] == nil) {
				return nil, apierr.New(400, "dados: informe latitude e longitude juntas")
			}
			if _, err := mustRow(ctx, tx, key, 0, "não encontrado", id, b["latitude"], b["longitude"]); err != nil {
				return nil, err
			}
			return b, record(ctx, tx, action, entity, id, b)
		}}
	}
}
func checkBox(ctx context.Context, tx *db.Tx, b map[string]any, self any) error {
	const key = "helper:checkBox"
	if b["device_id"] != nil {
		d, err := one(ctx, tx, key, 0, b["device_id"])
		if err != nil {
			return err
		}
		if d == nil || !strings.HasPrefix(fmt.Sprint(d.Get("driver")), "olt") {
			return apierr.New(400, "o equipamento escolhido não é uma OLT")
		}
	}
	if b["parent_id"] != nil {
		loop, err := one(ctx, tx, key, 1, b["parent_id"], self)
		if err != nil {
			return err
		}
		if num(loop.Get("found")) == 0 {
			return apierr.New(400, "caixa anterior não encontrada")
		}
		if self != nil && (loop.Get("cycle") == true || b["parent_id"] == self) {
			return apierr.New(400, "a caixa anterior não pode ser a própria caixa nem uma derivada dela")
		}
	}
	return nil
}

var boxColumns = []string{"name", "kind", "ports", "parent_id", "device_id", "pon_port", "address", "latitude", "longitude", "notes"}

func boxArgs(first any, b map[string]any) []any {
	args := []any{first}
	for _, key := range boxColumns {
		args = append(args, b[key])
	}
	return args
}
func (s Service) createBox(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	if err := checkBox(ctx, tx, b, nil); err != nil {
		return nil, err
	}
	row, err := one(ctx, tx, "POST /api/ftth/boxes", 0, boxArgs(auth.From(ctx).TenantID, b)...)
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "ftth.box_create", "ftth_box", row.Get("id"), nil)
}
func (s Service) updateBox(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PATCH /api/ftth/boxes/:id"
	cur, err := mustRow(ctx, tx, key, 0, "caixa não encontrada", id)
	if err != nil {
		return nil, err
	}
	if err = checkBox(ctx, tx, b, id); err != nil {
		return nil, err
	}
	merged := map[string]any{}
	for _, v := range cur {
		merged[v.Name] = v.Value
	}
	for k, v := range b {
		merged[k] = v
	}
	top, err := one(ctx, tx, key, 1, id)
	if err != nil {
		return nil, err
	}
	if num(merged["ports"]) < num(top.Get("p")) {
		return nil, apierr.New(409, fmt.Sprintf("a porta %g está ocupada; libere-a antes de reduzir a caixa", num(top.Get("p"))))
	}
	row, err := one(ctx, tx, key, 2, boxArgs(id, merged)...)
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "ftth.box_update", "ftth_box", id, b)
}
func (s Service) deleteBox(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	const key = "DELETE /api/ftth/boxes/:id"
	box, err := mustRow(ctx, tx, key, 0, "caixa não encontrada", id)
	if err != nil {
		return nil, err
	}
	if num(box.Get("used")) > 0 || num(box.Get("children")) > 0 {
		return nil, apierr.New(409, "a caixa tem portas ocupadas ou caixas derivadas")
	}
	if err = tx.Exec(ctx, query(key, 1), id); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, record(ctx, tx, "ftth.box_delete", "ftth_box", id, map[string]any{"name": box.Get("name")})
}
func (s Service) createDrop(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/ftth/boxes/:id/drops"
	if b["contract_id"] == nil && (b["note"] == nil || b["note"] == "") {
		return nil, apierr.New(400, "informe o contrato ou uma anotação para reservar a porta")
	}
	box, err := mustRow(ctx, tx, key, 0, "caixa não encontrada", id)
	if err != nil {
		return nil, err
	}
	if num(b["port"]) > num(box.Get("ports")) {
		return nil, apierr.New(400, fmt.Sprintf("a caixa tem %g porta(s)", num(box.Get("ports"))))
	}
	if b["contract_id"] != nil {
		r, err := one(ctx, tx, key, 1, b["contract_id"])
		if err != nil {
			return nil, err
		}
		if r == nil {
			return nil, apierr.New(400, "contrato não encontrado")
		}
	}
	row, err := one(ctx, tx, key, 2, auth.From(ctx).TenantID, id, b["port"], b["contract_id"], nilEmpty(b["note"]))
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "ftth.drop_create", "ftth_drop", row.Get("id"), map[string]any{"box_id": id, "port": b["port"], "contract_id": b["contract_id"]})
}
func (s Service) deleteDrop(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	row, err := mustRow(ctx, tx, "DELETE /api/ftth/drops/:id", 0, "porta não encontrada", id)
	if err != nil {
		return nil, err
	}
	detail := map[string]any{}
	for _, v := range row {
		detail[v.Name] = v.Value
	}
	return map[string]any{"ok": true}, record(ctx, tx, "ftth.drop_delete", "ftth_drop", id, detail)
}
func (s Service) createPool(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	const key = "POST /api/ipam/pools"
	valid, err := one(ctx, tx, key, 0, b["cidr"])
	if err != nil {
		return nil, err
	}
	if valid.Get("ok") != true {
		return nil, apierr.New(400, "bloco inválido: use o endereço de rede, ex.: 100.64.0.0/22")
	}
	clash, err := one(ctx, tx, key, 1, b["cidr"])
	if err != nil {
		return nil, err
	}
	if clash != nil {
		return nil, apierr.New(409, fmt.Sprintf("o bloco se sobrepõe a “%v” (%v)", clash.Get("name"), clash.Get("cidr")))
	}
	shape, err := one(ctx, tx, key, 2, b["cidr"])
	if err != nil {
		return nil, err
	}
	if b["delegation_len"] != nil && (num(shape.Get("family")) != 6 || num(b["delegation_len"]) < num(shape.Get("masklen"))) {
		return nil, apierr.New(400, "prefixo por assinante só se aplica a bloco IPv6 e não pode ser maior que o próprio bloco")
	}
	row, err := one(ctx, tx, key, 3, auth.From(ctx).TenantID, b["name"], b["cidr"], b["kind"], b["device_id"], nilEmpty(b["notes"]), b["delegation_len"])
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "ipam.pool_create", "ip_pool", row.Get("id"), map[string]any{"cidr": row.Get("cidr"), "kind": b["kind"]})
}
func (s Service) updatePool(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	row, err := mustRow(ctx, tx, "PATCH /api/ipam/pools/:id", 0, "bloco não encontrado", id, b["name"], has(b, "notes"), nilEmpty(b["notes"]), has(b, "device_id"), b["device_id"])
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "ipam.pool_update", "ip_pool", id, b)
}
func (s Service) deletePool(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	const key = "DELETE /api/ipam/pools/:id"
	pool, err := mustRow(ctx, tx, key, 0, "bloco não encontrado", id)
	if err != nil {
		return nil, err
	}
	if num(pool.Get("allocated")) > 0 {
		return nil, apierr.New(409, "o bloco tem endereços alocados; libere-os antes de excluir")
	}
	exists, err := one(ctx, tx, key, 1, id)
	if err != nil {
		return nil, err
	}
	if exists != nil {
		return nil, apierr.New(409, "o bloco faz parte de um plano de CGNAT (vigente ou encerrado) e é mantido para rastreabilidade")
	}
	if err = tx.Exec(ctx, query(key, 2), id); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, record(ctx, tx, "ipam.pool_delete", "ip_pool", id, map[string]any{"cidr": pool.Get("cidr")})
}
func checkedPlan(ctx context.Context, tx *db.Tx, b map[string]any) (jsonx.Object, map[string]any, error) {
	pools, err := rows(ctx, tx, "helper:checkPlan", 0, []any{b["public_pool_id"], b["private_pool_id"]})
	if err != nil {
		return nil, nil, err
	}
	var public, private jsonx.Object
	for _, p := range pools {
		if p.Get("id") == b["public_pool_id"] {
			public = p
		}
		if p.Get("id") == b["private_pool_id"] {
			private = p
		}
	}
	if public == nil || private == nil {
		return nil, nil, apierr.New(400, "bloco não encontrado")
	}
	if public.Get("kind") != "public" {
		return nil, nil, apierr.New(400, "o bloco de saída precisa ser do tipo “público”")
	}
	if private.Get("kind") != "cgnat" {
		return nil, nil, apierr.New(400, "o bloco dos assinantes precisa ser do tipo “CGNAT”")
	}
	if num(public.Get("family")) != 4 || num(private.Get("family")) != 4 {
		return nil, nil, apierr.New(400, "CGNAT é calculado apenas para IPv4")
	}
	plan := jsonx.Object{}
	for k, v := range b {
		plan.Set(k, v)
	}
	plan.Set("public_cidr", public.Get("cidr"))
	plan.Set("private_cidr", private.Get("cidr"))
	capacity := leitura.CGNATCapacity(plan)
	if capacity["private_ips"].(uint64) > 65536 {
		return nil, nil, apierr.New(400, "bloco de assinantes maior que /16: divida em mais de um plano")
	}
	if capacity["fits"] != true {
		return nil, nil, apierr.New(400, fmt.Sprintf("não cabe: %v endereços privados para %v público(s) × %v bloco(s) de %v portas = %v. Reduza as portas por assinante ou aumente o bloco público.", capacity["private_ips"], capacity["public_ips"], capacity["blocks_per_public"], b["ports_per_subscriber"], capacity["max_private_ips"]))
	}
	return plan, capacity, nil
}
func (s Service) checkCGNAT(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	_, capacity, err := checkedPlan(ctx, tx, b)
	return capacity, err
}
func (s Service) createCGNAT(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	const key = "POST /api/cgnat/plans"
	plan, capacity, err := checkedPlan(ctx, tx, b)
	if err != nil {
		return nil, err
	}
	exists, err := one(ctx, tx, key, 0, b["private_pool_id"])
	if err != nil {
		return nil, err
	}
	if exists != nil {
		return nil, apierr.New(409, "este bloco de assinantes já tem um plano de CGNAT vigente; encerre-o antes de criar outro")
	}
	c := auth.From(ctx)
	row, err := one(ctx, tx, key, 1, c.TenantID, b["name"], b["public_pool_id"], b["private_pool_id"], plan.Get("public_cidr"), plan.Get("private_cidr"), b["ports_per_subscriber"], b["port_start"], c.UserID)
	if err != nil {
		return nil, err
	}
	if err = record(ctx, tx, "cgnat.plan_create", "cgnat_plan", row.Get("id"), map[string]any{"public": row.Get("public_cidr"), "private": row.Get("private_cidr"), "ports": b["ports_per_subscriber"]}); err != nil {
		return nil, err
	}
	row.Set("capacity", capacity)
	return row, nil
}
func (s Service) retireCGNAT(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	row, err := mustRow(ctx, tx, "POST /api/cgnat/plans/:id/retire", 0, "plano vigente não encontrado", id)
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "cgnat.plan_retire", "cgnat_plan", id, nil)
}

func (s Service) releaseIPv4(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	row, err := mustRow(ctx, tx, "DELETE /api/ipam/allocations/:id", 0, "alocação não encontrada", id)
	if err != nil {
		return nil, err
	}
	detail := map[string]any{}
	for _, v := range row {
		detail[v.Name] = v.Value
	}
	if err = record(ctx, tx, "ipam.release", "ip_allocation", id, detail); err != nil {
		return nil, err
	}
	var requested any
	if row.Get("contract_id") != nil && num(row.Get("family")) == 4 {
		requested, err = reapplyFixedIP(ctx, tx, row.Get("contract_id"), fmt.Sprintf("IP fixo %v liberado", row.Get("address")), true)
		if err != nil {
			return nil, err
		}
	}
	return map[string]any{"ok": true, "network": requested}, nil
}
func reapplyFixedIP(ctx context.Context, tx *db.Tx, contract any, reason string, released bool) (any, error) {
	r, err := one(ctx, tx, "helper:reapplyFixedIp", 0, contract)
	if err != nil {
		return nil, err
	}
	if r == nil || num(r.Get("desired_version")) == 0 {
		return map[string]any{"requested": false, "note": "contrato sem acesso PPPoE provisionado: o endereço será aplicado no provisionamento"}, nil
	}
	if r.Get("agent_id") == nil {
		return map[string]any{"requested": false, "note": "equipamento sem agente: use “Reaplicar” no contrato quando houver"}, nil
	}
	if r.Get("status") != "active" && r.Get("desired_policy") != "suspended" {
		return map[string]any{"requested": false, "note": "contrato encerrado: nada foi enviado ao equipamento"}, nil
	}
	action := "subscriber.resume"
	if r.Get("desired_policy") == "suspended" {
		action = "subscriber.suspend"
	}
	c := auth.From(ctx)
	op, err := network.Request(ctx, tx, c.TenantID, r.Get("id").(string), action, network.Authz{Type: "user", ID: c.UserID, Reason: reason}, "", "")
	if err != nil {
		return nil, err
	}
	note := "enviado ao agente; a sessão em uso é reconectada para receber o novo endereço"
	if released {
		note = "enviado ao agente; a sessão em uso mantém o endereço até a próxima reconexão"
	}
	return map[string]any{"requested": true, "operation_id": op.Get("id"), "note": note}, nil
}

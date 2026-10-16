package escrita

import (
	"context"
	"fmt"
	"math"
	"net/netip"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/network"
	"nexoisp/api-go/internal/validate"
	"time"
)

func (s Service) ipOperations(ops map[string]operation) {
	f, o, str, n := validate.F, validate.Object, validate.String, validate.Number
	uuid := str().UUID()
	ops["POST /api/ipam/pools/:id/allocations"] = operation{s.allocateIP, obj(o(f("address", str().Trimmed().Pattern(`^[0-9a-fA-F:.]{2,45}$`, "endereço IP inválido").Nullish().OrEmpty()), f("contract_id", uuid.Nullish()), f("description", text(200).Nullish())))}
	ops["POST /api/ipam/pools/:id/delegations"] = operation{s.delegateIP, obj(o(f("contract_id", uuid), f("prefix", str().Trimmed().Pattern(`^[0-9a-fA-F:.]{2,45}/\d{1,3}$`, "bloco no formato 100.64.0.0/22").Nullish().OrEmpty())))}
	ops["GET /api/cgnat/plans/:id/script"] = operation{s.cgnatScript, nil}
	ops["GET /api/cgnat/trace"] = operation{s.cgnatTrace, nil}
	ops["POST /api/legal/ip-lookup"] = operation{s.legalIP, obj(o(f("ip", str().Trimmed().Refine(func(v any) bool {
		address, err := netip.ParseAddr(v.(string))
		return err == nil && address.Zone() == ""
	}, "endereço IP inválido")), f("port", n().Int().Min(1).Max(65535).Nullish()), f("from", str().Refine(validDateTime, "Invalid datetime")), f("to", str().Refine(validDateTime, "Invalid datetime")), f("margin_minutes", n().Int().Min(0).Max(60).Def(float64(0))), f("reference", str().Trimmed().Min(3, "informe o número do ofício ou do processo").Max(120))))}
}
func (s Service) allocateIP(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/ipam/pools/:id/allocations"
	if b["contract_id"] == nil && !jsonx.Truthy(b["description"]) {
		return nil, apierr.New(400, "informe o contrato ou uma descrição para a reserva")
	}
	p, err := mustRow(ctx, tx, key, 0, "bloco não encontrado", id)
	if err != nil {
		return nil, err
	}
	if b["contract_id"] != nil {
		k, err := one(ctx, tx, key, 1, b["contract_id"])
		if err != nil {
			return nil, err
		}
		if k == nil {
			return nil, apierr.New(400, "contrato não encontrado")
		}
		if k.Get("status") != "active" {
			return nil, apierr.New(400, "contrato encerrado")
		}
	}
	address := nilEmpty(b["address"])
	if address != nil {
		ok, err := one(ctx, tx, key, 2, address)
		if err != nil {
			return nil, err
		}
		if ok.Get("ok") != true {
			return nil, apierr.New(400, "endereço IP inválido")
		}
		inside, err := one(ctx, tx, key, 3, address, p.Get("cidr"))
		if err != nil {
			return nil, err
		}
		if inside.Get("ok") != true {
			return nil, apierr.New(400, fmt.Sprintf("o endereço não pertence ao bloco %v", p.Get("cidr")))
		}
	} else {
		if num(p.Get("family")) != 4 || num(p.Get("size")) > 65536 {
			return nil, apierr.New(400, "escolha automática só para blocos IPv4 de até /16; informe o endereço")
		}
		edge := 0
		if num(p.Get("masklen")) <= 30 {
			edge = 1
		}
		free, err := one(ctx, tx, key, 4, id, p.Get("cidr"), edge, num(p.Get("size"))-1-float64(edge))
		if err != nil {
			return nil, err
		}
		if free == nil {
			return nil, apierr.New(409, "não há endereço livre neste bloco")
		}
		address = free.Get("addr")
	}
	if b["contract_id"] != nil && num(p.Get("family")) == 4 {
		exists, err := one(ctx, tx, key, 5, b["contract_id"])
		if err != nil {
			return nil, err
		}
		if exists != nil {
			return nil, apierr.New(409, "o contrato já tem um endereço IPv4 fixo; libere-o antes de alocar outro")
		}
	}
	c := auth.From(ctx)
	a, err := one(ctx, tx, key, 6, c.TenantID, id, address, b["contract_id"], nilEmpty(b["description"]), c.UserID)
	if err != nil {
		return nil, err
	}
	if err = record(ctx, tx, "ipam.allocate", "ip_allocation", a.Get("id"), map[string]any{"address": a.Get("address"), "contract_id": b["contract_id"]}); err != nil {
		return nil, err
	}
	var requested any
	if b["contract_id"] != nil && num(p.Get("family")) == 4 {
		requested, err = reapplyFixedIP(ctx, tx, b["contract_id"], "IP fixo "+jsonx.String(a.Get("address")), false)
		if err != nil {
			return nil, err
		}
	}
	a.Set("network", requested)
	return a, nil
}
func (s Service) delegateIP(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/ipam/pools/:id/delegations"
	p, err := mustRow(ctx, tx, key, 0, "bloco não encontrado", id)
	if err != nil {
		return nil, err
	}
	if num(p.Get("family")) != 6 || !jsonx.Truthy(p.Get("delegation_len")) {
		return nil, apierr.New(400, "este bloco não está configurado para delegar prefixos IPv6")
	}
	k, err := one(ctx, tx, key, 1, b["contract_id"])
	if err != nil {
		return nil, err
	}
	if k == nil {
		return nil, apierr.New(400, "contrato não encontrado")
	}
	if k.Get("status") != "active" {
		return nil, apierr.New(400, "contrato encerrado")
	}
	existing, err := one(ctx, tx, key, 2, b["contract_id"])
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, apierr.New(409, "o contrato já tem um prefixo IPv6; libere-o antes de delegar outro")
	}
	prefix := nilEmpty(b["prefix"])
	if prefix != nil {
		valid, err := one(ctx, tx, key, 3, prefix)
		if err != nil {
			return nil, err
		}
		ok := valid.Get("valid") == true
		if ok {
			inside, err := one(ctx, tx, key, 4, prefix, p.Get("cidr"), p.Get("delegation_len"))
			if err != nil {
				return nil, err
			}
			ok = inside.Get("ok") == true
		}
		if !ok {
			return nil, apierr.New(400, fmt.Sprintf("o prefixo precisa ser um /%v dentro de %v", p.Get("delegation_len"), p.Get("cidr")))
		}
		clash, err := one(ctx, tx, key, 5, prefix)
		if err != nil {
			return nil, err
		}
		if clash != nil {
			return nil, apierr.New(409, "prefixo já delegado")
		}
	} else {
		total := int(math.Min(math.Pow(2, num(p.Get("delegation_len"))-num(p.Get("masklen"))), 65536))
		for from := 0; from < total && prefix == nil; from += 1024 {
			candidates := []netip.Prefix{}
			for i := 0; i < min(1024, total-from); i++ {
				value, err := network.IPv6Subnet(fmt.Sprint(p.Get("cidr")), int(num(p.Get("delegation_len"))), from+i)
				if err != nil {
					return nil, err
				}
				parsed, err := netip.ParsePrefix(value)
				if err != nil {
					return nil, err
				}
				candidates = append(candidates, parsed)
			}
			free, err := one(ctx, tx, key, 6, candidates)
			if err != nil {
				return nil, err
			}
			if free != nil {
				prefix = free.Get("prefix")
			}
		}
		if prefix == nil {
			return nil, apierr.New(409, fmt.Sprintf("não há prefixo /%v livre entre os primeiros 65536 deste bloco", p.Get("delegation_len")))
		}
	}
	c := auth.From(ctx)
	row, err := one(ctx, tx, key, 7, c.TenantID, id, prefix, b["contract_id"], c.UserID)
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "ipam.delegate_v6", "ip6_delegation", row.Get("id"), map[string]any{"prefix": row.Get("prefix"), "contract_id": b["contract_id"]})
}
func (s Service) cgnatScript(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	plan, err := mustRow(ctx, tx, "helper:loadPlan", 0, "plano de CGNAT não encontrado", id)
	if err != nil {
		return nil, err
	}
	if err = record(ctx, tx, "cgnat.script_export", "cgnat_plan", id, nil); err != nil {
		return nil, err
	}
	return endpoint.Result{Raw: []byte(network.CGNATScript(plan)), ContentType: "text/plain; charset=utf-8", Disposition: `attachment; filename="cgnat-` + id[:8] + `.rsc"`}, nil
}
func (s Service) cgnatTrace(ctx context.Context, tx *db.Tx, _ string, _ map[string]any) (any, error) {
	const key = "GET /api/cgnat/trace"
	q := reportQuery(ctx)
	before := len(q.Issues)
	ip := q.String("ip", true, true)
	if len(q.Issues) == before {
		if _, valid := network.IPv4Number(ip); !valid {
			q.Issues = append(q.Issues, "ip: IP público inválido")
		}
	}
	port := q.Integer("port", 0, 1, 65535)
	if _, present := q.Values["port"]; !present {
		q.Issues = append(q.Issues, "port: Expected number, received nan")
	}
	before = len(q.Issues)
	at := q.String("at", false, false)
	if _, present := q.Values["at"]; present && len(q.Issues) == before && !validDateTime(at) {
		q.Issues = append(q.Issues, "at: Invalid datetime")
	}
	if err := q.Err(); err != nil {
		return nil, err
	}
	if at == "" {
		at = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	plans, err := rows(ctx, tx, key, 0, ip, at)
	if err != nil {
		return nil, err
	}
	if err = record(ctx, tx, "cgnat.trace", "cgnat", nil, map[string]any{"ip": ip, "port": port, "at": at}); err != nil {
		return nil, err
	}
	for _, plan := range plans {
		block := network.CGNATReverse(plan, ip, float64(port))
		if block == nil {
			continue
		}
		fixed, err := one(ctx, tx, key, 1, block["private_ip"])
		if err != nil {
			return nil, err
		}
		session, err := one(ctx, tx, key, 2, block["private_ip"])
		if err != nil {
			return nil, err
		}
		holders, err := rows(ctx, tx, key, 3, block["private_ip"], at)
		if err != nil {
			return nil, err
		}
		note := "Endereço privado dinâmico sem sessão relatada para esse horário: o titular está no accounting do RADIUS local (radacct: framedipaddress + horário). A sessão atual, se exibida, não comprova o uso no passado."
		if fixed != nil {
			note = "Endereço privado fixo de um contrato."
		} else if len(holders) > 0 {
			note = "Endereço privado dinâmico: o titular na data consultada vem das sessões relatadas pelo agente (accounting do RADIUS local). Confira no RADIUS do provedor se o caso for formal."
		}
		out := map[string]any{"found": true, "at": at, "plan": map[string]any{"id": plan.Get("id"), "name": plan.Get("name"), "retired_at": plan.Get("retired_at")}, "fixed_allocation": firstObject(fixed), "current_session": firstObject(session), "holders_at": holders, "note": note}
		for k, v := range block {
			out[k] = v
		}
		return out, nil
	}
	note := "Nenhum plano de CGNAT do provedor cobria esse IP público na data informada."
	if len(plans) > 0 {
		note = "A porta não pertence a nenhum bloco do plano vigente na data."
	}
	return map[string]any{"found": false, "at": at, "note": note}, nil
}
func firstObject(row jsonx.Object) any {
	if row == nil {
		return nil
	}
	return row
}
func (s Service) legalIP(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	const key = "POST /api/legal/ip-lookup"
	from, _ := parseDateTime(b["from"].(string))
	to, _ := parseDateTime(b["to"].(string))
	from = from.Truncate(time.Millisecond)
	to = to.Truncate(time.Millisecond)
	if to.Before(from) {
		return nil, apierr.New(400, "o fim do período é anterior ao início")
	}
	if to.Sub(from) > 92*24*time.Hour {
		return nil, apierr.New(400, "período máximo de 92 dias por consulta")
	}
	margin := time.Duration(num(b["margin_minutes"])) * time.Minute
	lo, hi := from.Add(-margin), to.Add(margin)
	notes := []string{}
	targets := []map[string]any{}
	mode := "direct"
	ipv6 := []jsonx.Object{}
	ip := b["ip"].(string)
	address, _ := netip.ParseAddr(ip)
	if address.Is6() {
		mode = "ipv6"
		var err error
		ipv6, err = rows(ctx, tx, key, 0, ip, hi)
		if err != nil {
			return nil, err
		}
		notes = append(notes, "IPv6: o resultado é a delegação de prefixo registrada para o contrato. O sistema não guarda histórico de titulares anteriores do mesmo prefixo.")
		if b["port"] != nil {
			notes = append(notes, "A porta não se aplica a IPv6 (não há CGNAT).")
		}
	} else {
		plans, err := rows(ctx, tx, key, 1, ip, lo, hi)
		if err != nil {
			return nil, err
		}
		add := func(plan jsonx.Object, block map[string]any) {
			targets = append(targets, map[string]any{"ip": block["private_ip"], "cgnat": map[string]any{"plan": plan.Get("name"), "public_ip": block["public_ip"], "port_start": block["port_start"], "port_end": block["port_end"]}})
		}
		if len(plans) > 0 {
			for _, plan := range plans {
				if b["port"] != nil {
					block := network.CGNATReverse(plan, ip, num(b["port"]))
					if block != nil {
						add(plan, block)
					} else {
						notes = append(notes, fmt.Sprintf("A porta %v não pertence a nenhum bloco do plano de CGNAT \"%v\".", b["port"], plan.Get("name")))
					}
				} else {
					public, _ := network.CIDR4(plan.Get("public_cidr"))
					private, size := network.CIDR4(plan.Get("private_cidr"))
					per := uint64(math.Floor((65536 - num(plan.Get("port_start"))) / num(plan.Get("ports_per_subscriber"))))
					number, _ := network.IPv4Number(ip)
					pi := number - public
					for i := pi * per; i < min((pi+1)*per, size); i++ {
						block := network.CGNATForward(plan, network.IPv4String(private+i))
						if block != nil {
							add(plan, block)
						}
					}
				}
			}
			mode = "cgnat_port"
			if b["port"] == nil {
				mode = "cgnat_shared"
				notes = append(notes, fmt.Sprintf("Sem a porta de origem, este IP público é compartilhado por até %d assinantes (CGNAT). A lista abaixo traz todos os que o usaram no período; peça a porta para identificar um só.", len(targets)))
			}
			if len(plans) > 1 {
				notes = append(notes, "Mais de um plano de CGNAT cobriu este IP no período (troca de plano): todos foram considerados.")
			}
		} else {
			targets = append(targets, map[string]any{"ip": ip})
			if b["port"] != nil {
				notes = append(notes, "Este IP não pertence a um plano de CGNAT do provedor: a porta não muda o resultado.")
			}
		}
	}
	ips := []string{}
	seen := map[string]bool{}
	byIP := map[string]any{}
	for _, target := range targets {
		ip := target["ip"].(string)
		if !seen[ip] {
			ips = append(ips, ip)
			seen[ip] = true
		}
		byIP[ip] = target["cgnat"]
	}
	sessions := []jsonx.Object{}
	fixed := []jsonx.Object{}
	if len(ips) > 0 {
		var err error
		sessions, err = rows(ctx, tx, key, 2, ips, lo, hi)
		if err != nil {
			return nil, err
		}
		if len(sessions) > 1000 {
			sessions = sessions[:1000]
			notes = append(notes, "Resultado limitado a 1000 sessões: reduza o período.")
		}
		for i, row := range sessions {
			sessions[i].Set("cgnat", byIP[row.Get("ip").(string)])
		}
		fixed, err = rows(ctx, tx, key, 3, ips)
		if err != nil {
			return nil, err
		}
	}
	since, err := one(ctx, tx, key, 4)
	if err != nil {
		return nil, err
	}
	earliest := since.Get("t")
	if earliest == nil || earliest.(jsonx.Time).After(lo) {
		display := "(nenhuma sessão registrada)"
		if earliest != nil {
			display = earliest.(jsonx.Time).UTC().Format("2006-01-02T15:04:05.000Z")
		}
		notes = append(notes, "O registro de sessões deste provedor começa em "+display+": períodos anteriores não podem ser respondidos por este sistema.")
	}
	if mode != "ipv6" && len(sessions) == 0 {
		notes = append(notes, "Nenhuma sessão encontrada com este endereço no período informado.")
	}
	subscribers := map[string]bool{}
	for _, r := range append(append([]jsonx.Object{}, sessions...), ipv6...) {
		subscribers[r.Get("subscriber_id").(string)] = true
	}
	if err = record(ctx, tx, "legal.ip_lookup", "legal", nil, map[string]any{"reference": b["reference"], "ip": ip, "port": b["port"], "from": b["from"], "to": b["to"], "margin_minutes": b["margin_minutes"], "mode": mode, "sessions": len(sessions), "subscribers": len(subscribers)}); err != nil {
		return nil, err
	}
	input := map[string]any{}
	for k, v := range b {
		input[k] = v
	}
	input["from"], input["to"] = lo.UTC().Format("2006-01-02T15:04:05.000Z"), hi.UTC().Format("2006-01-02T15:04:05.000Z")
	return map[string]any{"query": input, "mode": mode, "targets": targets, "sessions": sessions, "ipv6": ipv6, "fixed": fixed, "notes": notes, "records_since": earliest, "subscribers": len(subscribers), "generated_at": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), "generated_by": auth.From(ctx).Name}, nil
}

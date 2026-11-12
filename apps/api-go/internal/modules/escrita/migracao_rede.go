package escrita

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/modules/leitura"
	"nexoisp/api-go/internal/network"
	"nexoisp/api-go/internal/validate"
)

// Migração da camada de rede de outro ERP (SGP, IXC...) — ver docs/migracao-rede-sgp-ixc.md:
//   - plano de troca do RADIUS do concentrador MikroTik (desativa o anterior, não apaga; script de volta);
//   - leitura da configuração de CGNAT do provedor (MikroTik netmap, Hillstone, A10) com planos sugeridos;
//   - importação de mapeamentos de CGNAT (regras exatas, registro de NAT, arquivo de mapeamento, CSV) para ofícios.
// Nada aqui toca o equipamento: os scripts são entregues para revisão e aplicação pelo provedor.
func registerNetworkMigration(api huma.API, registry *endpoint.Registry, s Service) {
	f, o, str := validate.F, validate.Object, validate.String
	routeScoped(api, registry, s, http.MethodPost, "/api/radius/devices/{id}/repoint-plan", "network:write",
		ruleRef(o(f("export", str().Min(20, "cole a configuração do concentrador (/export, display current-configuration ou show running-config)").Max(5_000_000)))), false,
		func(ctx context.Context, tx *db.Tx, _ *http.Request, p map[string]string, b map[string]any) (any, error) {
			current, err := nas(ctx, tx, p["id"])
			if err != nil {
				return nil, err
			}
			vendor, _ := current.Get("vendor").(string)
			if vendor != "mikrotik" && vendor != "huawei" && vendor != "cisco" {
				return nil, apierr.New(400, "o plano de troca é gerado para concentrador MikroTik, Huawei (NE) ou Cisco (ASR)")
			}
			tunnel, err := leitura.RadiusTunnel(ctx, tx, p["id"])
			if err != nil {
				return nil, err
			}
			setup, err := leitura.RadiusSetupData(vendor, current.Get("coa_port"), "<SEGREDO>", tunnel, current.Get("nas_ip"))
			if err != nil {
				return nil, err
			}
			var plan network.RepointPlan
			switch vendor {
			case "huawei":
				plan = network.HuaweiRepoint(b["export"].(string), setup["commands"].(string))
			case "cisco":
				plan = network.CiscoRepoint(b["export"].(string), setup["commands"].(string))
			default:
				plan = network.MikrotikRepoint(b["export"].(string), setup["commands"].(string))
			}
			if err = record(ctx, tx, "radius.repoint_plan", "device", p["id"], map[string]any{"erp": plan.ERP, "radius": len(plan.Radius), "vpn": len(plan.VPN)}); err != nil {
				return nil, err
			}
			return plan, nil
		})
	routeScoped(api, registry, s, http.MethodPost, "/api/import/mikrotik-secrets", "import:run",
		ruleRef(o(f("export", str().Min(10, "cole o /export do concentrador").Max(15_000_000)))), false,
		func(ctx context.Context, tx *db.Tx, _ *http.Request, _ map[string]string, b map[string]any) (any, error) {
			r := network.PPPSecretsCSV(b["export"].(string))
			if err := record(ctx, tx, "import.mikrotik_secrets", "import", nil, map[string]any{"rows": r.Rows}); err != nil {
				return nil, err
			}
			return endpoint.Result{Value: r, Status: http.StatusOK}, nil // conversão: o CSV segue para /api/import/preview
		})
	routeScoped(api, registry, s, http.MethodPost, "/api/cgnat/analyze", "network:read",
		ruleRef(o(f("config", str().Min(10, "cole a configuração do equipamento de CGNAT").Max(15_000_000)))), false,
		func(_ context.Context, _ *db.Tx, _ *http.Request, _ map[string]string, b map[string]any) (any, error) {
			return endpoint.Result{Value: network.AnalyzeCGNATConfig(b["config"].(string)), Status: http.StatusOK}, nil // análise: nada é criado
		})
	routeScoped(api, registry, s, http.MethodPost, "/api/cgnat/mappings", "network:write",
		ruleRef(o(f("kind", validate.Enum("config", "log", "mapping_file", "csv")), f("label", str().Trimmed().Min(1).Max(120)),
			f("text", str().Min(10).Max(15_000_000)), f("year", validate.Number().Int().Min(2000).Max(2100).Nullish()),
			f("timezone", str().Max(64).Nullish()), f("valid_from", str().Refine(validDateTime, "Invalid datetime").Nullish()))), false,
		s.importCGNATMappings)
	routeScoped(api, registry, s, http.MethodGet, "/api/cgnat/mappings/batches", "network:read", nil, false,
		func(ctx context.Context, tx *db.Tx, _ *http.Request, _ map[string]string, _ map[string]any) (any, error) {
			return tx.Objects(ctx, `select b.id, b.kind, b.label, b.lines, b.accepted, b.rejected, b.created_at,
				(select min(valid_from) from cgnat_mappings m where m.batch_id = b.id) as first_at,
				(select max(coalesce(valid_to, valid_from)) from cgnat_mappings m where m.batch_id = b.id) as last_at
				from cgnat_mapping_batches b order by b.created_at desc limit 200`)
		})
	routeScoped(api, registry, s, http.MethodDelete, "/api/cgnat/mappings/batches/{id}", "network:write", nil, false,
		func(ctx context.Context, tx *db.Tx, _ *http.Request, p map[string]string, _ map[string]any) (any, error) {
			row, err := firstRow("lote de mapeamentos não encontrado")(tx.Objects(ctx, `delete from cgnat_mapping_batches where id = $1 returning id, kind, label, accepted`, p["id"]))
			if err != nil {
				return nil, err
			}
			return row, record(ctx, tx, "cgnat.mappings_delete", "cgnat_mapping_batch", p["id"], map[string]any{"kind": row.Get("kind"), "accepted": row.Get("accepted")})
		})
}

func ruleRef(r validate.Rule) *validate.Rule { return &r }

func (s Service) importCGNATMappings(ctx context.Context, tx *db.Tx, _ *http.Request, _ map[string]string, b map[string]any) (any, error) {
	kind, text := b["kind"].(string), b["text"].(string)
	var result network.CGNATImport
	var extra map[string]any
	switch kind {
	case "config":
		a := network.AnalyzeCGNATConfig(text)
		if len(a.Rules) == 0 {
			return nil, apierr.New(400, "a configuração não tem regras determinísticas para importar ("+a.Kind+"): use o registro de NAT")
		}
		result = network.CGNATImport{Mappings: network.MappingsFromRules(a.Rules), Lines: len(a.Rules), Accepted: len(a.Rules), Samples: []string{}}
		extra = map[string]any{"vendor": a.Vendor, "suggestions": a.Suggestions}
	case "csv":
		r, err := network.ParseCGNATCSV(text)
		if err != nil {
			return nil, apierr.New(400, err.Error())
		}
		result = r
	default:
		loc := time.UTC
		if tz, _ := b["timezone"].(string); tz != "" {
			l, err := time.LoadLocation(tz)
			if err != nil {
				return nil, apierr.New(400, "fuso horário desconhecido (ex.: America/Sao_Paulo)")
			}
			loc = l
		} else if l, err := time.LoadLocation("America/Sao_Paulo"); err == nil {
			loc = l
		}
		year := 0
		if y, ok := b["year"].(float64); ok {
			year = int(y)
		}
		var from *time.Time
		if v, _ := b["valid_from"].(string); v != "" {
			t, _ := parseDateTime(v)
			from = &t
		}
		if kind == "mapping_file" && from == nil {
			return nil, apierr.New(400, "informe a partir de quando o arquivo de mapeamento vale (valid_from)")
		}
		result = network.ParseCGNATLog(text, year, loc, from)
	}
	if len(result.Mappings) == 0 {
		msg := fmt.Sprintf("nenhum mapeamento reconhecido: %d linha(s) lidas, %d rejeitada(s)", result.Lines, result.Rejected)
		if len(result.Samples) > 0 {
			msg += " — exemplo do formato rejeitado: " + result.Samples[0]
		}
		return nil, apierr.New(400, msg)
	}
	c := auth.From(ctx)
	batch, err := firstRow("lote não criado")(tx.Objects(ctx, `insert into cgnat_mapping_batches (tenant_id, kind, label, lines, accepted, rejected, created_by)
		values ($1, $2, $3, $4, $5, $6, $7) returning id, kind, label, lines, accepted, rejected, created_at`,
		c.TenantID, kind, b["label"], result.Lines, result.Accepted, result.Rejected, nilIfEmpty(c.UserID)))
	if err != nil {
		return nil, err
	}
	const chunk = 5000
	for i := 0; i < len(result.Mappings); i += chunk {
		end := min(i+chunk, len(result.Mappings))
		var priv, pub, from, to []string
		var ps, pe []int
		for _, m := range result.Mappings[i:end] {
			priv, pub, ps, pe = append(priv, m.Private), append(pub, m.Public), append(ps, m.PortStart), append(pe, m.PortEnd)
			from, to = append(from, timeText(m.ValidFrom)), append(to, timeText(m.ValidTo))
		}
		if err = tx.Exec(ctx, `insert into cgnat_mappings (tenant_id, batch_id, private_cidr, public_cidr, port_start, port_end, valid_from, valid_to)
			select $1, $2, p::cidr, q::cidr, s, e, nullif(f, '')::timestamptz, nullif(t, '')::timestamptz
			from unnest($3::text[], $4::text[], $5::int[], $6::int[], $7::text[], $8::text[]) as x(p, q, s, e, f, t)`,
			c.TenantID, batch.Get("id"), priv, pub, ps, pe, from, to); err != nil {
			return nil, err
		}
	}
	if err = record(ctx, tx, "cgnat.mappings_import", "cgnat_mapping_batch", batch.Get("id"), map[string]any{"kind": kind, "accepted": result.Accepted, "rejected": result.Rejected}); err != nil {
		return nil, err
	}
	out := map[string]any{"batch": batch, "rejected_samples": result.Samples}
	for k, v := range extra {
		out[k] = v
	}
	return out, nil
}

func timeText(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func nilIfEmpty(v string) any {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	return v
}

// traceMappings procura o IP público e a porta nos mapeamentos importados (regras exatas, registro de NAT,
// arquivo de mapeamento). Devolve nil quando nenhum cobre o horário consultado.
func traceMappings(ctx context.Context, tx *db.Tx, key, ip string, port float64, at string) (map[string]any, error) {
	hits, err := tx.Objects(ctx, `select m.private_cidr::text as private_cidr, m.public_cidr::text as public_cidr, m.port_start, m.port_end,
			m.valid_from, m.valid_to, b.kind, b.label, b.id as batch_id
		from cgnat_mappings m join cgnat_mapping_batches b on b.id = m.batch_id
		where m.public_cidr >>= $1::inet and $2 between m.port_start and m.port_end
		  and (m.valid_from is null or m.valid_from <= $3::timestamptz) and (m.valid_to is null or m.valid_to > $3::timestamptz)
		order by m.valid_from desc nulls last, m.id desc limit 2`, ip, int(port), at)
	if err != nil || len(hits) == 0 {
		return nil, err
	}
	h := hits[0]
	private, ok := network.CGNATMappingPrivate(h.Get("private_cidr").(string), h.Get("public_cidr").(string), ip)
	if !ok {
		return nil, nil
	}
	fixed, err := one(ctx, tx, key, 1, private)
	if err != nil {
		return nil, err
	}
	holders, err := rows(ctx, tx, key, 3, private, at)
	if err != nil {
		return nil, err
	}
	note := "Titular pelo mapeamento importado do equipamento de CGNAT (" + kindText(h.Get("kind")) + " \"" + jsonx.String(h.Get("label")) + "\"); o endereço privado na data vem do accounting do RADIUS."
	if len(hits) > 1 {
		note += " Atenção: mais de um mapeamento cobre esse IP, porta e horário; foi usado o mais recente — confira os lotes importados."
	}
	return map[string]any{"found": true, "at": at, "private_ip": private, "public_ip": ip, "port_start": h.Get("port_start"), "port_end": h.Get("port_end"),
		"layout": "mapping", "mapping": map[string]any{"batch_id": h.Get("batch_id"), "kind": h.Get("kind"), "label": h.Get("label"), "valid_from": h.Get("valid_from"), "valid_to": h.Get("valid_to")},
		"fixed_allocation": firstObject(fixed), "current_session": nil, "holders_at": holders, "note": note}, nil
}

func kindText(v any) string {
	switch v {
	case "config":
		return "regras da configuração"
	case "log":
		return "registro de NAT"
	case "mapping_file":
		return "arquivo de mapeamento"
	}
	return "planilha"
}

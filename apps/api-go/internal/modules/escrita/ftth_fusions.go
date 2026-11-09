package escrita

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/validate"
)

// Fusões fibra a fibra dentro de uma caixa: cabo A/fibra n com cabo B/fibra m
// ou com uma porta da caixa. Uma fibra só pode aparecer uma vez por caixa.

const fusionCols = `f.id,f.pop_id,f.box_id,f.a_cable_id,ca.name as a_cable_name,ca.fiber_count as a_fiber_count,f.a_fiber,f.b_cable_id,cb.name as b_cable_name,f.b_fiber,f.b_port,f.loss_db,f.notes,f.created_at`
const fusionFrom = ` from ftth_fusions f join ftth_cables ca on ca.id=f.a_cable_id left join ftth_cables cb on cb.id=f.b_cable_id`

var fusionUnique = map[string]string{"ftth_fusion_fibers_pkey": "a fibra já está fundida nesta caixa", "ftth_fusions_port": "a porta da caixa já recebe outra fusão"}

func fusionBody(r *http.Request) (map[string]any, error) {
	b, err := strictBody(r)
	if err != nil {
		return nil, err
	}
	bad := func(label string) error { return apierr.New(400, "dados de fusão inválidos: "+label) }
	out := map[string]any{"b_cable_id": nil, "b_fiber": nil, "b_port": nil, "loss_db": nil, "notes": ""}
	for k, v := range b {
		switch k {
		case "a_cable_id", "b_cable_id":
			if k == "b_cable_id" && string(v) == "null" {
				continue
			}
			s, ok := rawString(v)
			if !ok || validate.UUID(s) != nil {
				return nil, bad("cabo")
			}
			out[k] = s
		case "a_fiber", "b_fiber":
			if k == "b_fiber" && string(v) == "null" {
				continue
			}
			n, ok := rawInt(v, 1, 288)
			if !ok {
				return nil, bad("fibra (1 a 288)")
			}
			out[k] = n
		case "b_port":
			if string(v) == "null" {
				continue
			}
			n, ok := rawInt(v, 1, 144)
			if !ok {
				return nil, bad("porta da caixa")
			}
			out[k] = n
		case "loss_db":
			if string(v) == "null" {
				continue
			}
			f, ok := rawNumber(v)
			if !ok || f < -1 || f > 5 {
				return nil, bad("perda medida (-1 a 5 dB)")
			}
			out[k] = f
		case "notes":
			s, ok := rawString(v)
			if !ok || utf8.RuneCountInString(strings.TrimSpace(s)) > 200 {
				return nil, bad("observação (até 200 caracteres)")
			}
			out[k] = strings.TrimSpace(s)
		default:
			return nil, bad("campo desconhecido")
		}
	}
	if out["a_cable_id"] == nil || out["a_fiber"] == nil {
		return nil, bad("informe o cabo e a fibra de origem")
	}
	toFiber := out["b_cable_id"] != nil && out["b_fiber"] != nil && out["b_port"] == nil
	toPort := out["b_cable_id"] == nil && out["b_fiber"] == nil && out["b_port"] != nil
	if !toFiber && !toPort {
		return nil, bad("informe o cabo e a fibra de destino ou uma porta da caixa")
	}
	if toFiber && out["a_cable_id"] == out["b_cable_id"] && out["a_fiber"] == out["b_fiber"] {
		return nil, apierr.New(400, "uma fibra não pode ser fundida com ela mesma")
	}
	return out, nil
}

func fusionCable(ctx context.Context, tx *db.Tx, id any, fiber any) (string, error) {
	rows, err := tx.Objects(ctx, `select pop_id,name,fiber_count,active from ftth_cables where id=$1 for share`, id)
	if err != nil {
		return "", err
	}
	if len(rows) == 0 {
		return "", apierr.New(404, "cabo não encontrado")
	}
	c := rows[0]
	if c.Get("active") != true {
		return "", apierr.New(409, fmt.Sprintf("o cabo %s está arquivado", c.Get("name")))
	}
	if num(fiber) > num(c.Get("fiber_count")) {
		return "", apierr.New(400, fmt.Sprintf("o cabo %s tem %g fibra(s)", c.Get("name"), num(c.Get("fiber_count"))))
	}
	return c.Get("pop_id").(string), nil
}

func registerFTTHFusions(api huma.API, registry *endpoint.Registry, s Service) {
	for _, route := range []struct{ method, path, permission string }{{"GET", "/api/ftth/boxes/{id}/fusions", "network:read"}, {"POST", "/api/ftth/boxes/{id}/fusions", "network:write"}, {"DELETE", "/api/ftth/fusions/{id}", "network:write"}} {
		route := route
		registry.Handle(api, route.method, route.path, route.permission, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			actor, err := siteActor(ctx)
			if err != nil {
				return endpoint.Result{}, err
			}
			id := chi.URLParam(r, "id")
			if err = validate.UUID(id); err != nil {
				return endpoint.Result{}, err
			}
			var body map[string]any
			if route.method == "POST" {
				if body, err = fusionBody(r); err != nil {
					return endpoint.Result{}, err
				}
			}
			var result any
			err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
				if route.method == "DELETE" {
					rows, e := tx.Objects(ctx, `delete from ftth_fusions where id=$1 returning id,box_id,a_cable_id,a_fiber,b_cable_id,b_fiber,b_port`, id)
					if e != nil {
						return e
					}
					if len(rows) == 0 {
						return apierr.New(404, "fusão não encontrada")
					}
					detail := map[string]any{}
					for _, f := range rows[0] {
						detail[f.Name] = f.Value
					}
					result = map[string]any{"ok": true}
					return record(ctx, tx, "ftth.fusion_deleted", "ftth_fusion", id, detail)
				}
				lock := ""
				if route.method == "POST" {
					lock = " for share"
				}
				boxes, e := tx.Objects(ctx, `select id,name,ports from ftth_boxes where id=$1`+lock, id)
				if e != nil {
					return e
				}
				if len(boxes) == 0 {
					return apierr.New(404, "caixa não encontrada")
				}
				box := boxes[0]
				if route.method == "GET" {
					rows, e := tx.Objects(ctx, `select `+fusionCols+fusionFrom+` where f.box_id=$1 order by ca.name,f.a_fiber,f.id`, id)
					if e != nil {
						return e
					}
					result = map[string]any{"box": box, "items": rows}
					return nil
				}
				pop, e := fusionCable(ctx, tx, body["a_cable_id"], body["a_fiber"])
				if e != nil {
					return e
				}
				if body["b_cable_id"] != nil {
					other, e := fusionCable(ctx, tx, body["b_cable_id"], body["b_fiber"])
					if e != nil {
						return e
					}
					if other != pop {
						return apierr.New(400, "os dois cabos da fusão devem pertencer ao mesmo POP")
					}
				} else if num(body["b_port"]) > num(box.Get("ports")) {
					return apierr.New(400, fmt.Sprintf("a caixa tem %g porta(s)", num(box.Get("ports"))))
				}
				busy, e := tx.Objects(ctx, `select c.name,f.fiber from ftth_fusion_fibers f join ftth_cables c on c.id=f.cable_id where f.box_id=$1 and ((f.cable_id=$2 and f.fiber=$3) or (f.cable_id=$4 and f.fiber=$5)) order by c.name,f.fiber limit 1`, id, body["a_cable_id"], body["a_fiber"], body["b_cable_id"], body["b_fiber"])
				if e != nil {
					return e
				}
				if len(busy) > 0 {
					return apierr.New(409, fmt.Sprintf("a fibra %g do cabo %s já está fundida nesta caixa", num(busy[0].Get("fiber")), busy[0].Get("name")))
				}
				rows, e := tx.Objects(ctx, `insert into ftth_fusions(tenant_id,pop_id,box_id,a_cable_id,a_fiber,b_cable_id,b_fiber,b_port,loss_db,notes,created_by) values(app_tenant(),$1,$2,$3,$4,$5,$6,$7,$8,$9,nullif($10,'')::uuid) returning id`, pop, id, body["a_cable_id"], body["a_fiber"], body["b_cable_id"], body["b_fiber"], body["b_port"], body["loss_db"], body["notes"], auth.From(ctx).UserID)
				if e != nil {
					return uniqueViolation(e, fusionUnique)
				}
				fusion := rows[0].Get("id").(string)
				if e = tx.Exec(ctx, `insert into ftth_fusion_fibers(tenant_id,pop_id,fusion_id,box_id,cable_id,fiber) values(app_tenant(),$1,$2,$3,$4,$5)`, pop, fusion, id, body["a_cable_id"], body["a_fiber"]); e != nil {
					return uniqueViolation(e, fusionUnique)
				}
				if body["b_cable_id"] != nil {
					if e = tx.Exec(ctx, `insert into ftth_fusion_fibers(tenant_id,pop_id,fusion_id,box_id,cable_id,fiber) values(app_tenant(),$1,$2,$3,$4,$5)`, pop, fusion, id, body["b_cable_id"], body["b_fiber"]); e != nil {
						return uniqueViolation(e, fusionUnique)
					}
				}
				created, e := tx.Objects(ctx, `select `+fusionCols+fusionFrom+` where f.id=$1`, fusion)
				if e != nil {
					return e
				}
				result = created[0]
				return record(ctx, tx, "ftth.fusion_created", "ftth_fusion", fusion, map[string]any{"box_id": id, "a_cable_id": body["a_cable_id"], "a_fiber": body["a_fiber"], "b_cable_id": body["b_cable_id"], "b_fiber": body["b_fiber"], "b_port": body["b_port"]})
			})
			return endpoint.Result{Value: result}, err
		})
	}
}

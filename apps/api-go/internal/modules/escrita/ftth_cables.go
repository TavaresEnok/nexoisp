package escrita

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

// Projeto físico FTTH: cabos com traçado. O cadastro descreve o projeto; não
// comprova conectividade física nem atua na rede.

type ftthPoint struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

const cableCols = `c.id,c.pop_id,p.name as pop_name,c.name,c.kind,c.fiber_count,c.a_box_id,ab.name as a_box_name,c.a_site_id,asite.name as a_site_name,c.b_box_id,bb.name as b_box_name,c.b_site_id,bsite.name as b_site_name,c.computed_length_m,c.declared_length_m,c.notes,c.active,c.created_at,c.updated_at`
const cableFrom = ` from ftth_cables c join pops p on p.tenant_id=c.tenant_id and p.id=c.pop_id left join ftth_boxes ab on ab.id=c.a_box_id left join ftth_boxes bb on bb.id=c.b_box_id left join network_sites asite on asite.id=c.a_site_id left join network_sites bsite on bsite.id=c.b_site_id`

var cableFields = []string{"pop_id", "name", "kind", "fiber_count", "a_box_id", "a_site_id", "b_box_id", "b_site_id", "path", "declared_length_m", "notes", "active"}

var cableLabels = map[string]string{"pop_id": "POP", "name": "nome (2 a 120 caracteres)", "kind": "tipo de cabo", "fiber_count": "número de fibras (1 a 288)", "a_box_id": "caixa da ponta A", "a_site_id": "local da ponta A", "b_box_id": "caixa da ponta B", "b_site_id": "local da ponta B", "declared_length_m": "comprimento informado (até 1.000 km)", "notes": "observações (até 500 caracteres)", "active": "situação"}

func cableBad(field string) error {
	if label, ok := cableLabels[field]; ok {
		return apierr.New(400, "dados de cabo inválidos: "+label)
	}
	return apierr.New(400, "dados de cabo inválidos")
}

func rawNumber(v json.RawMessage) (float64, bool) {
	var f float64
	if string(v) == "null" || json.Unmarshal(v, &f) != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}
func rawInt(v json.RawMessage, min, max int) (int, bool) {
	f, ok := rawNumber(v)
	if !ok || f != math.Trunc(f) || f < float64(min) || f > float64(max) {
		return 0, false
	}
	return int(f), true
}
func rawString(v json.RawMessage) (string, bool) {
	var s string
	if string(v) == "null" || json.Unmarshal(v, &s) != nil || !utf8.ValidString(s) || strings.ContainsRune(s, 0) {
		return "", false
	}
	return s, true
}

// strictBody decodes a JSON object keeping raw values, so every field can be
// validated individually and unknown fields rejected.
func strictBody(r *http.Request) (map[string]json.RawMessage, error) {
	var b map[string]json.RawMessage
	if err := apierr.DecodeJSON(r, &b); err != nil {
		return nil, err
	}
	if b == nil {
		return nil, apierr.New(400, "corpo da requisição inválido")
	}
	return b, nil
}

func haversine(a, b ftthPoint) float64 {
	const radius = 6371008.8
	la1, la2 := a.Lat*math.Pi/180, b.Lat*math.Pi/180
	dla, dlo := la2-la1, (b.Lng-a.Lng)*math.Pi/180
	h := math.Sin(dla/2)*math.Sin(dla/2) + math.Cos(la1)*math.Cos(la2)*math.Sin(dlo/2)*math.Sin(dlo/2)
	return 2 * radius * math.Asin(math.Min(1, math.Sqrt(h)))
}

// pathLength soma os trechos do traçado em metros, com duas casas decimais.
func pathLength(path []ftthPoint) float64 {
	total := 0.0
	for i := 1; i < len(path); i++ {
		total += haversine(path[i-1], path[i])
	}
	return math.Round(total*100) / 100
}

func pathBounds(path []ftthPoint) (minLat, maxLat, minLng, maxLng float64) {
	minLat, maxLat, minLng, maxLng = 90, -90, 180, -180
	for _, p := range path {
		minLat, maxLat = math.Min(minLat, p.Lat), math.Max(maxLat, p.Lat)
		minLng, maxLng = math.Min(minLng, p.Lng), math.Max(maxLng, p.Lng)
	}
	return
}

func validPoint(lat, lng float64) bool {
	return !math.IsNaN(lat) && !math.IsNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

func parsePath(raw json.RawMessage) ([]ftthPoint, error) {
	var items []map[string]json.RawMessage
	if string(raw) == "null" || json.Unmarshal(raw, &items) != nil {
		return nil, apierr.New(400, "traçado inválido: informe uma lista de pontos {lat, lng}")
	}
	if len(items) < 2 || len(items) > 500 {
		return nil, apierr.New(400, "o traçado deve ter de 2 a 500 pontos")
	}
	out := make([]ftthPoint, len(items))
	for i, item := range items {
		lat, okLat := rawNumber(item["lat"])
		lng, okLng := rawNumber(item["lng"])
		if len(item) != 2 || item["lat"] == nil || item["lng"] == nil || !okLat || !okLng || !validPoint(lat, lng) {
			return nil, apierr.New(400, "traçado inválido no ponto "+strconv.Itoa(i+1)+": latitude entre -90 e 90 e longitude entre -180 e 180")
		}
		out[i] = ftthPoint{lat, lng}
	}
	return out, nil
}

func cableBody(r *http.Request, patch bool) (map[string]any, []ftthPoint, error) {
	b, err := strictBody(r)
	if err != nil {
		return nil, nil, err
	}
	if len(b) == 0 {
		return nil, nil, cableBad("")
	}
	out := map[string]any{}
	var path []ftthPoint
	for k, v := range b {
		switch k {
		case "pop_id", "name", "kind", "notes":
			s, ok := rawString(v)
			if !ok {
				return nil, nil, cableBad(k)
			}
			if k == "name" {
				s = strings.TrimSpace(s)
			}
			n := utf8.RuneCountInString(s)
			if (k == "pop_id" && validate.UUID(s) != nil) || (k == "name" && (n < 2 || n > 120)) || (k == "kind" && s != "aerial" && s != "underground" && s != "drop") || (k == "notes" && n > 500) {
				return nil, nil, cableBad(k)
			}
			out[k] = s
		case "a_box_id", "a_site_id", "b_box_id", "b_site_id":
			if string(v) == "null" {
				out[k] = nil
				continue
			}
			s, ok := rawString(v)
			if !ok || validate.UUID(s) != nil {
				return nil, nil, cableBad(k)
			}
			out[k] = s
		case "fiber_count":
			n, ok := rawInt(v, 1, 288)
			if !ok {
				return nil, nil, cableBad(k)
			}
			out[k] = n
		case "declared_length_m":
			if string(v) == "null" {
				out[k] = nil
				continue
			}
			f, ok := rawNumber(v)
			if !ok || f <= 0 || f > 1000000 {
				return nil, nil, cableBad(k)
			}
			out[k] = math.Round(f*100) / 100
		case "path":
			if path, err = parsePath(v); err != nil {
				return nil, nil, err
			}
		case "active":
			var x bool
			if !patch || string(v) == "null" || json.Unmarshal(v, &x) != nil {
				return nil, nil, cableBad(k)
			}
			out[k] = x
		default:
			return nil, nil, cableBad("")
		}
	}
	if !patch {
		for _, k := range []string{"pop_id", "name", "kind", "fiber_count"} {
			if _, ok := out[k]; !ok {
				return nil, nil, cableBad(k)
			}
		}
		if path == nil {
			return nil, nil, apierr.New(400, "o traçado deve ter de 2 a 500 pontos")
		}
		for _, k := range []string{"a_box_id", "a_site_id", "b_box_id", "b_site_id", "declared_length_m"} {
			if _, ok := out[k]; !ok {
				out[k] = nil
			}
		}
		if _, ok := out["notes"]; !ok {
			out["notes"] = ""
		}
		out["active"] = true
	}
	return out, path, nil
}

// cableEndpoints confere as extremidades: caixa do provedor ou local físico do
// mesmo POP do cabo, nunca as duas na mesma ponta.
func cableEndpoints(ctx context.Context, tx *db.Tx, body map[string]any) error {
	for _, side := range []string{"a", "b"} {
		label := map[string]string{"a": "A", "b": "B"}[side]
		box, site := body[side+"_box_id"], body[side+"_site_id"]
		if box != nil && site != nil {
			return apierr.New(400, "informe caixa ou local na ponta "+label+", não os dois")
		}
		if box != nil {
			rows, err := tx.Objects(ctx, `select id from ftth_boxes where id=$1 for key share`, box)
			if err != nil {
				return err
			}
			if len(rows) == 0 {
				return apierr.New(400, "caixa da ponta "+label+" não encontrada")
			}
		}
		if site != nil {
			rows, err := tx.Objects(ctx, `select pop_id from network_sites where id=$1 for key share`, site)
			if err != nil {
				return err
			}
			if len(rows) == 0 {
				return apierr.New(400, "local da ponta "+label+" não encontrado")
			}
			if rows[0].Get("pop_id") != body["pop_id"] {
				return apierr.New(400, "o local da ponta "+label+" deve pertencer ao POP do cabo")
			}
		}
	}
	return nil
}

func cableGet(ctx context.Context, tx *db.Tx, id string, lock bool) (jsonx.Object, error) {
	suffix := ""
	if lock {
		suffix = " for update of c"
	}
	rows, err := tx.Objects(ctx, `select `+cableCols+`,c.path,(select count(*)::int from ftth_fusion_fibers f where f.cable_id=c.id) as fusion_count,(select count(*)::int from ftth_otdr_measurements o where o.cable_id=c.id) as otdr_count`+cableFrom+` where c.id=$1`+suffix, id)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, apierr.New(404, "cabo não encontrado")
	}
	return rows[0], nil
}

type cableFilter struct {
	q, kind, pop, status string
	limit, offset        int
}

func cableQuery(raw string) (cableFilter, error) {
	f := cableFilter{status: "active", limit: 50}
	bad := apierr.New(400, "filtro de cabos inválido")
	q, err := url.ParseQuery(raw)
	if err != nil {
		return f, bad
	}
	for k, v := range q {
		if len(v) != 1 {
			return f, bad
		}
		s := v[0]
		switch k {
		case "q":
			if !utf8.ValidString(s) || strings.ContainsRune(s, 0) || utf8.RuneCountInString(s) > 100 {
				return f, bad
			}
			f.q = s
		case "kind":
			if s != "aerial" && s != "underground" && s != "drop" {
				return f, bad
			}
			f.kind = s
		case "pop_id":
			if validate.UUID(s) != nil {
				return f, bad
			}
			f.pop = s
		case "status":
			if s != "active" && s != "archived" && s != "all" {
				return f, bad
			}
			f.status = s
		case "limit", "offset":
			n, e := strconv.Atoi(s)
			if e != nil || (k == "limit" && (n < 1 || n > 100)) || (k == "offset" && (n < 0 || n > 100000)) {
				return f, bad
			}
			if k == "limit" {
				f.limit = n
			} else {
				f.offset = n
			}
		default:
			return f, bad
		}
	}
	return f, nil
}

type mapBox struct{ south, north, west, east float64 }

func cableMapQuery(raw string) (mapBox, error) {
	bad := apierr.New(400, "área do mapa inválida")
	q, err := url.ParseQuery(raw)
	if err != nil || len(q) != 4 {
		return mapBox{}, bad
	}
	values := map[string]float64{}
	for _, k := range []string{"south", "north", "west", "east"} {
		v := q[k]
		if len(v) != 1 {
			return mapBox{}, bad
		}
		f, e := strconv.ParseFloat(v[0], 64)
		if e != nil || math.IsNaN(f) || math.IsInf(f, 0) {
			return mapBox{}, bad
		}
		values[k] = f
	}
	b := mapBox{values["south"], values["north"], values["west"], values["east"]}
	if !validPoint(b.south, b.west) || !validPoint(b.north, b.east) || b.south > b.north || b.west > b.east {
		return mapBox{}, bad
	}
	return b, nil
}

// uniqueViolation traduz conflitos de unicidade em mensagens do domínio.
func uniqueViolation(err error, messages map[string]string) error {
	var p *pgconn.PgError
	if errors.As(err, &p) && p.Code == "23505" {
		if m, ok := messages[p.ConstraintName]; ok {
			return apierr.New(409, m)
		}
	}
	return err
}

var cableUnique = map[string]string{"ftth_cables_tenant_id_pop_id_name_key": "já existe um cabo com este nome no POP"}

// registerFTTHDesign agrupa as rotas do projeto físico FTTH.
func registerFTTHDesign(api huma.API, registry *endpoint.Registry, s Service) {
	registerFTTHCables(api, registry, s)
	registerFTTHFusions(api, registry, s)
	registerFTTHOTDR(api, registry, s)
	registerFTTHKML(api, registry, s)
}

func registerFTTHCables(api huma.API, registry *endpoint.Registry, s Service) {
	for _, route := range []struct{ method, path, permission string }{{"GET", "/api/ftth/cables", "network:read"}, {"GET", "/api/ftth/cables/map", "network:read"}, {"GET", "/api/ftth/cables/{id}", "network:read"}, {"POST", "/api/ftth/cables", "network:write"}, {"PATCH", "/api/ftth/cables/{id}", "network:write"}} {
		route := route
		registry.Handle(api, route.method, route.path, route.permission, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			actor, err := siteActor(ctx)
			if err != nil {
				return endpoint.Result{}, err
			}
			id := chi.URLParam(r, "id")
			if id != "" {
				if err = validate.UUID(id); err != nil {
					return endpoint.Result{}, err
				}
			}
			var body map[string]any
			var path []ftthPoint
			var filter cableFilter
			var area mapBox
			switch {
			case route.method == "POST" || route.method == "PATCH":
				body, path, err = cableBody(r, route.method == "PATCH")
			case route.path == "/api/ftth/cables/map":
				area, err = cableMapQuery(r.URL.RawQuery)
			case id == "":
				filter, err = cableQuery(r.URL.RawQuery)
			}
			if err != nil {
				return endpoint.Result{}, err
			}
			var result any
			err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
				switch {
				case route.path == "/api/ftth/cables/map":
					rows, e := tx.Objects(ctx, `select c.id,c.name,c.kind,c.fiber_count,c.pop_id,p.name as pop_name,c.computed_length_m,c.path from ftth_cables c join pops p on p.tenant_id=c.tenant_id and p.id=c.pop_id where c.active and c.max_lat>=$1 and c.min_lat<=$2 and c.max_lng>=$3 and c.min_lng<=$4 order by c.name,c.id limit 501`, area.south, area.north, area.west, area.east)
					if e != nil {
						return e
					}
					truncated := len(rows) > 500
					if truncated {
						rows = rows[:500]
					}
					result = map[string]any{"items": rows, "truncated": truncated}
					return nil
				case route.method == "GET" && id != "":
					var e error
					result, e = cableGet(ctx, tx, id, false)
					return e
				case route.method == "GET":
					if filter.pop != "" {
						if e := sitePop(ctx, tx, filter.pop, false); e != nil {
							return e
						}
					}
					rows, e := tx.Objects(ctx, `with filtered as (select `+cableCols+cableFrom+` where ($1='' or position(lower($1) in lower(c.name))>0) and ($2='' or c.kind=$2) and ($3='' or c.pop_id=nullif($3,'')::uuid) and ($4='all' or c.active=($4='active'))), page as (select * from filtered order by name,id limit $5 offset $6) select (select count(*)::int from filtered) total,coalesce((select jsonb_agg(to_jsonb(page) order by name,id) from page),'[]'::jsonb) items`, filter.q, filter.kind, filter.pop, filter.status, filter.limit, filter.offset)
					if e != nil {
						return e
					}
					result = map[string]any{"items": rows[0].Get("items"), "total": rows[0].Get("total"), "limit": filter.limit, "offset": filter.offset}
					return nil
				}
				var old jsonx.Object
				if route.method == "PATCH" {
					var e error
					if old, e = cableGet(ctx, tx, id, true); e != nil {
						return e
					}
					for _, k := range cableFields {
						if _, ok := body[k]; !ok && k != "path" {
							body[k] = old.Get(k)
						}
					}
					if path == nil {
						raw, e := json.Marshal(old.Get("path"))
						if e != nil {
							return e
						}
						if path, e = parsePath(raw); e != nil {
							return e
						}
					}
					if num(body["fiber_count"]) < num(old.Get("fiber_count")) {
						used, e := tx.Objects(ctx, `select greatest((select max(fiber) from ftth_fusion_fibers where cable_id=$1),(select max(fiber) from ftth_otdr_measurements where cable_id=$1)) as top`, id)
						if e != nil {
							return e
						}
						if top := used[0].Get("top"); top != nil && num(top) > num(body["fiber_count"]) {
							return apierr.New(409, "a fibra "+strconv.Itoa(int(num(top)))+" tem fusão ou medição OTDR; o cabo não pode ter menos fibras")
						}
					}
					if body["pop_id"] != old.Get("pop_id") && (num(old.Get("fusion_count")) > 0 || num(old.Get("otdr_count")) > 0) {
						return apierr.New(409, "o cabo tem fusões ou medições OTDR; o POP não pode ser alterado")
					}
				}
				if old == nil || body["pop_id"] != old.Get("pop_id") || (old.Get("active") == false && body["active"] == true) {
					if e := sitePop(ctx, tx, body["pop_id"].(string), true); e != nil {
						return e
					}
				}
				changed := old == nil || body["pop_id"] != old.Get("pop_id")
				for _, k := range []string{"a_box_id", "a_site_id", "b_box_id", "b_site_id"} {
					changed = changed || body[k] != old.Get(k)
				}
				if changed {
					if e := cableEndpoints(ctx, tx, body); e != nil {
						return e
					}
				}
				encoded, e := json.Marshal(path)
				if e != nil {
					return e
				}
				minLat, maxLat, minLng, maxLng := pathBounds(path)
				args := []any{body["pop_id"], body["name"], body["kind"], body["fiber_count"], body["a_box_id"], body["a_site_id"], body["b_box_id"], body["b_site_id"], string(encoded), pathLength(path), body["declared_length_m"], minLat, maxLat, minLng, maxLng, body["notes"], body["active"]}
				if route.method == "PATCH" {
					if e = tx.Exec(ctx, `update ftth_cables set pop_id=$2,name=$3,kind=$4,fiber_count=$5,a_box_id=$6,a_site_id=$7,b_box_id=$8,b_site_id=$9,path=$10::jsonb,computed_length_m=$11,declared_length_m=$12,min_lat=$13,max_lat=$14,min_lng=$15,max_lng=$16,notes=$17,active=$18,updated_at=now() where id=$1`, append([]any{id}, args...)...); e != nil {
						return uniqueViolation(e, cableUnique)
					}
					if result, e = cableGet(ctx, tx, id, false); e != nil {
						return e
					}
					return record(ctx, tx, "ftth.cable_updated", "ftth_cable", id, nil)
				}
				rows, e := tx.Objects(ctx, `insert into ftth_cables(tenant_id,pop_id,name,kind,fiber_count,a_box_id,a_site_id,b_box_id,b_site_id,path,computed_length_m,declared_length_m,min_lat,max_lat,min_lng,max_lng,notes,active) values(app_tenant(),$1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17) returning id`, args...)
				if e != nil {
					return uniqueViolation(e, cableUnique)
				}
				newID := rows[0].Get("id").(string)
				if result, e = cableGet(ctx, tx, newID, false); e != nil {
					return e
				}
				return record(ctx, tx, "ftth.cable_created", "ftth_cable", newID, nil)
			})
			return endpoint.Result{Value: result}, err
		})
	}
}

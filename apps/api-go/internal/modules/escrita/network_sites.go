package escrita

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

const siteCols = `s.id,s.pop_id,p.name as pop_name,s.kind,s.name,s.city,s.address,s.latitude,s.longitude,s.notes,s.active,s.created_at,s.updated_at`

func siteBad() error { return apierr.New(400, "dados de local inválidos") }
func siteActor(ctx context.Context) (*auth.Ctx, error) {
	c := auth.From(ctx)
	if c == nil || c.TenantID == "" || c.Scope.TenantID != c.TenantID || c.Scope.IsOperator() || c.Role == "subscriber" || c.SubscriberID != "" || c.Scope.SubscriberID != "" || !slices.Equal(c.PopIDs, c.Scope.PopIDs) {
		return nil, apierr.New(403, "escopo de provedor inválido")
	}
	return c, nil
}
func siteBody(r *http.Request, patch bool) (map[string]any, error) {
	var b map[string]json.RawMessage
	if err := apierr.DecodeJSON(r, &b); err != nil {
		return nil, err
	}
	if len(b) == 0 {
		return nil, siteBad()
	}
	out := map[string]any{}
	for k, v := range b {
		switch k {
		case "pop_id", "kind", "name", "city", "address", "notes":
			if string(v) == "null" && (k == "city" || k == "address") {
				out[k] = nil
				continue
			}
			var s string
			if string(v) == "null" || json.Unmarshal(v, &s) != nil || !utf8.ValidString(s) || strings.ContainsRune(s, 0) {
				return nil, siteBad()
			}
			if k == "name" || k == "city" || k == "address" {
				s = strings.TrimSpace(s)
			}
			n := utf8.RuneCountInString(s)
			if (k == "pop_id" && validate.UUID(s) != nil) || (k == "kind" && s != "pole" && s != "tower" && s != "building") || (k == "name" && (n < 2 || n > 120)) || (k == "city" && n > 100) || (k == "address" && n > 300) || (k == "notes" && n > 500) {
				return nil, siteBad()
			}
			out[k] = s
		case "latitude", "longitude":
			if string(v) == "null" {
				out[k] = nil
				continue
			}
			var f float64
			if json.Unmarshal(v, &f) != nil || math.IsNaN(f) || math.IsInf(f, 0) || (k == "latitude" && (f < -90 || f > 90)) || (k == "longitude" && (f < -180 || f > 180)) {
				return nil, siteBad()
			}
			out[k] = f
		case "active":
			var x bool
			if !patch || string(v) == "null" || json.Unmarshal(v, &x) != nil {
				return nil, siteBad()
			}
			out[k] = x
		default:
			return nil, siteBad()
		}
	}
	if _, a := out["latitude"]; a {
		if _, b := out["longitude"]; !b || (out["latitude"] == nil) != (out["longitude"] == nil) {
			return nil, siteBad()
		}
	} else if _, b := out["longitude"]; b {
		return nil, siteBad()
	}
	if !patch {
		for _, k := range []string{"pop_id", "kind", "name"} {
			if _, ok := out[k]; !ok {
				return nil, siteBad()
			}
		}
		if _, ok := out["notes"]; !ok {
			out["notes"] = ""
		}
		out["active"] = true
	}
	return out, nil
}

type siteFilter struct {
	q, kind, pop, status string
	limit, offset        int
}

func siteQuery(raw string) (siteFilter, error) {
	f := siteFilter{status: "active", limit: 50}
	q, err := url.ParseQuery(raw)
	if err != nil {
		return f, siteBad()
	}
	for k, v := range q {
		if len(v) != 1 {
			return f, siteBad()
		}
		s := v[0]
		switch k {
		case "q":
			if !utf8.ValidString(s) || strings.ContainsRune(s, 0) || utf8.RuneCountInString(s) > 100 {
				return f, siteBad()
			}
			f.q = s
		case "kind":
			if s != "pole" && s != "tower" && s != "building" {
				return f, siteBad()
			}
			f.kind = s
		case "pop_id":
			if validate.UUID(s) != nil {
				return f, siteBad()
			}
			f.pop = s
		case "status":
			if s != "active" && s != "archived" && s != "all" {
				return f, siteBad()
			}
			f.status = s
		case "limit", "offset":
			n, e := strconv.Atoi(s)
			if e != nil || (k == "limit" && (n < 1 || n > 100)) || (k == "offset" && (n < 0 || n > 100000)) {
				return f, siteBad()
			}
			if k == "limit" {
				f.limit = n
			} else {
				f.offset = n
			}
		default:
			return f, siteBad()
		}
	}
	return f, nil
}
func sitePop(ctx context.Context, tx *db.Tx, id string, active bool) error {
	lock := ""
	if active {
		lock = " for share"
	}
	rows, err := tx.Objects(ctx, `select active from pops where tenant_id=app_tenant() and id=$1 and (app_pops() is null or id=any(app_pops()))`+lock, id)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return apierr.New(404, "POP não encontrado")
	}
	if active && rows[0].Get("active") != true {
		return apierr.New(400, "POP inativo")
	}
	return nil
}
func siteGet(ctx context.Context, tx *db.Tx, id string, lock bool) (jsonx.Object, error) {
	suffix := ""
	if lock {
		suffix = " for update of s"
	}
	rows, err := tx.Objects(ctx, `select `+siteCols+` from network_sites s join pops p on p.tenant_id=s.tenant_id and p.id=s.pop_id where s.id=$1`+suffix, id)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, apierr.New(404, "local não encontrado")
	}
	return rows[0], nil
}

func sitePage(ctx context.Context, tx *db.Tx, filter siteFilter) (int, []jsonx.Object, error) {
	if filter.pop != "" {
		if e := sitePop(ctx, tx, filter.pop, false); e != nil {
			return 0, nil, e
		}
	}
	rows, e := tx.Objects(ctx, `with filtered as (select `+siteCols+` from network_sites s join pops p on p.tenant_id=s.tenant_id and p.id=s.pop_id where ($1='' or position(lower($1) in lower(s.name))>0 or position(lower($1) in lower(coalesce(s.city,'')))>0 or position(lower($1) in lower(coalesce(s.address,'')))>0) and ($2='' or s.kind=$2) and ($3='' or s.pop_id=nullif($3,'')::uuid) and ($4='all' or s.active=($4='active'))), page as (select * from filtered order by kind,name,id limit $5 offset $6) select (select count(*)::int from filtered) total,coalesce((select jsonb_agg(to_jsonb(page) order by kind,name,id) from page),'[]'::jsonb) items`, filter.q, filter.kind, filter.pop, filter.status, filter.limit, filter.offset)
	if e != nil {
		return 0, nil, e
	}
	total := 0
	if t := rows[0].Get("total"); t != nil {
		switch v := t.(type) {
		case int:
			total = v
		case int32:
			total = int(v)
		case int64:
			total = int(v)
		case float64:
			total = int(v)
		}
	}
	items := []jsonx.Object{}
	switch raw := rows[0].Get("items").(type) {
	case []jsonx.Object:
		items = raw
	case []any:
		items = make([]jsonx.Object, len(raw))
		for i, v := range raw {
			if obj, ok := v.(jsonx.Object); ok {
				items[i] = obj
			}
		}
	}
	return total, items, nil
}

func registerNetworkSites(api huma.API, registry *endpoint.Registry, s Service) {
	registerNetworkSitesExport(api, registry, s)
	for _, route := range []struct{ method, path, permission string }{{"GET", "/api/network/sites", "network:read"}, {"GET", "/api/network/sites/{id}", "network:read"}, {"POST", "/api/network/sites", "network:write"}, {"PATCH", "/api/network/sites/{id}", "network:write"}} {
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
			var filter siteFilter
			if route.method == "POST" || route.method == "PATCH" {
				body, err = siteBody(r, route.method == "PATCH")
			} else if id == "" {
				filter, err = siteQuery(r.URL.RawQuery)
			}
			if err != nil {
				return endpoint.Result{}, err
			}
			var result any
			err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
				if route.method == "GET" {
					if id != "" {
						var e error
						result, e = siteGet(ctx, tx, id, false)
						return e
					}
					total, items, e := sitePage(ctx, tx, filter)
					if e != nil {
						return e
					}
					result = map[string]any{"items": items, "total": total, "limit": filter.limit, "offset": filter.offset}
					return nil
				}
				if route.method == "PATCH" {
					old, e := siteGet(ctx, tx, id, true)
					if e != nil {
						return e
					}
					for _, k := range []string{"pop_id", "kind", "name", "city", "address", "latitude", "longitude", "notes", "active"} {
						if _, ok := body[k]; !ok {
							body[k] = old.Get(k)
						}
					}
					if body["pop_id"] != old.Get("pop_id") || (old.Get("active") == false && body["active"] == true) {
						if e = sitePop(ctx, tx, body["pop_id"].(string), true); e != nil {
							return e
						}
					}
					e = tx.Exec(ctx, `update network_sites set pop_id=$2,kind=$3,name=$4,city=$5,address=$6,latitude=$7,longitude=$8,notes=$9,active=$10,updated_at=now() where id=$1`, id, body["pop_id"], body["kind"], body["name"], body["city"], body["address"], body["latitude"], body["longitude"], body["notes"], body["active"])
					if e != nil {
						return e
					}
					result, e = siteGet(ctx, tx, id, false)
					if e != nil {
						return e
					}
					return record(ctx, tx, "network.site_updated", "network_site", id, nil)
				}
				if e := sitePop(ctx, tx, body["pop_id"].(string), true); e != nil {
					return e
				}
				rows, e := tx.Objects(ctx, `insert into network_sites(tenant_id,pop_id,kind,name,city,address,latitude,longitude,notes) values(app_tenant(),$1,$2,$3,$4,$5,$6,$7,$8) returning id`, body["pop_id"], body["kind"], body["name"], body["city"], body["address"], body["latitude"], body["longitude"], body["notes"])
				if e != nil {
					return e
				}
				result, e = siteGet(ctx, tx, rows[0].Get("id").(string), false)
				if e != nil {
					return e
				}
				return record(ctx, tx, "network.site_created", "network_site", rows[0].Get("id"), nil)
			})
			return endpoint.Result{Value: result}, err
		})
	}
}

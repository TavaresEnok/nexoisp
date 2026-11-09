package escrita

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"nexoisp/api-go/internal/acs"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

// Templates ACS: provisionamento TR-069 por fabricante/modelo/firmware. A
// aplicação gera a mesma intenção durável das tarefas CPE (acs.PrepareTask);
// nenhuma rota daqui chama o ACS para alterar o roteador.

const acsTemplateCols = `id,name,manufacturer,model,firmware,parameters::text as parameters,inform_interval,active,revision,created_at,updated_at`

var wifiText = regexp.MustCompile(`^[\x20-\x7E]+$`)

type acsTemplate struct {
	ID, Name, Manufacturer, Model, Firmware string
	Params                                  []acs.TemplateParam
	Inform                                  *int
	Active                                  bool
	Revision                                int
	row                                     jsonx.Object
}

func acsTemplateBad(message string) error { return apierr.New(400, "template ACS: "+message) }

func acsTemplateActor(ctx context.Context, write bool) (*auth.Ctx, error) {
	c, err := siteActor(ctx)
	if err != nil {
		return nil, err
	}
	if write && len(c.PopIDs) > 0 {
		return nil, apierr.New(403, "templates ACS valem para todo o provedor; a alteração exige acesso sem restrição de POP")
	}
	return c, nil
}

func scanACSTemplates(rows []jsonx.Object) ([]acsTemplate, error) {
	out := make([]acsTemplate, 0, len(rows))
	for _, row := range rows {
		t := acsTemplate{ID: jsonx.String(row.Get("id")), Name: jsonx.String(row.Get("name")), Manufacturer: jsonx.String(row.Get("manufacturer")), Model: jsonx.String(row.Get("model")), Firmware: jsonx.String(row.Get("firmware")), Active: row.Get("active") == true, Revision: int(num(row.Get("revision"))), row: row}
		if err := json.Unmarshal([]byte(jsonx.String(row.Get("parameters"))), &t.Params); err != nil {
			return nil, err
		}
		if v := row.Get("inform_interval"); v != nil {
			n := int(num(v))
			t.Inform = &n
		}
		out = append(out, t)
	}
	return out, nil
}

func loadACSTemplate(ctx context.Context, tx *db.Tx, id string, lock bool) (*acsTemplate, error) {
	suffix := ""
	if lock {
		suffix = " for update"
	}
	rows, err := tx.Objects(ctx, `select `+acsTemplateCols+` from acs_templates where id=$1`+suffix, id)
	if err != nil {
		return nil, err
	}
	list, err := scanACSTemplates(rows)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, apierr.New(404, "template ACS não encontrado")
	}
	return &list[0], nil
}

func dataModel(root string) any {
	switch root {
	case "InternetGatewayDevice":
		return "tr098"
	case "Device":
		return "tr181"
	}
	return nil
}

func (t acsTemplate) view() map[string]any {
	used := []string{}
	for _, p := range t.Params {
		for _, name := range acs.TemplateVariablesIn(p.Value) {
			if !slices.Contains(used, name) {
				used = append(used, name)
			}
		}
	}
	params := t.Params
	if params == nil {
		params = []acs.TemplateParam{}
	}
	var inform any
	if t.Inform != nil {
		inform = *t.Inform
	}
	return map[string]any{"id": t.ID, "name": t.Name, "manufacturer": t.Manufacturer, "model": t.Model, "firmware": t.Firmware, "parameters": params, "inform_interval": inform, "active": t.Active, "revision": t.Revision, "data_model": dataModel(acs.TemplateRoot(t.Params)), "variables": used, "specificity": acs.PatternSpecificity(t.Manufacturer, t.Model, t.Firmware), "created_at": t.row.Get("created_at"), "updated_at": t.row.Get("updated_at")}
}

func acsTemplateBody(r *http.Request, patch bool) (map[string]any, error) {
	var raw map[string]json.RawMessage
	if err := apierr.DecodeJSON(r, &raw); err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return nil, acsTemplateBad("informe os dados do template")
	}
	out := map[string]any{}
	for k, v := range raw {
		switch k {
		case "name", "manufacturer", "model", "firmware":
			var s string
			if json.Unmarshal(v, &s) != nil || !utf8.ValidString(s) {
				return nil, acsTemplateBad("campo " + k + " inválido")
			}
			s = strings.TrimSpace(s)
			if k == "name" {
				if n := utf8.RuneCountInString(s); n < 2 || n > 120 || strings.ContainsRune(s, 0) {
					return nil, acsTemplateBad("nome deve ter de 2 a 120 caracteres")
				}
			} else {
				if s == "" {
					s = "*"
				}
				if !acs.ValidPattern(s) {
					return nil, acsTemplateBad("fabricante, modelo e firmware aceitam até 100 caracteres, com curingas * e ?")
				}
			}
			out[k] = s
		case "parameters":
			var params []acs.TemplateParam
			if string(v) == "null" || json.Unmarshal(v, &params) != nil {
				return nil, acsTemplateBad("lista de parâmetros inválida")
			}
			clean, err := acs.ValidateTemplateParams(params)
			if err != nil {
				return nil, err
			}
			out[k] = clean
		case "inform_interval":
			if string(v) == "null" {
				out[k] = nil
				continue
			}
			var n float64
			if json.Unmarshal(v, &n) != nil || n != float64(int(n)) || n < 60 || n > 86400 {
				return nil, acsTemplateBad("intervalo de inform periódico deve ser de 60 a 86400 segundos")
			}
			out[k] = int(n)
		case "active":
			var b bool
			if !patch || json.Unmarshal(v, &b) != nil || string(v) == "null" {
				return nil, acsTemplateBad("situação inválida")
			}
			out[k] = b
		default:
			return nil, acsTemplateBad("campo desconhecido: " + k)
		}
	}
	if !patch {
		if _, ok := out["name"]; !ok {
			return nil, acsTemplateBad("informe o nome")
		}
		for _, k := range []string{"manufacturer", "model", "firmware"} {
			if _, ok := out[k]; !ok {
				out[k] = "*"
			}
		}
		if _, ok := out["parameters"]; !ok {
			out["parameters"] = []acs.TemplateParam{}
		}
		if _, ok := out["inform_interval"]; !ok {
			out["inform_interval"] = nil
		}
	}
	return out, nil
}

func acsTemplateNameTaken(ctx context.Context, tx *db.Tx, name, except string) error {
	var taken bool
	if err := tx.QueryRow(ctx, `select exists(select 1 from acs_templates where lower(name)=lower($1) and id::text<>$2)`, name, except).Scan(&taken); err != nil {
		return err
	}
	if taken {
		return apierr.New(409, "já existe um template ACS com este nome")
	}
	return nil
}

// Variáveis do contrato. Senhas são lidas somente quando o template as usa.
type templateContext struct {
	contract, linked string
	vars             map[string]string
}

var variableLabels = map[string]string{"pppoe_usuario": "usuário PPPoE do contrato", "pppoe_senha": "senha PPPoE armazenada", "wifi_ssid": "nome da rede Wi-Fi", "wifi_senha": "senha do Wi-Fi", "contrato_codigo": "código do contrato", "assinante_nome": "nome do assinante"}

func templateUses(t *acsTemplate, name string) bool {
	for _, p := range t.Params {
		if slices.Contains(acs.TemplateVariablesIn(p.Value), name) {
			return true
		}
	}
	return false
}

func loadTemplateContext(ctx context.Context, tx *db.Tx, contract string, t *acsTemplate, wifi map[string]string) (*templateContext, error) {
	rows, err := tx.Objects(ctx, `select k.id, coalesce(nullif(k.external_id,''), upper(left(k.id::text,8))) as code, s.name as subscriber_name from contracts k join subscribers s on s.id=k.subscriber_id and s.tenant_id=k.tenant_id where k.id=$1`, contract)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, apierr.New(404, "contrato não encontrado")
	}
	out := &templateContext{contract: contract, vars: map[string]string{"contrato_codigo": jsonx.String(rows[0].Get("code")), "assinante_nome": jsonx.String(rows[0].Get("subscriber_name"))}}
	for k, v := range wifi {
		out.vars[k] = v
	}
	resources, err := tx.Objects(ctx, `select pppoe_username, secret_enc, access_type from service_resources where contract_id=$1`, contract)
	if err != nil {
		return nil, err
	}
	if len(resources) == 1 && resources[0].Get("access_type") == "pppoe" {
		out.vars["pppoe_usuario"] = jsonx.String(resources[0].Get("pppoe_username"))
		if cipher, ok := resources[0].Get("secret_enc").(string); ok && cipher != "" && t != nil && templateUses(t, "pppoe_senha") {
			if plain, e := cryptox.DecryptSecret(cipher); e == nil {
				out.vars["pppoe_senha"] = plain
			}
		}
	}
	links, err := tx.Objects(ctx, `select acs_device_id from cpe_links where contract_id=$1`, contract)
	if err != nil {
		return nil, err
	}
	if len(links) == 1 {
		out.linked = jsonx.String(links[0].Get("acs_device_id"))
	}
	return out, nil
}

func templateWifiBody(raw map[string]json.RawMessage) (map[string]string, error) {
	out := map[string]string{}
	for _, k := range []string{"wifi_ssid", "wifi_senha"} {
		v, ok := raw[k]
		if !ok || string(v) == "null" {
			continue
		}
		var s string
		if json.Unmarshal(v, &s) != nil {
			return nil, acsTemplateBad("valor de " + variableLabels[k] + " inválido")
		}
		if k == "wifi_ssid" {
			s = strings.TrimSpace(s)
			if s == "" {
				continue
			}
			if len(s) > 32 || !wifiText.MatchString(s) {
				return nil, apierr.New(400, "nome da rede: até 32 caracteres comuns (sem acento)")
			}
		} else {
			if s == "" {
				continue
			}
			if len(s) < 8 || len(s) > 63 || !wifiText.MatchString(s) {
				return nil, apierr.New(400, "senha do Wi-Fi: de 8 a 63 caracteres comuns (sem acento)")
			}
		}
		out[k] = s
	}
	return out, nil
}

func deviceView(device map[string]any) map[string]any {
	if device == nil {
		return nil
	}
	manufacturer, models, firmware := acs.DeviceIdentity(device)
	return map[string]any{"id": device["_id"], "manufacturer": manufacturer, "model": models[0], "firmware": firmware, "data_model": acs.Model(device)}
}

func templateFits(t *acsTemplate, device map[string]any) (bool, bool) {
	root := acs.TemplateRoot(t.Params)
	return acs.TemplateMatches(t.Manufacturer, t.Model, t.Firmware, device), root == "" || root == acs.DeviceRoot(device)
}

func missingMessage(missing []string) string {
	labels := make([]string, 0, len(missing))
	for _, name := range missing {
		labels = append(labels, variableLabels[name]+" ({{"+name+"}})")
	}
	return "valores indisponíveis para o template: " + strings.Join(labels, ", ")
}

func registerACSTemplates(api huma.API, registry *endpoint.Registry, s Service) {
	list := func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		actor, err := acsTemplateActor(ctx, false)
		if err != nil {
			return endpoint.Result{}, err
		}
		q, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil {
			return endpoint.Result{}, acsTemplateBad("filtro inválido")
		}
		text, status := "", "all"
		for k, v := range q {
			if len(v) != 1 {
				return endpoint.Result{}, acsTemplateBad("filtro inválido")
			}
			switch k {
			case "q":
				if !utf8.ValidString(v[0]) || strings.ContainsRune(v[0], 0) || utf8.RuneCountInString(v[0]) > 100 {
					return endpoint.Result{}, acsTemplateBad("busca inválida")
				}
				text = strings.TrimSpace(v[0])
			case "status":
				if v[0] != "active" && v[0] != "archived" && v[0] != "all" {
					return endpoint.Result{}, acsTemplateBad("situação inválida")
				}
				status = v[0]
			default:
				return endpoint.Result{}, acsTemplateBad("filtro desconhecido: " + k)
			}
		}
		var out map[string]any
		err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
			rows, e := tx.Objects(ctx, `select `+acsTemplateCols+` from acs_templates where ($1='' or position(lower($1) in lower(name||' '||manufacturer||' '||model||' '||firmware))>0) and ($2='all' or active=($2='active')) order by active desc,lower(name),id limit 200`, text, status)
			if e != nil {
				return e
			}
			items, e := scanACSTemplates(rows)
			if e != nil {
				return e
			}
			views := make([]map[string]any, 0, len(items))
			for _, t := range items {
				views = append(views, t.view())
			}
			out = map[string]any{"items": views, "total": len(views), "variables": acs.TemplateVariables}
			return nil
		})
		return endpoint.Result{Value: out}, err
	}
	registry.Get(api, "/api/acs/templates", "network:read", false, list)
	registry.Get(api, "/api/acs/templates/{id}", "network:read", false, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		actor, err := acsTemplateActor(ctx, false)
		if err != nil {
			return endpoint.Result{}, err
		}
		id := chi.URLParam(r, "id")
		if validate.UUID(id) != nil {
			return endpoint.Result{}, acsTemplateBad("identificador inválido")
		}
		var out any
		err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
			t, e := loadACSTemplate(ctx, tx, id, false)
			if e == nil {
				out = t.view()
			}
			return e
		})
		return endpoint.Result{Value: out}, err
	})
	registry.Handle(api, http.MethodPost, "/api/acs/templates", "network:write", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		actor, err := acsTemplateActor(ctx, true)
		if err != nil {
			return endpoint.Result{}, err
		}
		body, err := acsTemplateBody(r, false)
		if err != nil {
			return endpoint.Result{}, err
		}
		params := body["parameters"].([]acs.TemplateParam)
		if len(params) == 0 && body["inform_interval"] == nil {
			return endpoint.Result{}, acsTemplateBad("informe ao menos um parâmetro ou o intervalo de inform periódico")
		}
		encoded, _ := json.Marshal(params)
		var out any
		err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
			if e := acsTemplateNameTaken(ctx, tx, body["name"].(string), ""); e != nil {
				return e
			}
			var id string
			if e := tx.QueryRow(ctx, `insert into acs_templates(tenant_id,name,manufacturer,model,firmware,parameters,inform_interval,created_by) values(app_tenant(),$1,$2,$3,$4,$5::jsonb,$6,$7) returning id`, body["name"], body["manufacturer"], body["model"], body["firmware"], string(encoded), body["inform_interval"], actor.UserID).Scan(&id); e != nil {
				return e
			}
			t, e := loadACSTemplate(ctx, tx, id, false)
			if e != nil {
				return e
			}
			out = t.view()
			return record(ctx, tx, "acs.template_created", "acs_template", id, map[string]any{"name": t.Name, "parameters": len(t.Params), "inform_interval": body["inform_interval"]})
		})
		return endpoint.Result{Value: out}, err
	})
	registry.Handle(api, http.MethodPatch, "/api/acs/templates/{id}", "network:write", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		actor, err := acsTemplateActor(ctx, true)
		if err != nil {
			return endpoint.Result{}, err
		}
		id := chi.URLParam(r, "id")
		if validate.UUID(id) != nil {
			return endpoint.Result{}, acsTemplateBad("identificador inválido")
		}
		body, err := acsTemplateBody(r, true)
		if err != nil {
			return endpoint.Result{}, err
		}
		var out any
		err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
			old, e := loadACSTemplate(ctx, tx, id, true)
			if e != nil {
				return e
			}
			name, _ := body["name"].(string)
			if name == "" {
				name = old.Name
			} else if e = acsTemplateNameTaken(ctx, tx, name, id); e != nil {
				return e
			}
			pick := func(key, current string) string {
				if v, ok := body[key].(string); ok {
					return v
				}
				return current
			}
			params := old.Params
			if v, ok := body["parameters"].([]acs.TemplateParam); ok {
				params = v
			}
			var inform any
			if old.Inform != nil {
				inform = *old.Inform
			}
			if v, ok := body["inform_interval"]; ok {
				inform = v
			}
			active := old.Active
			if v, ok := body["active"].(bool); ok {
				active = v
			}
			if len(params) == 0 && inform == nil {
				return acsTemplateBad("informe ao menos um parâmetro ou o intervalo de inform periódico")
			}
			encoded, _ := json.Marshal(params)
			if e = tx.Exec(ctx, `update acs_templates set name=$2,manufacturer=$3,model=$4,firmware=$5,parameters=$6::jsonb,inform_interval=$7,active=$8,revision=revision+1,updated_at=now() where id=$1`, id, name, pick("manufacturer", old.Manufacturer), pick("model", old.Model), pick("firmware", old.Firmware), string(encoded), inform, active); e != nil {
				return e
			}
			t, e := loadACSTemplate(ctx, tx, id, false)
			if e != nil {
				return e
			}
			out = t.view()
			fields := make([]string, 0, len(body))
			for k := range body {
				fields = append(fields, k)
			}
			sort.Strings(fields)
			return record(ctx, tx, "acs.template_updated", "acs_template", id, map[string]any{"name": t.Name, "revision": t.Revision, "fields": fields, "active": t.Active})
		})
		return endpoint.Result{Value: out}, err
	})
	registry.Handle(api, http.MethodDelete, "/api/acs/templates/{id}", "network:write", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		actor, err := acsTemplateActor(ctx, true)
		if err != nil {
			return endpoint.Result{}, err
		}
		id := chi.URLParam(r, "id")
		if validate.UUID(id) != nil {
			return endpoint.Result{}, acsTemplateBad("identificador inválido")
		}
		err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
			old, e := loadACSTemplate(ctx, tx, id, true)
			if e != nil {
				return e
			}
			if e = tx.Exec(ctx, `delete from acs_templates where id=$1`, id); e != nil {
				return e
			}
			// Intenções já preparadas guardam a própria cópia cifrada do comando.
			return record(ctx, tx, "acs.template_deleted", "acs_template", id, map[string]any{"name": old.Name, "revision": old.Revision})
		})
		return endpoint.Result{Value: map[string]any{"deleted": err == nil}}, err
	})
	registry.Get(api, "/api/contracts/{id}/cpe/templates", "network:read", false, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		actor, err := acsTemplateActor(ctx, false)
		if err != nil {
			return endpoint.Result{}, err
		}
		contract := chi.URLParam(r, "id")
		if validate.UUID(contract) != nil {
			return endpoint.Result{}, apierr.New(400, "contrato inválido")
		}
		var info *templateContext
		var templates []acsTemplate
		err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
			var e error
			if info, e = loadTemplateContext(ctx, tx, contract, nil, nil); e != nil {
				return e
			}
			rows, e := tx.Objects(ctx, `select `+acsTemplateCols+` from acs_templates where active order by lower(name),id`)
			if e != nil {
				return e
			}
			templates, e = scanACSTemplates(rows)
			return e
		})
		if err != nil {
			return endpoint.Result{}, err
		}
		out := map[string]any{"linked": info.linked != "", "device": nil, "suggested_id": nil, "templates": []map[string]any{}}
		if info.linked == "" {
			return endpoint.Result{Value: out}, nil
		}
		device, err := acs.GetOwned(ctx, actor.TenantID, info.linked, "")
		if err != nil {
			return endpoint.Result{}, err
		}
		if device == nil {
			out["missing"] = true
			return endpoint.Result{Value: out}, nil
		}
		out["device"] = deviceView(device)
		matching := []acsTemplate{}
		for _, t := range templates {
			if matches, compatible := templateFits(&t, device); matches && compatible {
				matching = append(matching, t)
			}
		}
		sort.SliceStable(matching, func(i, j int) bool {
			return acs.PatternSpecificity(matching[i].Manufacturer, matching[i].Model, matching[i].Firmware) > acs.PatternSpecificity(matching[j].Manufacturer, matching[j].Model, matching[j].Firmware)
		})
		views := make([]map[string]any, 0, len(matching))
		for _, t := range matching {
			views = append(views, t.view())
		}
		out["templates"] = views
		if len(matching) > 0 {
			out["suggested_id"] = matching[0].ID
		}
		return endpoint.Result{Value: out}, nil
	})
	for _, apply := range []bool{false, true} {
		path := "/api/contracts/{id}/cpe/template/preview"
		if apply {
			path = "/api/contracts/{id}/cpe/template"
		}
		registry.Handle(api, http.MethodPost, path, "network:operate", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			actor, err := acsTemplateActor(ctx, false)
			if err != nil {
				return endpoint.Result{}, err
			}
			contract := chi.URLParam(r, "id")
			if validate.UUID(contract) != nil {
				return endpoint.Result{}, apierr.New(400, "contrato inválido")
			}
			var raw map[string]json.RawMessage
			if err = apierr.DecodeJSON(r, &raw); err != nil {
				return endpoint.Result{}, err
			}
			for k := range raw {
				if k != "template_id" && k != "wifi_ssid" && k != "wifi_senha" && !(apply && k == "intent_id") {
					return endpoint.Result{}, acsTemplateBad("campo desconhecido: " + k)
				}
			}
			var templateID, intent string
			if json.Unmarshal(raw["template_id"], &templateID) != nil || validate.UUID(templateID) != nil {
				return endpoint.Result{}, acsTemplateBad("selecione o template")
			}
			templateID = uuid.MustParse(templateID).String()
			if apply {
				if json.Unmarshal(raw["intent_id"], &intent) != nil || validate.UUID(intent) != nil {
					return endpoint.Result{}, apierr.New(400, "intenção ACS inválida")
				}
			}
			wifi, err := templateWifiBody(raw)
			if err != nil {
				return endpoint.Result{}, err
			}
			request := acs.TaskRequest{IntentID: intent, Kind: "template", TemplateID: templateID}
			if v, ok := wifi["wifi_ssid"]; ok {
				request.SSID = &v
			}
			if v, ok := wifi["wifi_senha"]; ok {
				request.Password = &v
			}
			var t *acsTemplate
			var info *templateContext
			var replay jsonx.Object
			err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
				var e error
				if apply {
					// Uma repetição responde pelo diário, sem recalcular valores.
					existing, prior, e := acs.ExistingTask(ctx, tx, contract, intent)
					if e != nil {
						return e
					}
					if existing != nil {
						if prior.Kind != "template" || prior.TemplateID != templateID || !samePtr(prior.SSID, request.SSID) || !samePtr(prior.Password, request.Password) {
							return apierr.New(409, "intenção já usada com dados/vínculo diferentes")
						}
						replay = existing
						return nil
					}
				}
				if t, e = loadACSTemplate(ctx, tx, templateID, false); e != nil {
					return e
				}
				info, e = loadTemplateContext(ctx, tx, contract, t, wifi)
				return e
			})
			if err != nil {
				return endpoint.Result{}, err
			}
			if replay != nil {
				return endpoint.Result{Value: map[string]any{"result": replay.Get("state"), "task_id": replay.Get("id"), "replayed": true, "note": "intenção já registrada; nenhuma nova tarefa foi criada"}}, nil
			}
			if apply && !t.Active {
				return endpoint.Result{}, apierr.New(409, "template ACS inativo")
			}
			var device map[string]any
			deviceError := ""
			if info.linked != "" {
				device, err = acs.GetOwned(ctx, actor.TenantID, info.linked, "")
				if err != nil {
					if apply {
						return endpoint.Result{}, err
					}
					deviceError = apierr.Map(err).Message
					device = nil
				}
			}
			if apply && info.linked == "" {
				return endpoint.Result{}, apierr.New(404, "nenhum roteador vinculado a este contrato")
			}
			if apply && device == nil {
				return endpoint.Result{}, apierr.New(404, "CPE sem propriedade confirmada neste provedor")
			}
			root := acs.TemplateRoot(t.Params)
			var matches, compatible any
			if device != nil {
				m, c := templateFits(t, device)
				matches, compatible = m, c
				if apply && !m {
					return endpoint.Result{}, apierr.New(409, "o template não corresponde ao fabricante, modelo ou firmware deste roteador")
				}
				if apply && !c {
					return endpoint.Result{}, apierr.New(409, "o template usa outro modelo de dados TR-069 que o deste roteador")
				}
				root = acs.DeviceRoot(device)
			}
			informRoot := root
			if informRoot == "" {
				informRoot = "(raiz TR-069)"
			}
			resolved, missing, err := acs.ResolveTemplate(t.Params, t.Inform, informRoot, info.vars)
			if err != nil {
				return endpoint.Result{}, err
			}
			if !apply {
				variables := make([]map[string]any, 0, len(acs.TemplateVariables))
				for _, name := range acs.TemplateVariables {
					value, ok := info.vars[name]
					var shown any
					if ok {
						shown = value
						if name == "pppoe_senha" || name == "wifi_senha" {
							shown = acs.MaskedValue
						}
					}
					variables = append(variables, map[string]any{"name": name, "label": variableLabels[name], "used": templateUses(t, name), "available": ok, "value": shown})
				}
				return endpoint.Result{Value: map[string]any{"template": map[string]any{"id": t.ID, "name": t.Name, "revision": t.Revision, "active": t.Active}, "linked": info.linked != "", "device": deviceView(device), "device_error": nullable(deviceError), "matches": matches, "compatible": compatible, "data_model": dataModel(root), "parameters": acs.MaskedTemplate(resolved), "variables": variables, "missing": missing, "ready": len(missing) == 0 && device != nil && matches == true && compatible == true && t.Active}}, nil
			}
			if len(missing) > 0 {
				return endpoint.Result{}, apierr.New(400, missingMessage(missing))
			}
			request.TemplateRevision = t.Revision
			payload := acs.TemplatePayload(resolved)
			var task jsonx.Object
			err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
				var current struct {
					revision int
					active   bool
				}
				if e := tx.QueryRow(ctx, `select revision,active from acs_templates where id=$1 for share`, templateID).Scan(&current.revision, &current.active); e != nil {
					return apierr.New(404, "template ACS não encontrado")
				}
				if current.revision != t.Revision || !current.active {
					return apierr.New(409, "o template foi alterado; revise a pré-visualização e aplique novamente")
				}
				var created bool
				var e error
				task, created, e = acs.PrepareTask(ctx, tx, actor.TenantID, contract, actor.UserID, info.linked, request, payload, acs.Summary(device))
				if e != nil || !created {
					return e
				}
				if os.Getenv("NEXO_GO_JOBS") == "1" && os.Getenv("NEXO_GO_JOB_ACS_TASKS") == "1" {
					if e := tx.EnqueuePeriodic(ctx, "ACS_TASKS", actor.TenantID); e != nil {
						return e
					}
				}
				return record(ctx, tx, "cpe.template.prepared", "contract", contract, map[string]any{"template_id": t.ID, "template_name": t.Name, "template_revision": t.Revision, "parameters": len(resolved), "task_intent_id": task.Get("id"), "wifi_password_changed": request.Password != nil, "applied": false})
			})
			if err != nil {
				return endpoint.Result{}, err
			}
			return endpoint.Result{Value: map[string]any{"result": task.Get("state"), "task_id": task.Get("id"), "note": "intenção registrada; aceite ACS e aplicação no CPE serão consultados separadamente"}}, nil
		})
	}
}

func samePtr(a, b *string) bool {
	return (a == nil) == (b == nil) && (a == nil || *a == *b)
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

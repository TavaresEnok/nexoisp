package escrita

import (
	"context"
	"nexoisp/api-go/internal/acs"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/audit"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
	"nexoisp/api-go/internal/validate"
	"slices"
	"strings"
)

func (s Service) cpeOperations(ops map[string]operation) {
	f, o, str := validate.F, validate.Object, validate.String
	for _, key := range []string{"GET /api/contracts/:id/cpe", "GET /api/contracts/:id/cpe/candidates", "DELETE /api/contracts/:id/cpe/link", "POST /api/contracts/:id/cpe/reboot", "POST /api/contracts/:id/cpe/refresh", "GET /api/portal/cpe"} {
		ops[key] = operation{nil, nil}
	}
	ops["POST /api/contracts/:id/cpe/link"] = operation{nil, obj(o(f("acs_device_id", str().Trimmed().Min(3).Max(200).Pattern(`^[A-Za-z0-9%._-]+$`, "identificador de roteador inválido")), f("serial", text(64).Opt())))}
	wifi := o(f("index", str().Pattern(`^\d{1,2}$`, "")), f("ssid", str().Trimmed().Min(1).Max(32).Pattern(`^[\x20-\x7E]+$`, "nome da rede: até 32 caracteres comuns (sem acento)").Opt()), f("password", str().Min(8, "senha do Wi-Fi: de 8 a 63 caracteres").Max(63).Pattern(`^[\x20-\x7E]+$`, "senha do Wi-Fi: caracteres comuns (sem acento)").Opt()))
	ops["POST /api/contracts/:id/cpe/wifi"] = operation{nil, obj(wifi)}
	ops["POST /api/portal/cpe/:contractId/wifi"] = operation{nil, obj(wifi)}
}
func acsOutcome(result string) map[string]any {
	note := "o roteador não atendeu agora: a mudança fica na fila e vale quando ele contatar o servidor"
	if result == "applied" {
		note = "aplicado no roteador agora"
	}
	return map[string]any{"result": result, "note": note}
}
func (s Service) cpe(ctx context.Context, key, id string, b map[string]any) (any, error) {
	c := auth.From(ctx)
	if strings.HasSuffix(key, "/wifi") && b["ssid"] == nil && b["password"] == nil {
		return nil, apierr.New(400, "dados: informe o nome da rede, a senha ou os dois")
	}
	scoped := func(fn func(*db.Tx) error) error { return s.DB.WithScope(ctx, c.Scope, fn) }
	linkOf := func(contract string) (jsonx.Object, error) {
		var link jsonx.Object
		err := scoped(func(tx *db.Tx) error {
			var err error
			link, err = one(ctx, tx, "helper:linkOf", 0, contract)
			return err
		})
		return link, err
	}
	if key == "GET /api/contracts/:id/cpe" {
		var link jsonx.Object
		err := scoped(func(tx *db.Tx) error {
			if _, err := mustRow(ctx, tx, key, 0, "contrato não encontrado", id); err != nil {
				return err
			}
			var err error
			link, err = one(ctx, tx, "helper:linkOf", 0, id)
			return err
		})
		if err != nil {
			return nil, err
		}
		if link == nil {
			return map[string]any{"enabled": acs.Configured(), "linked": false}, nil
		}
		device, err := acs.Get(ctx, link.Get("acs_device_id").(string), "")
		if err != nil {
			return nil, err
		}
		var summary any
		if device != nil {
			summary = acs.Summary(device)
		}
		return map[string]any{"enabled": true, "linked": true, "linked_at": link.Get("linked_at"), "device": summary, "missing": device == nil}, nil
	}
	if key == "GET /api/contracts/:id/cpe/candidates" {
		q := validate.Query{Values: httpx.Request(ctx).URL.Query()}
		serial := q.Text("serial", false, true, 3, 64)
		if err := q.Err(); err != nil {
			return nil, err
		}
		var users []jsonx.Object
		err := scoped(func(tx *db.Tx) error {
			if _, err := mustRow(ctx, tx, key, 0, "contrato não encontrado", id); err != nil {
				return err
			}
			var err error
			users, err = rows(ctx, tx, key, 1, id)
			return err
		})
		if err != nil {
			return nil, err
		}
		or := []any{}
		if serial != "" {
			or = append(or, map[string]any{"_deviceId._SerialNumber": serial})
		}
		for _, user := range users {
			or = append(or, map[string]any{"InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username": user.Get("pppoe_username")}, map[string]any{"Device.PPP.Interface.1.Username": user.Get("pppoe_username")})
		}
		out := []map[string]any{}
		if len(or) == 0 {
			return out, nil
		}
		devices, err := acs.Find(ctx, map[string]any{"$or": or}, "_id,_lastInform,_deviceId,InternetGatewayDevice.WANDevice,Device.PPP")
		if err != nil {
			return nil, err
		}
		for _, device := range devices[:min(len(devices), 20)] {
			var taken jsonx.Object
			err = scoped(func(tx *db.Tx) error { var err error; taken, err = one(ctx, tx, key, 2, device["_id"]); return err })
			if err != nil {
				return nil, err
			}
			if taken.Get("t") == true {
				continue
			}
			matched := "pppoe"
			if serial != "" && acs.At(device, "_deviceId._SerialNumber") == serial {
				matched = "serial"
			}
			entry := map[string]any{"id": device["_id"], "matched_by": matched}
			for field, path := range map[string]string{"manufacturer": "_deviceId._Manufacturer", "product": "_deviceId._ProductClass", "serial": "_deviceId._SerialNumber", "last_inform": "_lastInform"} {
				if value := acs.At(device, path); value != nil {
					entry[field] = value
				}
			}
			out = append(out, entry)
		}
		return out, nil
	}
	if key == "POST /api/contracts/:id/cpe/link" {
		device, err := acs.Get(ctx, b["acs_device_id"].(string), "_id,_deviceId,InternetGatewayDevice.WANDevice,Device.PPP")
		if err != nil {
			return nil, err
		}
		if device == nil {
			return nil, apierr.New(404, "roteador não encontrado no servidor de gerência")
		}
		summary := acs.Summary(device)
		err = scoped(func(tx *db.Tx) error {
			users, err := rows(ctx, tx, key, 0, id)
			if err != nil {
				return err
			}
			matched := false
			for _, user := range users {
				if slices.Contains(acs.PPPUsers(device), user.Get("pppoe_username").(string)) {
					matched = true
				}
			}
			if !matched && !(jsonx.Truthy(b["serial"]) && b["serial"] == summary["serial"]) {
				return apierr.New(400, "este roteador não informa a conta deste contrato: confirme digitando o número de série da etiqueta")
			}
			taken, err := one(ctx, tx, key, 1, b["acs_device_id"])
			if err != nil {
				return err
			}
			if taken.Get("t") == true {
				return apierr.New(409, "este roteador já está vinculado a um contrato")
			}
			if err = tx.Exec(ctx, query(key, 2), id); err != nil {
				return err
			}
			if err = tx.Exec(ctx, query(key, 3), c.TenantID, id, b["acs_device_id"], summary["serial"], c.UserID); err != nil {
				return err
			}
			return record(ctx, tx, "cpe.link", "contract", id, map[string]any{"acs_device_id": b["acs_device_id"], "serial": summary["serial"]})
		})
		if err != nil {
			return nil, err
		}
		go func() {
			object := "InternetGatewayDevice"
			if summary["model"] == "tr181" {
				object = "Device"
			}
			_, _ = acs.Task(context.Background(), b["acs_device_id"].(string), map[string]any{"name": "refreshObject", "objectName": object})
		}()
		return map[string]any{"linked": true, "device": summary}, nil
	}
	if key == "DELETE /api/contracts/:id/cpe/link" {
		err := scoped(func(tx *db.Tx) error {
			row, err := mustRow(ctx, tx, key, 0, "nenhum roteador vinculado", id)
			if err != nil {
				return err
			}
			return record(ctx, tx, "cpe.unlink", "contract", id, map[string]any{"acs_device_id": row.Get("acs_device_id")})
		})
		return map[string]any{"linked": false}, err
	}
	if key == "GET /api/portal/cpe" {
		var links []jsonx.Object
		err := scoped(func(tx *db.Tx) error {
			var err error
			links, err = rows(ctx, tx, key, 0, c.SubscriberID, "active")
			return err
		})
		if err != nil {
			return nil, err
		}
		out := []map[string]any{}
		for _, link := range links {
			device, err := acs.Get(ctx, link.Get("acs_device_id").(string), "")
			if err != nil || device == nil {
				continue
			}
			entry := map[string]any{"contract_id": link.Get("contract_id"), "wifi": acs.Summary(device)["wifi"]}
			if value, ok := device["_lastInform"]; ok {
				entry["last_inform"] = value
			}
			out = append(out, entry)
		}
		return out, nil
	}
	var dev string
	portal := strings.Contains(key, "/portal/")
	if portal {
		id = parameter(ctx, "contractId")
		var own jsonx.Object
		err := scoped(func(tx *db.Tx) error { var err error; own, err = one(ctx, tx, key, 0, id, c.SubscriberID); return err })
		if err != nil {
			return nil, err
		}
		if own == nil {
			return nil, apierr.New(404, "roteador não encontrado")
		}
		dev = own.Get("acs_device_id").(string)
	} else {
		link, err := linkOf(id)
		if err != nil {
			return nil, err
		}
		if link == nil {
			return nil, apierr.New(404, "nenhum roteador vinculado a este contrato")
		}
		dev = link.Get("acs_device_id").(string)
	}
	var payload any
	detail := map[string]any{}
	action := "cpe.wifi"
	if strings.HasSuffix(key, "/wifi") {
		if b["ssid"] == nil && b["password"] == nil {
			return nil, apierr.New(400, "dados: informe o nome da rede, a senha ou os dois")
		}
		device, err := acs.Get(ctx, dev, "")
		if err != nil {
			return nil, err
		}
		if device == nil {
			return nil, apierr.New(404, "roteador não encontrado no servidor de gerência")
		}
		parameters, err := acs.WiFiParams(device, b["index"].(string), b["ssid"], b["password"])
		if err != nil {
			return nil, err
		}
		payload = map[string]any{"name": "setParameterValues", "parameterValues": parameters}
		detail = map[string]any{"index": b["index"], "ssid": b["ssid"], "password_changed": b["password"] != nil}
		if portal {
			detail["source"] = "portal"
		}
	} else if strings.HasSuffix(key, "/reboot") {
		payload = map[string]any{"name": "reboot"}
		action = "cpe.reboot"
	} else {
		device, err := acs.Get(ctx, dev, "_id,InternetGatewayDevice.DeviceInfo,Device.DeviceInfo")
		if err != nil {
			return nil, err
		}
		object := "InternetGatewayDevice"
		if acs.Model(device) == "tr181" {
			object = "Device"
		}
		payload = map[string]any{"name": "refreshObject", "objectName": object}
		action = "cpe.refresh"
	}
	result, err := acs.Task(ctx, dev, payload)
	if err != nil {
		return nil, err
	}
	detail["result"] = result
	if portal {
		err = s.DB.WithScope(ctx, tenancy.Scope{TenantID: c.TenantID}, func(tx *db.Tx) error { return record(ctx, tx, action, "contract", id, detail) })
	} else {
		err = (audit.Writer{DB: s.DB}).Write(ctx, c, action, "contract", id, detail, "ok")
	}
	return acsOutcome(result), err
}

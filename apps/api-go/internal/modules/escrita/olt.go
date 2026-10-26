package escrita

import (
	"context"
	"encoding/hex"
	"net/url"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/network"
	"nexoisp/api-go/internal/validate"
	"regexp"
	"strings"
)

func (s Service) oltOperations(ops map[string]operation) {
	f, o, str := validate.F, validate.Object, validate.String
	ops["GET /api/contracts/:id/onu"] = operation{s.contractONU, nil}
	ops["POST /api/contracts/:id/onu"] = operation{s.createONU, obj(o(f("device_id", str().UUID()), f("serial", str().Trimmed().Pattern(`^[A-Za-z0-9]{8,20}$`, "serial: 8 a 20 letras/números").Upper()), f("pon_port", str().Trimmed().Pattern(`^[0-9]{1,3}(/[0-9]{1,3}){0,3}$`, "porta PON no formato 0/1/3")), f("line_profile", str().Trimmed().Pattern(`^[A-Za-z0-9_.-]{1,60}$`, "perfil de linha: letras, números, _ . -")), f("service_vlan", validate.Number().Int().Min(1).Max(4094)), f("service_profile", str().Trimmed().Pattern(`^[A-Za-z0-9_.-]{1,60}$`, "perfil de serviço: letras, números, _ . -").Nullish().OrEmpty().Then(nilEmpty, true))))}
	ops["POST /api/onus/:id/:action"] = operation{s.onuAction, obj(o(f("reason", text(200).Opt())))}
}
func (s Service) contractONU(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	const key = "GET /api/contracts/:id/onu"
	if err := network.Sweep(ctx, tx); err != nil {
		return nil, err
	}
	onu, err := one(ctx, tx, key, 0, id)
	if err != nil {
		return nil, err
	}
	if onu == nil {
		return map[string]any{"onu": nil, "operations": []any{}}, nil
	}
	ops, err := rows(ctx, tx, key, 1, onu.Get("id"))
	return map[string]any{"onu": onu, "operations": ops}, err
}
func (s Service) createONU(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/contracts/:id/onu"
	contract, err := mustRow(ctx, tx, key, 0, "contrato não encontrado", id)
	if err != nil {
		return nil, err
	}
	if contract.Get("status") != "active" {
		return nil, apierr.New(400, "contrato encerrado")
	}
	dev, err := one(ctx, tx, key, 1, b["device_id"])
	if err != nil {
		return nil, err
	}
	if dev == nil || !strings.HasPrefix(jsonx.String(dev.Get("driver")), "olt") {
		return nil, apierr.New(400, "o equipamento escolhido não é uma OLT")
	}
	if dev.Get("driver") == "olt_huawei" {
		if b["service_profile"] == nil {
			return nil, apierr.New(400, "OLT Huawei exige o perfil de serviço (ont-srvprofile) da ONU")
		}
		serial := b["serial"].(string)
		if regexp.MustCompile(`^[A-Z]{4}[0-9A-F]{8}$`).MatchString(serial) {
			serial = strings.ToUpper(hex.EncodeToString([]byte(serial[:4]))) + serial[4:]
		}
		b["serial"] = serial
		if !regexp.MustCompile(`^[0-9A-F]{16}$`).MatchString(serial) {
			return nil, apierr.New(400, "serial Huawei: 16 dígitos hexadecimais ou 4 letras do fabricante + 8 hexadecimais")
		}
		if !regexp.MustCompile(`^\d+/\d+/\d+$`).MatchString(b["pon_port"].(string)) {
			return nil, apierr.New(400, "porta PON Huawei no formato frame/slot/porta, ex.: 0/1/3")
		}
	}
	prev, err := one(ctx, tx, key, 2, id)
	if err != nil {
		return nil, err
	}
	if prev != nil && !(prev.Get("desired_state") == "removed" && prev.Get("observed_state") == "absent" && prev.Get("observed_version") == prev.Get("desired_version")) {
		return nil, apierr.New(409, "o contrato já tem uma ONU; desautorize-a e aguarde a confirmação da OLT antes de vincular outra")
	}
	c := auth.From(ctx)
	var onu jsonx.Object
	if prev != nil {
		onu, err = one(ctx, tx, key, 3, prev.Get("id"), b["device_id"], b["serial"], b["pon_port"], b["line_profile"], b["service_vlan"], b["service_profile"])
	} else {
		onu, err = one(ctx, tx, key, 4, c.TenantID, id, b["device_id"], b["serial"], b["pon_port"], b["line_profile"], b["service_vlan"], b["service_profile"])
	}
	if err != nil {
		return nil, err
	}
	if ctx.Value(importOnlyKey{}) == true {
		return onu, record(ctx, tx, "onu.import", "onu", onu.Get("id"), map[string]any{"provisioned": false})
	}
	reason := "autorização inicial"
	if prev != nil {
		if err = record(ctx, tx, "onu.replace", "onu", onu.Get("id"), map[string]any{"previous_serial": prev.Get("serial"), "serial": b["serial"]}); err != nil {
			return nil, err
		}
		reason = "troca de ONU (anterior: " + jsonx.String(prev.Get("serial")) + ")"
	}
	op, err := network.RequestONU(ctx, tx, c.TenantID, onu.Get("id").(string), "onu.authorize", network.Authz{Type: "user", ID: c.UserID, Reason: reason})
	if err != nil {
		return nil, err
	}
	return map[string]any{"onu_id": onu.Get("id"), "operation_id": op.Get("id")}, record(ctx, tx, "onu.authorize", "onu", onu.Get("id"), map[string]any{"operation_id": op.Get("id"), "serial": b["serial"], "pon_port": b["pon_port"]})
}
func (s Service) onuAction(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	action := parameter(ctx, "action")
	q := validate.Query{Values: url.Values{"action": []string{action}}}
	q.Enum("action", "", "authorize", "deauthorize")
	if err := q.Err(); err != nil {
		return nil, err
	}
	reason := "desautorização manual"
	if action == "authorize" {
		reason = "reaplicar autorização"
	}
	if jsonx.Truthy(b["reason"]) {
		reason = b["reason"].(string)
	}
	c := auth.From(ctx)
	op, err := network.RequestONU(ctx, tx, c.TenantID, id, "onu."+action, network.Authz{Type: "user", ID: c.UserID, Reason: reason})
	if err != nil {
		return nil, err
	}
	detail := map[string]any{"operation_id": op.Get("id")}
	if has(b, "reason") {
		detail["reason"] = b["reason"]
	}
	return map[string]any{"operation_id": op.Get("id"), "status": op.Get("status"), "desired_version": op.Get("desired_version")}, record(ctx, tx, "onu."+action, "onu", id, detail)
}

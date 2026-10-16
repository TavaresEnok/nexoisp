package escrita

import (
	"context"
	"fmt"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/network"
	"nexoisp/api-go/internal/validate"
	"strings"
)

func (s Service) contractOperations(ops map[string]operation) {
	f, o, str, n := validate.F, validate.Object, validate.String, validate.Number
	ops["PATCH /api/contracts/:id"] = operation{s.contractChange, obj(o(f("plan_id", str().UUID().Opt()), f("due_day", n().Int().Min(1).Max(28).Opt()), f("notes", text(2000).Nullish()), f("end", validate.Boolean().Opt()), f("end_reason_id", str().UUID().Nullish()), f("end_note", text(300).Nullish()), f("penalty", validate.Enum("charge", "waive").Opt()), f("penalty_waive_reason", text(200).Min(5).Opt()), f("penalty_due_days", n().Int().Min(0).Max(60).Def(float64(10)))))}
}
func (s Service) contractChange(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	if (jsonx.Truthy(b["end_reason_id"]) || jsonx.Truthy(b["end_note"]) || jsonx.Truthy(b["penalty"])) && b["end"] != true {
		return nil, apierr.New(400, "motivo e multa só valem junto com o encerramento")
	}
	if err := changeContract(ctx, tx, id, b, "contract"); err != nil {
		return nil, err
	}
	return one(ctx, tx, "PATCH /api/contracts/:id", 0, id)
}
func changeContract(ctx context.Context, tx *db.Tx, id string, b map[string]any, via string) error {
	const key = "helper:changeContract"
	c := auth.From(ctx)
	cur, err := mustRow(ctx, tx, key, 0, "contrato não encontrado", id)
	if err != nil {
		return err
	}
	if cur.Get("status") == "ended" {
		return apierr.New(400, "contrato encerrado não pode ser alterado")
	}
	hist := func(event string, detail any) error {
		encoded, e := jsonx.Encode(detail)
		if e != nil {
			return e
		}
		return tx.Exec(ctx, query(key, 1), c.TenantID, id, nullableUser(c), event, encoded)
	}
	if b["plan_id"] != nil {
		v, e := currentVersion(ctx, tx, b["plan_id"].(string))
		if e != nil {
			return e
		}
		if v.Get("id") != cur.Get("plan_version_id") {
			if e = tx.Exec(ctx, query(key, 2), id, v.Get("id")); e != nil {
				return e
			}
			if e = hist("plan_changed", map[string]any{"from": fmt.Sprintf("%v v%v", cur.Get("plan_name"), cur.Get("plan_version")), "to": fmt.Sprintf("%v v%v", v.Get("name"), v.Get("version"))}); e != nil {
				return e
			}
		}
	}
	if b["due_day"] != nil && num(b["due_day"]) != num(cur.Get("due_day")) {
		if err = tx.Exec(ctx, query(key, 3), id, b["due_day"]); err != nil {
			return err
		}
		if err = hist("due_day_changed", map[string]any{"from": cur.Get("due_day"), "to": b["due_day"]}); err != nil {
			return err
		}
	}
	if has(b, "notes") {
		if err = tx.Exec(ctx, query(key, 4), id, nilEmpty(b["notes"])); err != nil {
			return err
		}
	}
	if b["end"] == true {
		if err = assertCatalog(ctx, tx, b["end_reason_id"], "end_reason", "motivo de encerramento"); err != nil {
			return err
		}
		today, err := one(ctx, tx, "helper:localToday", 0, 0)
		if err != nil {
			return err
		}
		q, err := mustRow(ctx, tx, "helper:terminationQuote", 0, "contrato não encontrado", id, today.Get("d"))
		if err != nil {
			return err
		}
		penalty := float64(0)
		if q.Get("within_loyalty") == true && q.Get("penalty_cents") != nil {
			penalty = num(q.Get("penalty_cents"))
			if q.Get("penalty_model") == "monthly" {
				penalty *= num(q.Get("remaining_months"))
			}
		}
		if penalty > 0 {
			until := fmt.Sprint(q.Get("loyalty_until"))
			if len(until) > 10 {
				until = until[:10]
			}
			if b["penalty"] == nil {
				return &apierr.Error{Status: 409, Message: fmt.Sprintf("contrato em fidelidade até %s: escolha cobrar ou dispensar a multa de %s", until, strings.ReplaceAll(fmt.Sprintf("%.2f", penalty/100), ".", ",")), Code: "penalty_decision_required"}
			}
			if b["penalty"] == "waive" {
				if !jsonx.Truthy(b["penalty_waive_reason"]) {
					return apierr.New(400, "informe o motivo para dispensar a multa")
				}
				if err = hist("penalty_waived", map[string]any{"amount_cents": penalty, "reason": b["penalty_waive_reason"]}); err != nil {
					return err
				}
			} else {
				due, e := one(ctx, tx, "helper:localToday", 0, b["penalty_due_days"])
				if e != nil {
					return e
				}
				inv, e := one(ctx, tx, key, 5, c.TenantID, id, cur.Get("subscriber_id"), due.Get("d"), penalty)
				if e != nil {
					return e
				}
				parts := strings.Split(until, "-")
				if len(parts) == 3 {
					parts[0], parts[2] = parts[2], parts[0]
				}
				if e = tx.Exec(ctx, query(key, 6), c.TenantID, inv.Get("id"), "Multa rescisória — fidelidade até "+strings.Join(parts, "/"), penalty); e != nil {
					return e
				}
				if e = hist("penalty_charged", map[string]any{"amount_cents": penalty, "invoice_id": inv.Get("id")}); e != nil {
					return e
				}
				if _, e = finance.Charges(ctx, tx, c.TenantID); e != nil {
					return e
				}
			}
		}
		if err = tx.Exec(ctx, query(key, 7), id, b["end_reason_id"], nilEmpty(b["end_note"])); err != nil {
			return err
		}
		if err = hist("ended", map[string]any{"reason_id": b["end_reason_id"], "note": b["end_note"]}); err != nil {
			return err
		}
	}
	detail := map[string]any{"via": via}
	for k, v := range b {
		detail[k] = v
	}
	action := "contract.update"
	if b["end"] == true {
		action = "contract.end"
	}
	if c.UserID != "" {
		err = record(ctx, tx, action, "contract", id, detail)
	} else {
		encoded, e := jsonx.Encode(detail)
		if e != nil {
			return e
		}
		err = tx.Exec(ctx, `insert into audit_events (tenant_id,actor_type,actor_id,action,entity_type,entity_id,result,detail) values ($1,'system',$2,$3,'contract',$4,'ok',$5)`, c.TenantID, via, action, id, encoded)
	}
	if err != nil {
		return err
	}
	rs, err := tx.Objects(ctx, `select r.id,r.desired_policy,r.desired_profile,k.status,pv.profile_name from service_resources r join contracts k on k.id=r.contract_id join plan_versions pv on pv.id=k.plan_version_id where r.contract_id=$1`, id)
	if err != nil {
		return err
	}
	actor := network.Authz{Type: "user", ID: c.UserID}
	if c.UserID == "" {
		actor.Type, actor.ID = "system", "mudanca-agendada"
	}
	if len(rs) > 0 {
		r := rs[0]
		op := ""
		if r.Get("status") == "ended" && r.Get("desired_policy") != "suspended" {
			op = "subscriber.suspend"
			actor.Reason = "contrato encerrado"
		} else if r.Get("status") == "active" && r.Get("profile_name") != r.Get("desired_profile") {
			if r.Get("desired_policy") == "active" {
				op = "subscriber.provision"
				actor.Reason = "troca de plano"
			} else {
				if err = tx.Exec(ctx, "update service_resources set desired_profile=$2 where id=$1", r.Get("id"), r.Get("profile_name")); err != nil {
					return err
				}
			}
		}
		if op != "" {
			if _, err = network.Request(ctx, tx, c.TenantID, r.Get("id").(string), op, actor, "", ""); err != nil {
				return err
			}
		}
	}
	onus, err := tx.Objects(ctx, `select n.id,d.agent_id from onus n join contracts k on k.id=n.contract_id join devices d on d.id=n.device_id join tenant_settings ts on ts.tenant_id=n.tenant_id where n.contract_id=$1 and k.status='ended' and n.desired_state='authorized' and n.desired_version>0 and ts.onu_remove_on_contract_end`, id)
	if err != nil {
		return err
	}
	if len(onus) > 0 && onus[0].Get("agent_id") != nil {
		actor.Reason = "contrato encerrado"
		_, err = network.RequestONU(ctx, tx, c.TenantID, onus[0].Get("id").(string), "onu.deauthorize", actor)
	}
	return err
}

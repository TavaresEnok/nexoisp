package acs

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"time"

	"github.com/google/uuid"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
)

type TaskRequest struct {
	IntentID string  `json:"intent_id"`
	Kind     string  `json:"kind"`
	Index    string  `json:"index,omitempty"`
	SSID     *string `json:"ssid,omitempty"`
	Password *string `json:"password,omitempty"`
}
type taskEnvelope struct {
	Tenant, Contract, Device, ID, ServerHash, Salt string
	Request                                        TaskRequest
	Payload                                        map[string]any
	Baseline                                       map[string]any
}

const taskColumns = `id,intent_id,kind,state,remote_task_id,attempts,last_error,created_at,updated_at`

func ServerFingerprint() string {
	return cryptox.SHA256(URL() + "\x00" + os.Getenv("NEXO_ACS_INSTANCE_ID"))
}

func readTaskEnvelope(ctx context.Context, tx *db.Tx, id string) (taskEnvelope, error) {
	var encoded string
	var out taskEnvelope
	if err := tx.QueryRow(ctx, `select acs_task_payload($1)`, id).Scan(&encoded); err != nil {
		return out, apierr.New(404, "intenção ACS não disponível")
	}
	plain, err := cryptox.DecryptSecret(encoded)
	if err != nil || json.Unmarshal([]byte(plain), &out) != nil || out.ID != id {
		return out, apierr.New(409, "envelope ACS indisponível ou divergente")
	}
	return out, nil
}

// Caller has checked ownership with the ACS and holds only a tenant/contract
// scope. The payload is encrypted and never appears in API/audit responses.
func PrepareTask(ctx context.Context, tx *db.Tx, tenant, contract, actor, device string, input TaskRequest, payload, baseline map[string]any) (jsonx.Object, bool, error) {
	if uuid.Validate(input.IntentID) != nil || (input.Kind != "wifi" && input.Kind != "reboot" && input.Kind != "refresh") {
		return nil, false, apierr.New(400, "intenção ACS inválida")
	}
	input.IntentID = uuid.MustParse(input.IntentID).String()
	if instance := os.Getenv("NEXO_ACS_INSTANCE_ID"); len(instance) < 3 || len(instance) > 128 {
		return nil, false, apierr.New(409, "defina identidade persistente da instância ACS antes de registrar tarefas")
	}
	if os.Getenv("NEXO_SECRET_KEY") == "" {
		return nil, false, apierr.New(409, "intenção durável exige chave de segredos persistente")
	}
	var linked string
	if err := tx.QueryRow(ctx, `select l.acs_device_id from contracts k join cpe_links l on l.contract_id=k.id and l.tenant_id=k.tenant_id where k.id=$1 and k.status='active' for update of k`, contract).Scan(&linked); err != nil {
		return nil, false, apierr.New(404, "contrato/CPE não disponível")
	}
	if linked != device {
		return nil, false, apierr.New(409, "vínculo CPE mudou")
	}
	rows, err := tx.Objects(ctx, `select `+taskColumns+`,request_hash,device_id,server_hash from acs_task_intents where contract_id=$1 and intent_id=$2`, contract, input.IntentID)
	if err != nil {
		return nil, false, err
	}
	raw, _ := json.Marshal(input)
	if len(rows) > 0 {
		id := jsonx.String(rows[0].Get("id"))
		old, e := readTaskEnvelope(ctx, tx, id)
		if e != nil {
			return nil, false, e
		}
		if old.Tenant != tenant || old.Contract != contract || old.Device != device || old.ServerHash != ServerFingerprint() || cryptox.SHA256(old.Salt+string(raw)) != rows[0].Get("request_hash") {
			return nil, false, apierr.New(409, "intenção já usada com dados/vínculo diferentes")
		}
		return rows[0], false, nil
	}
	var pending bool
	if err = tx.QueryRow(ctx, `select exists(select 1 from acs_task_intents where contract_id=$1 and state in ('prepared','uncertain','queued','review'))`, contract).Scan(&pending); err != nil {
		return nil, false, err
	}
	if pending {
		return nil, false, apierr.New(409, "CPE possui intenção pendente; consulte antes de nova mutação")
	}
	id := uuid.NewString()
	salt, err := cryptox.RandomToken(32)
	if err != nil {
		return nil, false, err
	}
	payload["uniqueKey"] = "nexo:" + id
	envelope := taskEnvelope{Tenant: tenant, Contract: contract, Device: device, ID: id, ServerHash: ServerFingerprint(), Salt: salt, Request: input, Payload: payload, Baseline: baseline}
	plain, _ := json.Marshal(envelope)
	cipher, err := cryptox.EncryptSecret(string(plain))
	if err != nil {
		return nil, false, err
	}
	rows, err = tx.Objects(ctx, `insert into acs_task_intents(id,tenant_id,contract_id,intent_id,device_id,server_hash,kind,request_hash,payload_enc,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning `+taskColumns, id, tenant, contract, input.IntentID, device, envelope.ServerHash, input.Kind, cryptox.SHA256(salt+string(raw)), cipher, actor)
	if err != nil {
		return nil, false, err
	}
	return rows[0], true, nil
}
func Tasks(ctx context.Context, tx *db.Tx, contract string) ([]jsonx.Object, error) {
	return tx.Objects(ctx, `select `+taskColumns+` from acs_task_intents where contract_id=$1 order by created_at desc,id desc limit 30`, contract)
}

func ProcessTasks(ctx context.Context, database *db.DB, tenant string) error {
	if os.Getenv("NEXO_ACS_TASKS_ENABLED") != "1" || !Configured() {
		return nil
	}
	return DispatchTasks(ctx, database, tenancy.Scope{TenantID: tenant}, os.Getenv("NEXO_ACS_TASK_WRITE") == "1")
}

func DispatchTasks(ctx context.Context, database *db.DB, scope tenancy.Scope, allowWrite bool) error {
	var rows []jsonx.Object
	if err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
		var e error
		rows, e = tx.Objects(ctx, `select id from acs_task_intents where ((state='prepared' and $1) or state in ('uncertain','queued')) and next_attempt_at<=now() order by next_attempt_at,id limit 20`, allowWrite)
		return e
	}); err != nil {
		return err
	}
	for _, row := range rows {
		id := jsonx.String(row.Get("id"))
		opctx, cancel := context.WithTimeout(ctx, 45*time.Second)
		err := runTask(opctx, database, scope, id, allowWrite)
		cancel()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			code := "acs_unavailable"
			review := false
			var a *apierr.Error
			if errors.As(err, &a) && (a.Status == 409 || a.Status == 403 || a.Status == 404) {
				code = "acs_review"
				review = true
			}
			if e := database.WithScope(ctx, scope, func(tx *db.Tx) error {
				return tx.Exec(ctx, `update acs_task_intents set state=case when $3 then 'review' else state end,last_error=$2,attempts=attempts+1,next_attempt_at=now()+interval '1 minute' where id=$1 and state in ('prepared','uncertain','queued')`, id, code, review)
			}); e != nil {
				return e
			}
		}
	}
	return nil
}

func runTask(ctx context.Context, database *db.DB, scope tenancy.Scope, id string, allowWrite bool) error {
	var envelope taskEnvelope
	var state, remote string
	var created time.Time
	send := false
	if err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
		var contract string
		if e := tx.QueryRow(ctx, `select contract_id from acs_task_intents where id=$1`, id).Scan(&contract); e != nil {
			return e
		}
		var linked string
		if e := tx.QueryRow(ctx, `select l.acs_device_id from contracts k join cpe_links l on l.contract_id=k.id and l.tenant_id=k.tenant_id where k.id=$1 and k.status='active' for update of k`, contract).Scan(&linked); e != nil {
			return apierr.New(409, "vínculo CPE indisponível")
		}
		if e := tx.QueryRow(ctx, `select state,coalesce(remote_task_id,''),created_at from acs_task_intents where id=$1 for update`, id).Scan(&state, &remote, &created); e != nil {
			return e
		}
		if state != "prepared" && state != "uncertain" && state != "queued" {
			return apierr.New(409, "intenção não elegível para processamento")
		}
		var e error
		envelope, e = readTaskEnvelope(ctx, tx, id)
		if e != nil {
			return e
		}
		if envelope.Tenant != scope.TenantID || envelope.Contract != contract || envelope.Device != linked || envelope.ServerHash != ServerFingerprint() {
			return apierr.New(409, "instância/propriedade ACS mudou; revisão obrigatória")
		}
		if state == "prepared" && allowWrite {
			send = true
			return tx.Exec(ctx, `update acs_task_intents set state='uncertain' where id=$1`, id)
		}
		return nil
	}); err != nil {
		return err
	}
	if state == "prepared" && !allowWrite {
		return nil
	}
	device, err := GetOwned(ctx, scope.TenantID, envelope.Device, "")
	if err != nil {
		return err
	}
	if device == nil {
		return apierr.New(409, "CPE sem propriedade confirmada para este tenant")
	}
	if send {
		receipt, e := SubmitTask(ctx, envelope.Device, envelope.Payload)
		if e != nil {
			return e
		}
		return database.WithScope(ctx, scope, func(tx *db.Tx) error {
			if err := tx.Exec(ctx, `update acs_task_intents set state='queued',remote_task_id=$2,attempts=attempts+1,last_error=null,next_attempt_at=now()+interval '30 seconds' where id=$1 and state='uncertain'`, id, receipt.ID); err != nil {
				return err
			}
			return taskAudit(ctx, tx, scope.TenantID, id, "acs.task.accepted", map[string]any{"remote_task_id": receipt.ID, "applied": false})
		})
	}
	found, fault, err := TaskEvidence(ctx, envelope.Device, "nexo:"+id, remote)
	if err != nil {
		return err
	}
	newState := state
	if fault {
		newState = "review"
	} else if found != "" {
		newState = "queued"
		remote = found
	} else if ReadbackMatches(device, envelope.Payload, envelope.Baseline, created) {
		newState = "observed"
	}
	return database.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := tx.Exec(ctx, `update acs_task_intents set state=$2,remote_task_id=coalesce(remote_task_id,nullif($3,'')),attempts=attempts+1,last_error=case when $2='review' then 'acs_task_fault' else null end,next_attempt_at=now()+interval '30 seconds' where id=$1 and state in ('uncertain','queued')`, id, newState, remote); err != nil {
			return err
		}
		if newState == "observed" || newState == "review" {
			return taskAudit(ctx, tx, scope.TenantID, id, "acs.task."+newState, map[string]any{"readback": newState == "observed", "fault_preserved": fault})
		}
		return nil
	})
}

func taskAudit(ctx context.Context, tx *db.Tx, tenant, id, action string, detail map[string]any) error {
	raw, _ := json.Marshal(detail)
	return tx.Exec(ctx, `insert into audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,detail) values($1,'system','acs-worker',$2,'acs_task',$3,$4::jsonb)`, tenant, action, id, string(raw))
}

func fresh(value any, created time.Time) bool {
	text, ok := value.(string)
	if !ok {
		return false
	}
	stamp, err := time.Parse(time.RFC3339Nano, text)
	return err == nil && !stamp.Before(created) && !stamp.After(time.Now().Add(2*time.Minute))
}
func ReadbackMatches(device map[string]any, payload, baseline map[string]any, created time.Time) bool {
	switch payload["name"] {
	case "setParameterValues":
		values, ok := payload["parameterValues"].([]any)
		if !ok || len(values) == 0 {
			return false
		}
		for _, raw := range values {
			p, ok := raw.([]any)
			if !ok || len(p) < 2 {
				return false
			}
			path, ok := p[0].(string)
			if !ok || At(device, path+"._value") != p[1] || !fresh(At(device, path+"._timestamp"), created) {
				return false
			}
		}
		return true
	case "refreshObject":
		root, _ := payload["objectName"].(string)
		return root != "" && fresh(At(device, root+"._timestamp"), created)
	case "reboot":
		summary := Summary(device)
		old, ok := baseline["uptime_s"].(float64)
		now, valid := summary["uptime_s"].(float64)
		root := "InternetGatewayDevice"
		if Model(device) == "tr181" {
			root = "Device"
		}
		return ok && valid && old > now+3 && now <= time.Since(created).Seconds()+30 && fresh(At(device, root+".DeviceInfo.UpTime._timestamp"), created)
	}
	return false
}

func RetryTaskLookup(ctx context.Context, tx *db.Tx, contract, id string) error {
	n, err := tx.Affected(ctx, `update acs_task_intents set state=case when state='review' then 'uncertain' else state end,last_error=null,next_attempt_at=now() where id=$1 and contract_id=$2 and state in ('uncertain','queued','review')`, id, contract)
	if err != nil {
		return err
	}
	if n == 0 {
		return apierr.New(409, "somente tarefa incerta/em fila/revisão pode retomar consulta")
	}
	return nil
}

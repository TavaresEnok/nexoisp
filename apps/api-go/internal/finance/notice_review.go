package finance

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
)

// ReviewProviderNotice never posts cash, changes a reservation or invokes a
// provider. The caller requires settings permission; scope and audit are enforced in this TX.
// Lock only the notice: taking an issuance lock afterwards would invert the
// receipt worker's lock order. A retry is consumed by the existing lookup worker.
func ReviewProviderNotice(ctx context.Context, tx *db.Tx, connection, id, actor, intent, action, reason string) (map[string]any, error) {
	reason = strings.TrimSpace(reason)
	parsed, e := uuid.Parse(intent)
	if e != nil {
		return nil, apierr.New(400, "intenção de revisão inválida")
	}
	intent = parsed.String()
	if n := utf8.RuneCountInString(reason); n < 10 || n > 500 {
		return nil, apierr.New(400, "informe justificativa de 10 a 500 caracteres")
	}
	if action != "ack" && action != "retry" {
		return nil, apierr.New(400, "ação de revisão inválida")
	}
	var allowed bool
	if e := tx.QueryRow(ctx, `select app_tenant() is not null and app_subscriber() is null and app_pops() is null and exists(select 1 from users where id=$1 and tenant_id=app_tenant() and active)`, actor).Scan(&allowed); e != nil {
		return nil, e
	}
	if !allowed {
		return nil, apierr.New(403, "revisão exige usuário ativo e escopo integral do provedor")
	}
	rows, e := tx.Objects(ctx, `select n.id::text,n.financial_connection_id::text,n.status,n.payload_hash from provider_notices n join financial_connections c on c.id=n.financial_connection_id where n.id=$1 and n.financial_connection_id=$2 for update of n`, id, connection)
	if e != nil {
		return nil, e
	}
	if len(rows) == 0 {
		return nil, apierr.New(404, "notificação não encontrada")
	}
	id = jsonx.String(rows[0].Get("id"))
	connection = jsonx.String(rows[0].Get("financial_connection_id"))
	decisions, e := tx.Objects(ctx, `select action,actor_id,detail->>'reason' as reason,detail->>'connection_id' as connection_id,detail->>'result' as result from audit_events where entity_type='provider_notice' and entity_id=$1 and action in ('finance.notice.ack','finance.notice.retry') and detail->>'intent_id'=$2 order by id desc limit 1`, id, intent)
	if e != nil {
		return nil, e
	}
	if len(decisions) > 0 {
		detail := decisions[0]
		if decisions[0].Get("action") != "finance.notice."+action || detail.Get("reason") != reason || detail.Get("connection_id") != connection || detail.Get("actor_id") != actor {
			return nil, apierr.New(409, "intenção já utilizada com outra revisão")
		}
		return map[string]any{"result": detail.Get("result"), "replayed": true, "funds_changed": false, "provider_called": false}, nil
	}
	state := jsonx.String(rows[0].Get("status"))
	if state == "processed" {
		return nil, apierr.New(409, "notificação já processada; consulte a cobrança e o recebimento")
	}
	if state == "pending" {
		return nil, apierr.New(409, "consulta de recebimento já pendente; aguarde o processamento")
	}
	result := "acknowledged"
	if action == "retry" {
		if e = tx.Exec(ctx, `update provider_notices set status='unmatched',processed_at=null where id=$1 and financial_connection_id=$2`, id, connection); e != nil {
			return nil, e
		}
		result = "lookup_queued"
	}
	detail, e := jsonx.Encode(map[string]any{"connection_id": connection, "intent_id": intent, "reason": reason, "result": result, "prior_status": state, "payload_hash": rows[0].Get("payload_hash"), "funds_changed": false, "provider_called": false})
	if e != nil {
		return nil, e
	}
	if e = tx.Exec(ctx, `insert into audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,detail) values(app_tenant(),'user',$1,$2,'provider_notice',$3,$4::jsonb)`, actor, "finance.notice."+action, id, string(detail)); e != nil {
		return nil, e
	}
	return map[string]any{"result": result, "replayed": false, "funds_changed": false, "provider_called": false}, nil
}

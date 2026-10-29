// Consentimento de releitura da fila de avisos.
// Não grava, não chama rede e não troca o número pedido por outro contato.
package cloudjournal

import (
	"context"
	"fmt"

	"nexoisp/api-go/internal/db"
)

// FOR SHARE, não FOR KEY SHARE: opt-out muda allow_notices, coluna que não é chave.
// KEY SHARE deixa esse UPDATE passar. O lock dura até o fim da transação do chamador.
const consentFrom = `select id::text as id
from subscriber_contacts
where tenant_id = $1::uuid
  and tenant_id = app_tenant()
  and subscriber_id = $2::uuid
  and (app_subscriber() is null or subscriber_id = app_subscriber())
  and value = $3
  and allow_notices
  and kind in ('mobile', 'whatsapp')`

const consentBillingSQL = consentFrom + `
  and purpose in ('billing', 'general')
order by id
for share`

const consentMaintenanceSQL = consentFrom + `
order by id
for share`

// ConsentBilling é o filtro de 69b06ce3_4.sql no número já gravado.
// Purpose technical não autoriza cobrança. O valor tem de ser exatamente contactValue.
func ConsentBilling(ctx context.Context, tx *db.Tx, tenant, subscriberID, contactValue string) (bool, error) {
	return consentMatch(ctx, tx, tenant, subscriberID, contactValue, consentBillingSQL)
}

// ConsentMaintenance é o filtro do where de aee9567a_3.sql no número já gravado.
// Qualquer purpose passa. A preferência por technical fica só na entrada da fila.
func ConsentMaintenance(ctx context.Context, tx *db.Tx, tenant, subscriberID, contactValue string) (bool, error) {
	return consentMatch(ctx, tx, tenant, subscriberID, contactValue, consentMaintenanceSQL)
}

func consentMatch(ctx context.Context, tx *db.Tx, tenant, subscriberID, contactValue, query string) (bool, error) {
	if err := consentScope(ctx, tx, tenant, subscriberID); err != nil {
		return false, err
	}
	rows, err := tx.Objects(ctx, query, tenant, subscriberID, contactValue)
	if err != nil {
		return false, err
	}
	return len(rows) > 0, nil
}

func consentScope(ctx context.Context, tx *db.Tx, tenant, subscriberID string) error {
	if tenant == "" || subscriberID == "" {
		return fmt.Errorf("cloudjournal: tenant e assinante precisam ser explícitos")
	}
	var scopeTenant, scopeSubscriber string
	if err := tx.QueryRow(ctx, `select coalesce(app_tenant()::text, ''), coalesce(app_subscriber()::text, '')`).Scan(&scopeTenant, &scopeSubscriber); err != nil {
		return err
	}
	if scopeTenant == "" || scopeTenant != tenant {
		return fmt.Errorf("cloudjournal: app_tenant incompatível com o tenant informado")
	}
	if scopeSubscriber != "" && scopeSubscriber != subscriberID {
		return fmt.Errorf("cloudjournal: app_subscriber incompatível com o assinante informado")
	}
	return nil
}

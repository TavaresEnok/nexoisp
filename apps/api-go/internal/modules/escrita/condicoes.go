package escrita

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"time"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
)

var ufCode = map[string]string{"RO": "11", "AC": "12", "AM": "13", "RR": "14", "PA": "15", "AP": "16", "TO": "17", "MA": "21", "PI": "22", "CE": "23", "RN": "24", "PB": "25", "PE": "26", "AL": "27", "SE": "28", "BA": "29", "MG": "31", "ES": "32", "RJ": "33", "SP": "35", "PR": "41", "SC": "42", "RS": "43", "MS": "50", "MT": "51", "GO": "52", "DF": "53"}

func (s Service) municipality(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	const key = "PUT /api/anatel/municipalities"
	state, code := b["state"].(string), b["ibge_code"].(string)
	if ufCode[state] != code[:2] {
		return nil, apierr.New(400, fmt.Sprintf("o código IBGE %s não é de %s (os 2 primeiros dígitos indicam a UF)", code, state))
	}
	if err := tx.Exec(ctx, query(key, 0), state, b["name"]); err != nil {
		return nil, err
	}
	if err := tx.Exec(ctx, query(key, 1), auth.From(ctx).TenantID, b["name"], state, code); err != nil {
		return nil, err
	}
	return b, record(ctx, tx, "anatel.municipality", "municipality", nil, b)
}
func (s Service) planTechnology(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	row, err := mustRow(ctx, tx, "PUT /api/plans/:id/technology", 0, "plano não encontrado", id, b["access_technology"])
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "plan.technology", "plan", id, b)
}
func (s Service) serviceArea(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	if _, err := mustRow(ctx, tx, "PUT /api/contracts/:id/service-area", 0, "contrato não encontrado", id, b["service_area"]); err != nil {
		return nil, err
	}
	return b, record(ctx, tx, "contract.service_area", "contract", id, b)
}
func (s Service) creditRestriction(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PUT /api/contracts/:id/credit-restriction"
	row, err := mustRow(ctx, tx, key, 0, "contrato ativo não encontrado", id, b["restricted"])
	if err != nil {
		return nil, err
	}
	event, action := "credit_released", "contract.credit_release"
	if b["restricted"] == true {
		event, action = "credit_restricted", "contract.credit_restrict"
	}
	detail := map[string]any{"note": b["note"]}
	raw, err := json.Marshal(detail)
	if err != nil {
		return nil, err
	}
	c := auth.From(ctx)
	if err = tx.Exec(ctx, query(key, 1), c.TenantID, id, c.UserID, event, raw); err != nil {
		return nil, err
	}
	return row, record(ctx, tx, action, "contract", id, detail)
}
func assertCatalog(ctx context.Context, tx *db.Tx, id any, kind, label string) error {
	if id == nil || id == "" {
		return nil
	}
	rows, err := tx.Objects(ctx, "select kind, active from catalog_items where id = $1", id)
	if err != nil {
		return err
	}
	if len(rows) == 0 || rows[0].Get("kind") != kind {
		return apierr.New(400, label+": item de catálogo inválido")
	}
	if rows[0].Get("active") != true {
		return apierr.New(400, label+": o item está inativo")
	}
	return nil
}
func (s Service) subscriberNote(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/subscribers/:id/notes"
	if _, err := mustRow(ctx, tx, key, 0, "assinante não encontrado", id); err != nil {
		return nil, err
	}
	if b["contract_id"] != nil {
		row, err := one(ctx, tx, key, 1, b["contract_id"], id)
		if err != nil {
			return nil, err
		}
		if row == nil {
			return nil, apierr.New(400, "o contrato não pertence a este assinante")
		}
	}
	if err := assertCatalog(ctx, tx, b["type_id"], "note_type", "tipo de anotação"); err != nil {
		return nil, err
	}
	c := auth.From(ctx)
	row, err := one(ctx, tx, key, 2, c.TenantID, id, b["contract_id"], b["type_id"], b["body"], b["alert"], c.UserID)
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "subscriber.note", "subscriber", id, map[string]any{"note_id": row.Get("id"), "alert": b["alert"]})
}
func (s Service) updateNote(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	row, err := mustRow(ctx, tx, "PATCH /api/notes/:id", 0, "anotação não encontrada", id, b["archived"], b["alert"])
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "subscriber.note_update", "subscriber_note", id, b)
}
func validDateTime(v any) bool {
	s := v.(string)
	// Zod datetime({offset:true}) accepts HH:mm and HH:mm:ss, with an optional fractional second.
	if !regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$`).MatchString(s) {
		return false
	}
	_, err := parseDateTime(s)
	return err == nil
}
func parseDateTime(s string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04Z07:00", "2006-01-02T15:04:05.999999999Z0700", "2006-01-02T15:04Z0700"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("data inválida")
}
func (s Service) createMaintenance(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	const key = "POST /api/maintenance-notices"
	start, _ := parseDateTime(b["starts_at"].(string))
	end, _ := parseDateTime(b["ends_at"].(string))
	if !end.After(start) {
		return nil, apierr.New(400, "o fim deve ser depois do início")
	}
	if b["device_id"] != nil {
		row, err := one(ctx, tx, key, 0, b["device_id"])
		if err != nil {
			return nil, err
		}
		if row == nil {
			return nil, apierr.New(400, "equipamento não encontrado")
		}
	}
	c := auth.From(ctx)
	row, err := one(ctx, tx, key, 1, c.TenantID, b["title"], b["message"], b["severity"], b["device_id"], start, end, c.UserID)
	if err != nil {
		return nil, err
	}
	if err = record(ctx, tx, "maintenance_notice.create", "maintenance_notice", row.Get("id"), map[string]any{"title": b["title"], "device_id": b["device_id"]}); err != nil {
		return nil, err
	}
	return one(ctx, tx, key, 2, row.Get("id"))
}
func (s Service) cancelMaintenance(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	row, err := one(ctx, tx, "POST /api/maintenance-notices/:id/cancel", 0, id)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, apierr.New(400, "aviso não encontrado, já cancelado ou já encerrado")
	}
	return map[string]any{"ok": true}, record(ctx, tx, "maintenance_notice.cancel", "maintenance_notice", id, nil)
}

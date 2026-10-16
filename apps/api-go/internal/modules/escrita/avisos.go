package escrita

import (
	"context"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/domain"
	"nexoisp/api-go/internal/validate"
	"regexp"
	"slices"
	"strings"
)

func (s Service) noticeOperations(ops map[string]operation) {
	f, o, str, n, b := validate.F, validate.Object, validate.String, validate.Number, validate.Boolean
	uuid := str().UUID()
	simple(ops, "PATCH /api/notice-channels/:id", o(f("active", b())), "canal não encontrado", "notice_channel.update", "notice_channel", []string{":id", "active"}, false)
	simple(ops, "PATCH /api/notice-rules/:id", o(f("active", b())), "regra não encontrada", "notice_rule.update", "notice_rule", []string{":id", "active"}, false)
	ops["DELETE /api/notice-channels/:id"] = operation{s.deleteChannel, nil}
	ops["DELETE /api/notice-templates/:id"] = operation{s.deleteTemplate, nil}
	ops["DELETE /api/notice-rules/:id"] = operation{s.deleteNoticeRule, nil}
	ops["POST /api/notice-templates"] = operation{s.createNoticeTemplate, obj(o(f("name", str().Trimmed().Min(2).Max(60)), f("body", str().Trimmed().Min(3).Max(480))))}
	ops["POST /api/notice-rules"] = operation{s.createNoticeRule, obj(o(f("name", str().Trimmed().Min(2).Max(80)), f("template_id", uuid), f("channel_id", uuid), f("days_relative", n().Int().Min(-30).Max(365)), f("plan_id", uuid.Nullish()), f("pop_id", uuid.Nullish()), f("tag_id", uuid.Nullish()), f("hour_from", n().Int().Min(0).Max(23).Def(float64(8))), f("hour_to", n().Int().Min(1).Max(24).Def(float64(20))), f("weekdays", validate.Array(n().Int().Min(0).Max(6)).Min(1).Def([]any{float64(0), float64(1), float64(2), float64(3), float64(4), float64(5), float64(6)})), f("min_interval_days", n().Int().Min(0).Max(60).Def(float64(1)))))}
	ops["POST /api/portal/surveys/:id"] = operation{s.answerSurvey, obj(o(f("score", n().Int().Min(1).Max(5)), f("comment", text(500).Nullish().Then(nilEmpty, true))))}
}
func (s Service) deleteChannel(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	return deleteReferenced(ctx, tx, "DELETE /api/notice-channels/:id", id, "há regras usando este canal", "canal não encontrado", "notice_channel.delete", "notice_channel")
}
func (s Service) deleteTemplate(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	return deleteReferenced(ctx, tx, "DELETE /api/notice-templates/:id", id, "há regras usando este modelo", "modelo não encontrado", "notice_template.delete", "notice_template")
}
func deleteReferenced(ctx context.Context, tx *db.Tx, key, id, used, missing, action, entity string) (any, error) {
	rows, err := rows(ctx, tx, key, 0, id)
	if err != nil {
		return nil, err
	}
	if len(rows) > 0 {
		return nil, apierr.New(409, used)
	}
	n, err := tx.Affected(ctx, query(key, 1), id)
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, apierr.New(404, missing)
	}
	return map[string]any{"ok": true}, record(ctx, tx, action, entity, id, nil)
}
func (s Service) deleteNoticeRule(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	n, err := tx.Affected(ctx, query("DELETE /api/notice-rules/:id", 0), id)
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, apierr.New(404, "regra não encontrada")
	}
	return map[string]any{"ok": true}, record(ctx, tx, "notice_rule.delete", "notice_rule", id, nil)
}

var noticeVariables = []string{"nome", "valor", "vencimento", "plano", "link"}
var noticeVariableRE = regexp.MustCompile(`\{([a-z_]+)\}`)

func (s Service) createNoticeTemplate(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	body := b["body"].(string)
	bad := []string{}
	for _, match := range noticeVariableRE.FindAllStringSubmatch(body, -1) {
		if !slices.Contains(noticeVariables, match[1]) && !slices.Contains(bad, "{"+match[1]+"}") {
			bad = append(bad, "{"+match[1]+"}")
		}
	}
	if len(bad) > 0 {
		return nil, apierr.New(400, "variável desconhecida: "+strings.Join(bad, ", ")+". Use: {"+strings.Join(noticeVariables, "}, {")+"}")
	}
	row, err := one(ctx, tx, "POST /api/notice-templates", 0, auth.From(ctx).TenantID, b["name"], body)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, apierr.New(409, "já existe um modelo com este nome")
	}
	sample := map[string]string{"nome": "Maria", "valor": "R$ 79,90", "vencimento": "10/11/2026", "plano": "Fibra 200", "link": "https://exemplo.invalido/"}
	preview := noticeVariableRE.ReplaceAllStringFunc(body, func(match string) string { return sample[match[1:len(match)-1]] })
	preview = regexp.MustCompile(`[\s\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]{2,}`).ReplaceAllString(preview, " ")
	row.Set("preview", validate.Trim(preview))
	return row, record(ctx, tx, "notice_template.create", "notice_template", row.Get("id"), map[string]any{"name": b["name"]})
}
func (s Service) createNoticeRule(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	const key = "POST /api/notice-rules"
	if num(b["hour_from"]) >= num(b["hour_to"]) {
		return nil, apierr.New(400, "a janela de envio precisa ter início antes do fim")
	}
	for index, keyField := range []string{"template_id", "channel_id"} {
		r, err := one(ctx, tx, key, index, b[keyField])
		if err != nil {
			return nil, err
		}
		if r == nil {
			message := "modelo não encontrado"
			if index == 1 {
				message = "canal não encontrado"
			}
			return nil, apierr.New(400, message)
		}
	}
	weekdays := []any{}
	seen := map[float64]bool{}
	for _, v := range b["weekdays"].([]any) {
		day := num(v)
		if !seen[day] {
			weekdays = append(weekdays, day)
			seen[day] = true
		}
	}
	row, err := one(ctx, tx, key, 2, auth.From(ctx).TenantID, b["name"], b["template_id"], b["channel_id"], b["days_relative"], b["plan_id"], b["pop_id"], b["tag_id"], b["hour_from"], b["hour_to"], weekdays, b["min_interval_days"])
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "notice_rule.create", "notice_rule", row.Get("id"), map[string]any{"name": b["name"], "days_relative": b["days_relative"]})
}
func (s Service) answerSurvey(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	c := auth.From(ctx)
	if c.SubscriberID == "" {
		return nil, apierr.New(403, "sessão sem assinante")
	}
	row, err := one(ctx, tx, "POST /api/portal/surveys/:id", 0, id, c.SubscriberID, b["score"], b["comment"])
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, apierr.New(409, "pesquisa não encontrada, já respondida ou expirada")
	}
	if err = record(ctx, tx, "survey.answer", "satisfaction_survey", id, map[string]any{"score": b["score"]}); err != nil {
		return nil, err
	}
	return row, domain.Emit(ctx, tx, c.TenantID, "survey.answered", map[string]any{"survey_id": id, "score": b["score"]})
}

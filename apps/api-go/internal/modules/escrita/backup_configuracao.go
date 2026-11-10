package escrita

import (
	"context"
	"net/http"
	"slices"

	"github.com/danielgtaylor/huma/v2"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/network"
)

// Backup de configuração dos equipamentos com agente (OLTs e concentradores): semanal, 4 cópias por
// equipamento, cifrado. Listar é leitura de rede; abrir o texto ou comparar exige escrita de rede, vale só
// para sessões do provedor inteiro (configuração completa do equipamento) e fica registrado na auditoria.
func registerConfigBackups(api huma.API, registry *endpoint.Registry, s Service) {
	const columns = `b.id, b.device_id, b.taken_at, b.trigger, b.size_bytes, b.lines, b.sha256, b.changed`
	routeScoped(api, registry, s, http.MethodGet, "/api/devices/{id}/config-backups", "network:read", nil, false, func(ctx context.Context, tx *db.Tx, _ *http.Request, p map[string]string, _ map[string]any) (any, error) {
		dev, err := firstRow("equipamento não encontrado")(tx.Objects(ctx, `select d.id, d.name, d.driver, d.agent_id, d.config_backup, d.config_backup_requested_at,
				d.config_backup_error, d.config_backup_error_at, d.driver = any($2) as supported from devices d where d.id = $1`, p["id"], network.ConfigBackupDrivers))
		if err != nil {
			return nil, err
		}
		due, err := network.ConfigBackupNextDue(ctx, tx, p["id"])
		if err != nil {
			return nil, err
		}
		dev.Set("next_due_at", due)
		items, err := tx.Objects(ctx, `select `+columns+` from config_backups b where b.device_id = $1 order by b.taken_at desc, b.id desc`, p["id"])
		if err != nil {
			return nil, err
		}
		return map[string]any{"device": dev, "items": items, "keep": network.ConfigBackupKeep, "interval_days": 7}, nil
	})
	routeScoped(api, registry, s, http.MethodPost, "/api/devices/{id}/config-backups", "network:write", nil, false, func(ctx context.Context, tx *db.Tx, _ *http.Request, p map[string]string, _ map[string]any) (any, error) {
		dev, err := firstRow("equipamento não encontrado")(tx.Objects(ctx, `select id, driver, agent_id, config_backup from devices where id = $1 for update`, p["id"]))
		if err != nil {
			return nil, err
		}
		switch {
		case !slices.Contains(network.ConfigBackupDrivers, dev.Get("driver").(string)):
			return nil, apierr.New(400, "este equipamento não tem backup de configuração (só OLTs e concentradores acessados pelo agente)")
		case dev.Get("agent_id") == nil:
			return nil, apierr.New(400, "equipamento sem agente: o backup é feito pelo agente instalado no provedor")
		case dev.Get("config_backup") != true:
			return nil, apierr.New(400, "backup de configuração desligado neste equipamento")
		}
		row, err := firstRow("equipamento não encontrado")(tx.Objects(ctx, `update devices set config_backup_requested_at = coalesce(config_backup_requested_at, now()) where id = $1
			returning config_backup_requested_at`, p["id"]))
		if err != nil {
			return nil, err
		}
		return row, record(ctx, tx, "device.config_backup_request", "device", p["id"], nil)
	})
	routeScoped(api, registry, s, http.MethodGet, "/api/config-backups/{id}", "network:write", nil, false, tenantWide(func(ctx context.Context, tx *db.Tx, _ *http.Request, p map[string]string, _ map[string]any) (any, error) {
		row, err := firstRow("backup não encontrado")(tx.Objects(ctx, `select `+columns+`, d.name as device_name, b.content_enc from config_backups b join devices d on d.id = b.device_id where b.id = $1`, p["id"]))
		if err != nil {
			return nil, err
		}
		content, err := network.OpenConfig(row.Get("content_enc").(string))
		if err != nil {
			return nil, apierr.New(500, "backup não pôde ser decifrado com as chaves configuradas")
		}
		row.Set("content_enc", nil)
		row.Set("content", content)
		return row, record(ctx, tx, "config_backup.view", "device", row.Get("device_id"), map[string]any{"backup_id": p["id"], "sha256": row.Get("sha256")})
	}))
	routeScoped(api, registry, s, http.MethodGet, "/api/config-backups/{id}/diff", "network:write", nil, false, tenantWide(func(ctx context.Context, tx *db.Tx, _ *http.Request, p map[string]string, _ map[string]any) (any, error) {
		cur, err := firstRow("backup não encontrado")(tx.Objects(ctx, `select `+columns+`, b.content_enc from config_backups b where b.id = $1`, p["id"]))
		if err != nil {
			return nil, err
		}
		prev, err := tx.Objects(ctx, `select `+columns+`, b.content_enc from config_backups b where b.device_id = $1 and (b.taken_at, b.id) < ($2, $3)
			order by b.taken_at desc, b.id desc limit 1`, cur.Get("device_id"), cur.Get("taken_at"), p["id"])
		if err != nil {
			return nil, err
		}
		if len(prev) == 0 {
			return nil, apierr.New(409, "não há cópia anterior para comparar")
		}
		after, err := network.OpenConfig(cur.Get("content_enc").(string))
		if err != nil {
			return nil, apierr.New(500, "backup não pôde ser decifrado com as chaves configuradas")
		}
		before, err := network.OpenConfig(prev[0].Get("content_enc").(string))
		if err != nil {
			return nil, apierr.New(500, "backup não pôde ser decifrado com as chaves configuradas")
		}
		cur.Set("content_enc", nil)
		prev[0].Set("content_enc", nil)
		lines, added, removed, truncated := network.ConfigDiff(before, after)
		if lines == nil {
			lines = []network.DiffLine{}
		}
		out := map[string]any{"backup": cur, "previous": prev[0], "lines": lines, "added": added, "removed": removed, "truncated": truncated}
		return out, record(ctx, tx, "config_backup.diff", "device", cur.Get("device_id"), map[string]any{"backup_id": p["id"], "previous_id": prev[0].Get("id")})
	}))
}

package radius

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/network"
)

type disconnectMarker struct {
	AccountingID string `json:"accounting_id"`
	SessionID    string `json:"session_id"`
	NASIP        string `json:"nas_ip"`
	StartedAt    string `json:"started_at"`
	Outcome      string `json:"outcome"`
}

func markerFor(session jsonx.Object) disconnectMarker {
	return disconnectMarker{AccountingID: jsonx.String(session.Get("id")), SessionID: jsonx.String(session.Get("session_id")), NASIP: jsonx.String(session.Get("nas_ip")), StartedAt: date(session.Get("started_at")).UTC().Format(time.RFC3339Nano), Outcome: "uncertain"}
}
func markerStep(marker disconnectMarker) map[string]any {
	return map[string]any{"name": "desconexão identificada", "status": marker.Outcome, "radius_disconnect": marker}
}
func disconnectHistory(ctx context.Context, tx *db.Tx, operation string) (map[string]disconnectMarker, error) {
	rows, err := tx.Objects(ctx, `select item->'radius_disconnect' as marker from operation_attempts a cross join lateral jsonb_array_elements(a.steps) item where a.operation_id=$1 and item ? 'radius_disconnect' order by a.started_at,a.id`, operation)
	out := map[string]disconnectMarker{}
	for _, row := range rows {
		var marker disconnectMarker
		data, e := jsonx.Encode(row.Get("marker"))
		if e != nil {
			return nil, e
		}
		if e = json.Unmarshal(data, &marker); e != nil || marker.AccountingID == "" || marker.SessionID == "" || marker.NASIP == "" || marker.StartedAt == "" {
			return nil, fmt.Errorf("identidade de desconexão anterior incompleta")
		}
		out[marker.AccountingID] = marker
	}
	return out, err
}
func disconnectedByAccounting(ctx context.Context, tx *db.Tx, tenant, user string, marker disconnectMarker) (bool, error) {
	id, err := strconv.ParseInt(marker.AccountingID, 10, 64)
	if err != nil {
		return false, err
	}
	var stopped bool
	err = tx.QueryRow(ctx, `select exists(select 1 from radius_acct where id=$1 and tenant_id=$2 and username=$3 and session_id=$4 and nas_ip=$5::inet and started_at=$6::timestamptz and stopped_at is not null)`, id, tenant, user, marker.SessionID, marker.NASIP, marker.StartedAt).Scan(&stopped)
	return stopped, err
}
func closeDisconnected(ctx context.Context, tx *db.Tx, tenant, user string, marker disconnectMarker, why string) error {
	id, err := strconv.ParseInt(marker.AccountingID, 10, 64)
	if err != nil {
		return err
	}
	return tx.Exec(ctx, `update radius_acct set stopped_at=now(),updated_at=greatest(updated_at,now()),terminate_cause=$7 where id=$1 and tenant_id=$2 and username=$3 and session_id=$4 and nas_ip=$5::inet and started_at=$6::timestamptz and stopped_at is null`, id, tenant, user, marker.SessionID, marker.NASIP, marker.StartedAt, why)
}
func persistDisconnectSteps(ctx context.Context, tx *db.Tx, agent, attempt string, steps []map[string]any) error {
	result, err := network.Progress(ctx, tx, agent, attempt, "EXECUTING", steps)
	if err == nil && result["ok"] != true {
		return fmt.Errorf("posse da operação mudou antes da desconexão")
	}
	return err
}

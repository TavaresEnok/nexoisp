package leitura

import (
	"context"
	"nexoisp/api-go/internal/db"
	"os"
)

func (s Service) radiusCapabilities(ctx context.Context, tx *db.Tx) (map[string]any, error) {
	health, err := tx.Objects(ctx, `select (select count(*) from radius_account) as accounts,
 (select count(*) from radius_nas) as nas,
 (select count(*) from radius_nas where last_packet_at>now()-interval '15 minutes') as recent_nas,
 (select count(*) from radius_acct where stopped_at is null) as open_sessions,
 (select count(*) from radius_acct where stopped_at is null and seen_at<now()-interval '15 minutes') as stale_sessions,
 (select count(*) from operations o join devices d on d.id=o.device_id where d.driver='radius' and o.status='UNCERTAIN') as uncertain_operations`)
	if err != nil {
		return nil, err
	}
	capabilities := map[string]any{"authorization_store_reachable": true, "counts": health[0], "disconnect_write_enabled": os.Getenv("NEXO_RADIUS_DISCONNECT_WRITE") == "1", "accounting_sync_enabled": os.Getenv("NEXO_GO_JOBS") == "1" && os.Getenv("NEXO_GO_JOB_RADIUS_SYNC") == "1", "packet_recency_is_policy_proof": false}
	return capabilities, nil
}

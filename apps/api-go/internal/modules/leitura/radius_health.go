package leitura

import (
	"context"
	"net/http"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"os"
)

// radiusStatusScope rejects partial POP views before either installation-wide or
// tenant-wide data is queried. A non-nil empty slice is a restricted scope too.
func radiusStatusScope(ctx context.Context) error {
	actor := auth.From(ctx)
	if actor == nil || actor.Scope.PopIDs != nil {
		return apierr.New(http.StatusForbidden, "status RADIUS indisponível para escopo POP restrito")
	}
	return nil
}

func (s Service) radiusCapabilities(ctx context.Context, tx *db.Tx) (map[string]any, error) {
	if err := radiusStatusScope(ctx); err != nil {
		return nil, err
	}
	health, err := tx.Objects(ctx, `select (select count(*) from radius_account) as accounts,
 (select count(*) from radius_nas) as nas,
 (select count(*) from radius_nas where last_packet_at>now()-interval '15 minutes') as recent_nas,
 (select count(*) from radius_acct where stopped_at is null) as open_sessions,
 (select count(*) from radius_accounting_events where status='quarantine') as quarantined_events,
 (select count(*) from radius_acct where nas_device_id is null) as unmapped_sessions,
 (select count(*) from radius_acct where framed_ipv6_address is not null or framed_ipv6_prefix is not null or delegated_ipv6_prefix is not null) as ipv6_sessions,
 (select count(*) from radius_acct where stopped_at is null and seen_at<now()-interval '15 minutes') as stale_sessions,
 (select count(*) from operations o join devices d on d.id=o.device_id where d.driver='radius' and o.status='UNCERTAIN') as uncertain_operations`)
	if err != nil {
		return nil, err
	}
	capabilities := map[string]any{"authorization_store_reachable": true, "counts": health[0], "disconnect_write_enabled": os.Getenv("NEXO_RADIUS_DISCONNECT_WRITE") == "1", "accounting_sync_enabled": os.Getenv("NEXO_GO_JOBS") == "1" && os.Getenv("NEXO_GO_JOB_RADIUS_SYNC") == "1", "packet_recency_is_policy_proof": false, "accounting_review_allowed": auth.From(ctx) != nil && !auth.From(ctx).Support && auth.From(ctx).Scope.SubscriberID == "" && auth.From(ctx).Scope.PopIDs == nil}
	return capabilities, nil
}

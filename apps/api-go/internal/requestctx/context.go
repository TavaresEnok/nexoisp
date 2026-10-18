// Package requestctx carries bounded observability labels without HTTP/DB dependencies.
package requestctx

import "context"

type Key struct{}
type State struct{ Route, UserID, TenantID, RequestID string }

func From(ctx context.Context) *State { s, _ := ctx.Value(Key{}).(*State); return s }
func Route(ctx context.Context) string {
	if s := From(ctx); s != nil && s.Route != "" {
		return s.Route
	}
	return "background"
}

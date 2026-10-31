package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"slices"
)

// ContextMarker is an opaque precondition, not an authorization credential.
// Including the session hash makes even an identical replacement session stale.
func ContextMarker(c *Ctx) string {
	pops, modules, permissions := slices.Clone(c.PopIDs), slices.Clone(c.Modules), slices.Clone(c.Permissions)
	slices.Sort(pops)
	slices.Sort(modules)
	slices.Sort(permissions)
	b, _ := json.Marshal([]any{c.TokenHash, c.UserID, c.TenantID, c.SubscriberID, c.Role, c.Support, c.MFAEnabled, pops, modules, permissions, c.Scope.Cell, c.SessionCell})
	sum := sha256.Sum256(append([]byte("nexo-context-v1\x00"), b...))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

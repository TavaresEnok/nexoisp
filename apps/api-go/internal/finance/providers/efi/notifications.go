package efi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
)

var notificationToken = regexp.MustCompile(`^[A-Za-z0-9_-]{16,256}$`)

func ValidNotificationToken(token string) bool { return notificationToken.MatchString(token) }

type ChargeNotice struct {
	ChargeID string
	CustomID string
}

// The token is only a hint. This authenticated API lookup establishes which
// account/charge it belongs to; the charge is then read back through its adapter.
func (c *Client) ChargeNotifications(ctx context.Context, token string) ([]ChargeNotice, error) {
	if c.authPath != "/v1/authorize" || !ValidNotificationToken(token) {
		return nil, failure("conflict", "invalid notification lookup")
	}
	var reply struct {
		Code int `json:"code"`
		Data []struct {
			Type     string `json:"type"`
			CustomID string `json:"custom_id"`
			IDs      struct {
				ChargeID json.Number `json:"charge_id"`
			} `json:"identifiers"`
		} `json:"data"`
	}
	if err := c.request(ctx, http.MethodGet, "/v1/notification/"+url.PathEscape(token), nil, &reply); err != nil {
		return nil, err
	}
	if reply.Code != 200 || len(reply.Data) == 0 || len(reply.Data) > 10000 {
		return nil, failure("conflict", "invalid notification history")
	}
	seen := map[string]string{}
	out := []ChargeNotice{}
	for _, v := range reply.Data {
		id := v.IDs.ChargeID.String()
		if v.Type != "charge" || !chargeNumber.MatchString(id) {
			return nil, failure("conflict", "unsupported notification identity")
		}
		if prior, ok := seen[id]; ok && prior != "" && v.CustomID != "" && prior != v.CustomID {
			return nil, failure("conflict", "notification identity drift")
		}
		if v.CustomID != "" {
			seen[id] = v.CustomID
		} else if _, ok := seen[id]; !ok {
			seen[id] = ""
		}
	}
	for id, custom := range seen {
		out = append(out, ChargeNotice{ChargeID: id, CustomID: custom})
	}
	return out, nil
}

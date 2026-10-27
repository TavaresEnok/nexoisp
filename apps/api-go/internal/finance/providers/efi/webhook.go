package efi

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"nexoisp/api-go/internal/finance/providers"
)

func (c *Client) ReadPixWebhook(ctx context.Context, key string) (string, error) {
	if c.authPath != "/oauth/token" || key == "" {
		return "", failure(providers.Rejected, "invalid webhook configuration")
	}
	var reply struct {
		URL string `json:"webhookUrl"`
		Key string `json:"chave"`
	}
	err := c.request(ctx, http.MethodGet, "/v2/webhook/"+url.PathEscape(key), nil, &reply)
	if err != nil {
		var f *providers.Failure
		if errors.As(err, &f) && f.HTTPStatus == 404 {
			return "", nil
		}
		return "", err
	}
	if reply.Key != key || reply.URL == "" {
		return "", failure(providers.Conflict, "webhook readback identity mismatch")
	}
	return reply.URL, nil
}
func (c *Client) RegisterPixWebhook(ctx context.Context, key, callback string, replace bool) error {
	existing, err := c.ReadPixWebhook(ctx, key)
	if err != nil {
		return err
	}
	if existing == callback {
		return nil
	}
	if existing != "" && !replace {
		return failure(providers.Conflict, "existing Pix webhook requires explicit replacement")
	}
	u, e := url.Parse(callback)
	if e != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return failure(providers.Rejected, "invalid webhook destination")
	}
	writeErr := c.request(ctx, http.MethodPut, "/v2/webhook/"+url.PathEscape(key), map[string]string{"webhookUrl": callback}, nil)
	confirmed, readErr := c.ReadPixWebhook(ctx, key)
	if readErr == nil && confirmed == callback {
		return nil
	}
	if readErr != nil {
		return readErr
	}
	if writeErr != nil {
		return writeErr
	}
	return failure(providers.Conflict, "webhook registration was not confirmed")
}

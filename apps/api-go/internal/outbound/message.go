package outbound

import (
	"context"
	"fmt"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/jsonx"
	"regexp"
	"time"
)

func Message(ctx context.Context, channel jsonx.Object, phone, message string) error {
	headers := map[string]string{}
	if jsonx.Truthy(channel.Get("headers_enc")) {
		secret, err := cryptox.DecryptSecret(channel.Get("headers_enc").(string))
		if err != nil {
			return err
		}
		if fields, ok := jsonx.JSON([]byte(secret)).(jsonx.Object); ok {
			for _, field := range fields {
				if regexp.MustCompile(`^[A-Za-z0-9-]{1,40}$`).MatchString(field.Name) {
					headers[field.Name] = jsonx.String(field.Value)
				}
			}
		}
	}
	payload := jsonx.Object{}
	if fields, ok := channel.Get("extra_body").(jsonx.Object); ok {
		payload = append(payload, fields...)
	}
	payload.Set(channel.Get("phone_field").(string), phone)
	payload.Set(channel.Get("message_field").(string), message)
	status, err := Post(ctx, channel.Get("url").(string), payload, headers, 10*time.Second)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("o provedor de envio respondeu %d", status)
	}
	return nil
}

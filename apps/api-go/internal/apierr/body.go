package apierr

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"nexoisp/api-go/internal/jsonx"
)

const BodyLimit = 20 * 1024 * 1024

// DecodeJSON is available to future write routes; phase 1 exposes GET handlers only.
func DecodeJSON(r *http.Request, dst any) error {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return New(415, "Unsupported Media Type")
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, BodyLimit+1))
	if err != nil {
		return err
	}
	if len(b) > BodyLimit {
		return New(413, "Request body is too large")
	}
	if len(b) == 0 {
		return New(400, "Body cannot be empty when content-type is set to 'application/json'")
	}
	if target, ok := dst.(*any); ok {
		var value any
		if err = json.Unmarshal(b, &value); err != nil {
			return New(400, "Body is not valid JSON but content-type is set to 'application/json'")
		}
		*target = jsonx.JSON(b)
		return nil
	}
	if err = json.Unmarshal(b, dst); err != nil {
		return New(400, "Body is not valid JSON but content-type is set to 'application/json'")
	}
	return nil
}

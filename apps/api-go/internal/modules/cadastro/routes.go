package cadastro

import (
	"context"
	"nexoisp/api-go/internal/audit"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/csvx"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
	"strconv"

	"github.com/danielgtaylor/huma/v2"
)

type IDInput struct {
	ID string `path:"id"`
}
type Output struct {
	ContentType string `header:"Content-Type"`
	Total       string `header:"X-Total-Count"`
	Disposition string `header:"Content-Disposition"`
	Body        []byte
}

func Register(api huma.API, s Service, a audit.Writer) {
	for _, kind := range []string{"subscribers", "contracts"} {
		huma.Register(api, huma.Operation{OperationID: "get-" + kind + "-id", Method: "GET", Path: "/api/" + kind + "/{id}", SkipValidateParams: true, SkipValidateBody: true}, func(ctx context.Context, in *IDInput) (*Output, error) {
			if err := validate.UUID(in.ID); err != nil {
				return nil, err
			}
			var value jsonx.Object
			var err error
			if kind == "subscribers" {
				value, err = s.Subscriber(ctx, in.ID)
			} else {
				value, err = s.Contract(ctx, in.ID)
			}
			if err != nil {
				return nil, err
			}
			body, err := jsonx.Encode(value)
			return &Output{ContentType: "application/json; charset=utf-8", Body: body}, err
		})
	}
	huma.Register(api, huma.Operation{OperationID: "get-subscribers", Method: "GET", Path: "/api/subscribers", SkipValidateParams: true, SkipValidateBody: true}, func(ctx context.Context, in *struct{}) (*Output, error) {
		r := httpx.Request(ctx)
		p, err := validate.Parse(r.URL.Query())
		if err != nil {
			return nil, err
		}
		formats := r.URL.Query()["format"]
		csvFormat := len(formats) == 1 && formats[0] == "csv"
		csv := csvFormat && r.Method == "GET"
		rows, total, err := s.List(ctx, p, csvFormat)
		if err != nil {
			return nil, err
		}
		out := &Output{ContentType: "application/json; charset=utf-8", Total: strconv.FormatInt(total, 10)}
		out.Body, err = jsonx.Encode(rows)
		if csv && err == nil {
			err = a.Write(ctx, auth.From(ctx), "export.csv", "list", nil, map[string]any{"path": "/api/subscribers", "rows": len(rows)}, "ok")
			if err == nil {
				out.Body, err = csvx.Auto(rows)
				out.ContentType = "text/csv; charset=utf-8"
				out.Disposition = `attachment; filename="subscribers.csv"`
			}
		}
		return out, err
	})
}

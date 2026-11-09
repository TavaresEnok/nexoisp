package escrita

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image/png"
	"math"
	"net/http"
	"slices"
	"sort"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

const (
	signatureMaxBytes = 1024 * 1024
	signatureMinSide  = 100
	signatureMaxSide  = 4096
)

const visitColumns = `v.id, v.technician_id, u.name as technician_name, v.check_in_at, v.check_in_device_at, v.check_in_accuracy_m, v.check_in_distance_m,
  (v.check_in_latitude is not null) as check_in_located, v.check_out_at, v.check_out_reason, v.check_out_device_at, v.check_out_accuracy_m,
  v.check_out_distance_m, (v.check_out_latitude is not null) as check_out_located,
  greatest(0, extract(epoch from coalesce(v.check_out_at, now()) - v.check_in_at))::bigint as seconds`

const signatureColumns = `s.id, s.document_id, s.signer_name, s.signer_document, s.signed_at, s.device_at, u.name as signed_by_name, d.sha256, d.size_bytes, d.mime`

// fieldBody validates the optional geolocation and idempotency fields shared by check-in and check-out.
func fieldBody() validate.Rule {
	f, n, str := validate.F, validate.Number, validate.String
	return validate.Object(
		f("idempotency_key", str().UUID().Opt()),
		f("device_at", str().Refine(validDateTime, "data e hora do dispositivo inválida").Nullish()),
		f("latitude", n().Min(-90, "latitude entre -90 e 90").Max(90, "latitude entre -90 e 90").Nullish()),
		f("longitude", n().Min(-180, "longitude entre -180 e 180").Max(180, "longitude entre -180 e 180").Nullish()),
		f("accuracy_m", n().Min(0, "precisão não pode ser negativa").Max(100000, "precisão acima de 100 km").Nullish()),
	)
}

// distanceMeters is the haversine distance between two WGS84 points.
func distanceMeters(lat1, lng1, lat2, lng2 float64) float64 {
	const radius = 6371008.8
	rad := math.Pi / 180
	dLat, dLng := (lat2-lat1)*rad, (lng2-lng1)*rad
	a := math.Sin(dLat/2)*math.Sin(dLat/2) + math.Cos(lat1*rad)*math.Cos(lat2*rad)*math.Sin(dLng/2)*math.Sin(dLng/2)
	return math.Round(2*radius*math.Asin(math.Min(1, math.Sqrt(a)))*10) / 10
}

// fieldLocation returns the reported coordinates and the distance to the
// installation, when both are known. Coordinates come in pairs; precision only with them.
func fieldLocation(b map[string]any, site jsonx.Object) (lat, lng, accuracy, distance any, err error) {
	if (b["latitude"] == nil) != (b["longitude"] == nil) {
		return nil, nil, nil, nil, apierr.New(400, "informe latitude e longitude juntas")
	}
	if b["latitude"] == nil {
		if b["accuracy_m"] != nil {
			return nil, nil, nil, nil, apierr.New(400, "precisão informada sem coordenadas")
		}
		return nil, nil, nil, nil, nil
	}
	lat, lng, accuracy = b["latitude"], b["longitude"], b["accuracy_m"]
	if siteLat, ok := site.Get("site_latitude").(float64); ok {
		if siteLng, ok := site.Get("site_longitude").(float64); ok {
			distance = distanceMeters(num(lat), num(lng), siteLat, siteLng)
		}
	}
	return lat, lng, accuracy, distance, nil
}

// fieldOrder locks the OS and tells whether the session user is its assigned
// technician (responsável ou auxiliar). RLS hides OS outside tenant and POP.
func fieldOrder(ctx context.Context, tx *db.Tx, id string, lock bool) (jsonx.Object, error) {
	suffix := ""
	if lock {
		suffix = " for update of w"
	}
	rows, err := tx.Objects(ctx, `select w.id, w.number, w.status, w.subscriber_id, w.contract_id, w.assignee_id,
  c.latitude::float8 as site_latitude, c.longitude::float8 as site_longitude,
  (w.assignee_id is not distinct from $2::uuid or exists (select 1 from work_order_helpers h where h.work_order_id = w.id and h.user_id = $2::uuid)) as assigned
  from work_orders w left join contracts c on c.id = w.contract_id and c.tenant_id = w.tenant_id
  where w.id = $1`+suffix, id, auth.From(ctx).UserID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, apierr.New(404, "ordem de serviço não encontrada")
	}
	return rows[0], nil
}

// fieldAllowed applies the business rule: only the assigned technician or someone with os:write.
func fieldAllowed(ctx context.Context, order jsonx.Object) bool {
	return order.Get("assigned") == true || slices.Contains(auth.From(ctx).Permissions, "os:write")
}

// fieldIdempotent runs a field action at most once per tenant, user and key.
// The receipt stores the original response; the same key with another request is refused.
func fieldIdempotent(ctx context.Context, tx *db.Tx, action, orderID string, body map[string]any, run func() (any, error)) (any, error) {
	key, _ := body["idempotency_key"].(string)
	if key == "" {
		return run()
	}
	c := auth.From(ctx)
	canonical, err := json.Marshal(map[string]any{"action": action, "work_order_id": orderID, "body": body})
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(canonical)
	hash := hex.EncodeToString(sum[:])
	if err = tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1, 30888))`, c.TenantID+":"+c.UserID+":"+key); err != nil {
		return nil, err
	}
	prior, err := tx.Objects(ctx, `select request_sha256, response from field_action_receipts where user_id = $1 and idempotency_key = $2`, c.UserID, key)
	if err != nil {
		return nil, err
	}
	if len(prior) > 0 {
		if prior[0].Get("request_sha256") != hash {
			return nil, apierr.New(409, "chave de idempotência já usada com outro conteúdo")
		}
		return prior[0].Get("response"), nil
	}
	result, err := run()
	if err != nil {
		return nil, err
	}
	encoded, err := jsonx.Encode(result)
	if err != nil {
		return nil, err
	}
	n, err := tx.Affected(ctx, `insert into field_action_receipts (tenant_id, user_id, idempotency_key, action, work_order_id, request_sha256, response) values ($1,$2,$3,$4,$5,$6,$7::json) on conflict do nothing`, c.TenantID, c.UserID, key, action, orderID, hash, string(encoded))
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, apierr.New(409, "chave de idempotência já utilizada")
	}
	return result, nil
}

// closeOpenVisits ends every open presence when the OS is finished, so the
// attendance time does not keep growing after conclusion or cancellation.
func closeOpenVisits(ctx context.Context, tx *db.Tx, id string) error {
	n, err := tx.Affected(ctx, `update work_order_visits set check_out_at = greatest(now(), check_in_at), check_out_by = $2, check_out_reason = 'os_finished' where work_order_id = $1 and check_out_at is null`, id, auth.From(ctx).UserID)
	if err != nil || n == 0 {
		return err
	}
	return workEvent(ctx, tx, id, "visits_closed", map[string]any{"count": n})
}

// attendanceSeconds merges overlapping presences: two technicians on site at
// the same time count once in the OS attendance time.
func attendanceSeconds(items []jsonx.Object, now time.Time) int64 {
	type span struct{ start, end time.Time }
	spans := []span{}
	for _, item := range items {
		start, ok := item.Get("check_in_at").(jsonx.Time)
		if !ok {
			continue
		}
		end := now
		if out, ok := item.Get("check_out_at").(jsonx.Time); ok {
			end = out.Time
		}
		if end.After(start.Time) {
			spans = append(spans, span{start.Time, end})
		}
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].start.Before(spans[j].start) })
	var total time.Duration
	var current *span
	for i := range spans {
		s := spans[i]
		if current != nil && !s.start.After(current.end) {
			if s.end.After(current.end) {
				current.end = s.end
			}
			continue
		}
		if current != nil {
			total += current.end.Sub(current.start)
		}
		current = &s
	}
	if current != nil {
		total += current.end.Sub(current.start)
	}
	return int64(total / time.Second)
}

func (s Service) checkIn(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	return fieldIdempotent(ctx, tx, "check_in", id, b, func() (any, error) {
		order, err := fieldOrder(ctx, tx, id, true)
		if err != nil {
			return nil, err
		}
		if !fieldAllowed(ctx, order) {
			return nil, apierr.New(403, "apenas o técnico atribuído ou quem altera OS registra presença")
		}
		status := order.Get("status")
		if finished(status) {
			return nil, apierr.New(409, "ordem de serviço encerrada não aceita check-in")
		}
		if status == "awaiting_schedule" {
			return nil, apierr.New(409, "ordem aguardando agendamento: defina a data antes do check-in")
		}
		c := auth.From(ctx)
		open, err := tx.Objects(ctx, `select id from work_order_visits where work_order_id = $1 and technician_id = $2 and check_out_at is null`, id, c.UserID)
		if err != nil {
			return nil, err
		}
		if len(open) > 0 {
			return nil, apierr.New(409, "você já tem check-in aberto nesta OS")
		}
		lat, lng, accuracy, distance, err := fieldLocation(b, order)
		if err != nil {
			return nil, err
		}
		inserted, err := tx.Objects(ctx, `insert into work_order_visits (tenant_id, work_order_id, technician_id, check_in_device_at, check_in_latitude, check_in_longitude, check_in_accuracy_m, check_in_distance_m)
  values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`, c.TenantID, id, c.UserID, b["device_at"], lat, lng, accuracy, distance)
		if err != nil {
			return nil, err
		}
		visit := inserted[0].Get("id")
		if status != "in_progress" {
			// The arrival starts execution through the same transition as "Iniciar execução".
			if _, err = s.workStatus(ctx, tx, id, map[string]any{"status": "in_progress"}); err != nil {
				return nil, err
			}
		}
		detail := map[string]any{"visit_id": visit, "located": lat != nil}
		if distance != nil {
			detail["distance_m"] = distance
		}
		if b["device_at"] != nil {
			detail["device_at"] = b["device_at"]
		}
		if err = workEvent(ctx, tx, id, "check_in", detail); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, "work_order.check_in", "work_order", id, detail); err != nil {
			return nil, err
		}
		return visitByID(ctx, tx, visit)
	})
}

func (s Service) checkOut(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	return fieldIdempotent(ctx, tx, "check_out", id, b, func() (any, error) {
		order, err := fieldOrder(ctx, tx, id, true)
		if err != nil {
			return nil, err
		}
		if !fieldAllowed(ctx, order) {
			return nil, apierr.New(403, "apenas o técnico atribuído ou quem altera OS registra presença")
		}
		c := auth.From(ctx)
		open, err := tx.Objects(ctx, `select id from work_order_visits where work_order_id = $1 and technician_id = $2 and check_out_at is null for update`, id, c.UserID)
		if err != nil {
			return nil, err
		}
		if len(open) == 0 {
			return nil, apierr.New(409, "não há check-in aberto seu nesta OS")
		}
		lat, lng, accuracy, distance, err := fieldLocation(b, order)
		if err != nil {
			return nil, err
		}
		visit := open[0].Get("id")
		if err = tx.Exec(ctx, `update work_order_visits set check_out_at = greatest(now(), check_in_at), check_out_by = $2, check_out_reason = 'technician', check_out_device_at = $3,
  check_out_latitude = $4, check_out_longitude = $5, check_out_accuracy_m = $6, check_out_distance_m = $7 where id = $1`, visit, c.UserID, b["device_at"], lat, lng, accuracy, distance); err != nil {
			return nil, err
		}
		row, err := visitByID(ctx, tx, visit)
		if err != nil {
			return nil, err
		}
		detail := map[string]any{"visit_id": visit, "located": lat != nil, "seconds": row.Get("seconds")}
		if distance != nil {
			detail["distance_m"] = distance
		}
		if b["device_at"] != nil {
			detail["device_at"] = b["device_at"]
		}
		if err = workEvent(ctx, tx, id, "check_out", detail); err != nil {
			return nil, err
		}
		return row, record(ctx, tx, "work_order.check_out", "work_order", id, detail)
	})
}

func visitByID(ctx context.Context, tx *db.Tx, visit any) (jsonx.Object, error) {
	rows, err := tx.Objects(ctx, `select `+visitColumns+` from work_order_visits v join users u on u.id = v.technician_id where v.id = $1`, visit)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, apierr.New(404, "presença não encontrada")
	}
	return rows[0], nil
}

func (s Service) visits(ctx context.Context, tx *db.Tx, id string) (any, error) {
	order, err := fieldOrder(ctx, tx, id, false)
	if err != nil {
		return nil, err
	}
	items, err := tx.Objects(ctx, `select `+visitColumns+` from work_order_visits v join users u on u.id = v.technician_id where v.work_order_id = $1 order by v.check_in_at, v.id`, id)
	if err != nil {
		return nil, err
	}
	var now time.Time
	if err = tx.QueryRow(ctx, `select now()`).Scan(&now); err != nil {
		return nil, err
	}
	user := auth.From(ctx).UserID
	var open any
	for _, item := range items {
		if item.Get("technician_id") == user && item.Get("check_out_at") == nil {
			open = item.Get("id")
		}
	}
	allowed := fieldAllowed(ctx, order)
	status := order.Get("status")
	_, located := order.Get("site_latitude").(float64)
	return map[string]any{
		"items":              items,
		"open_visit_id":      open,
		"attendance_seconds": attendanceSeconds(items, now),
		"site_located":       located,
		"server_time":        jsonx.Time{Time: now},
		"can_check_in":       allowed && open == nil && !finished(status) && status != "awaiting_schedule",
		"can_check_out":      allowed && open != nil,
	}, nil
}

// signatureContent accepts only a PNG of plausible dimensions and size.
func signatureContent(encoded string) ([]byte, error) {
	if len(encoded) > base64.StdEncoding.EncodedLen(signatureMaxBytes) {
		return nil, apierr.New(400, "assinatura acima de 1 MiB")
	}
	content, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || base64.StdEncoding.EncodeToString(content) != encoded || len(content) == 0 {
		return nil, apierr.New(400, "conteúdo base64 da assinatura inválido")
	}
	if len(content) > signatureMaxBytes {
		return nil, apierr.New(400, "assinatura acima de 1 MiB")
	}
	if !bytes.HasPrefix(content, []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}) {
		return nil, apierr.New(400, "a assinatura deve ser uma imagem PNG")
	}
	config, err := png.DecodeConfig(bytes.NewReader(content))
	if err != nil {
		return nil, apierr.New(400, "a assinatura deve ser uma imagem PNG")
	}
	if config.Width < signatureMinSide || config.Height < signatureMinSide/2 || config.Width > signatureMaxSide || config.Height > signatureMaxSide {
		return nil, apierr.New(400, fmt.Sprintf("dimensões da assinatura fora do limite (%d a %d px)", signatureMinSide, signatureMaxSide))
	}
	return content, nil
}

func signatureSchema() validate.Rule {
	f, str := validate.F, validate.String
	return validate.Object(
		f("signer_name", str().Trimmed().Min(2, "informe o nome de quem assina").Max(120)),
		f("signer_document", str().Trimmed().Pattern(`^[0-9A-Za-z./ -]{3,30}$`, "documento: 3 a 30 letras, números, . / -").Nullish()),
		f("content_base64", str().Min(1).Max(float64(base64.StdEncoding.EncodedLen(signatureMaxBytes)+4))),
		f("device_at", str().Refine(validDateTime, "data e hora do dispositivo inválida").Nullish()),
	)
}

func (s Service) signature(ctx context.Context, tx *db.Tx, id string, method string, image bool, b map[string]any, content []byte) (endpoint.Result, error) {
	// Same lock order as attachments: subscriber (quota and anonymization) then OS.
	lock := ""
	if method == "POST" {
		lock = " for no key update of s"
	}
	parents, err := tx.Objects(ctx, `select s.id, s.anonymized_at from subscribers s join work_orders w on w.subscriber_id = s.id and w.tenant_id = s.tenant_id where w.id = $1`+lock, id)
	if err != nil {
		return endpoint.Result{}, err
	}
	if len(parents) == 0 {
		return endpoint.Result{}, apierr.New(404, "ordem de serviço não encontrada")
	}
	order, err := fieldOrder(ctx, tx, id, method == "POST")
	if err != nil {
		return endpoint.Result{}, err
	}
	open := !finished(order.Get("status")) && parents[0].Get("anonymized_at") == nil
	current, err := tx.Objects(ctx, `select `+signatureColumns+` from work_order_signatures s join documents d on d.id = s.document_id and d.tenant_id = s.tenant_id
  left join users u on u.id = s.signed_by where s.work_order_id = $1 and d.deleted_at is null`, id)
	if err != nil {
		return endpoint.Result{}, err
	}
	if method == "GET" && image {
		if len(current) == 0 {
			return endpoint.Result{}, apierr.New(404, "assinatura não encontrada")
		}
		doc := current[0].Get("document_id")
		rows, err := tx.Objects(ctx, `select content from documents where id = $1 and work_order_id = $2 and kind = 'signature' and deleted_at is null`, doc, id)
		if err != nil {
			return endpoint.Result{}, err
		}
		if len(rows) == 0 {
			return endpoint.Result{}, apierr.New(404, "assinatura não encontrada")
		}
		result := endpoint.Result{Raw: rows[0].Get("content").([]byte), ContentType: "image/png", CacheControl: "private, no-store", CSP: "default-src 'none'; sandbox", Disposition: "inline; filename=\"assinatura.png\""}
		return result, record(ctx, tx, "document.download", "document", doc, map[string]any{"subscriber_id": order.Get("subscriber_id"), "work_order_id": id, "kind": "signature"})
	}
	if method == "GET" {
		var value any
		if len(current) > 0 {
			value = current[0]
		}
		return endpoint.Result{Value: map[string]any{"signature": value, "can_sign": open && len(current) == 0 && fieldAllowed(ctx, order)}}, nil
	}
	if !fieldAllowed(ctx, order) {
		return endpoint.Result{}, apierr.New(403, "apenas o técnico atribuído ou quem altera OS registra a assinatura")
	}
	if !open {
		return endpoint.Result{}, apierr.New(409, "ordem encerrada ou assinante anonimizado não aceita nova assinatura")
	}
	if len(current) > 0 {
		return endpoint.Result{}, apierr.New(409, "esta OS já tem assinatura do cliente registrada")
	}
	counts, err := tx.Objects(ctx, `select count(*)::int as total, count(*) filter (where work_order_id = $2)::int as os_total from documents where subscriber_id = $1 and deleted_at is null`, order.Get("subscriber_id"), id)
	if err != nil {
		return endpoint.Result{}, err
	}
	if num(counts[0].Get("total")) >= 50 || num(counts[0].Get("os_total")) >= 20 {
		return endpoint.Result{}, apierr.New(409, "limite de documentos atingido")
	}
	c := auth.From(ctx)
	sum := sha256.Sum256(content)
	hash := hex.EncodeToString(sum[:])
	docs, err := tx.Objects(ctx, `insert into documents (tenant_id, subscriber_id, contract_id, work_order_id, kind, name, mime, size_bytes, sha256, content, created_by)
  values ($1,$2,$3,$4,'signature',$5,'image/png',$6,$7,$8,$9) returning id`, c.TenantID, order.Get("subscriber_id"), order.Get("contract_id"), id, fmt.Sprintf("assinatura-os-%v.png", order.Get("number")), len(content), hash, content, c.UserID)
	if err != nil {
		return endpoint.Result{}, err
	}
	doc := docs[0].Get("id")
	if err = tx.Exec(ctx, `insert into work_order_signatures (tenant_id, work_order_id, document_id, signer_name, signer_document, device_at, signed_by) values ($1,$2,$3,$4,$5,$6,$7)`,
		c.TenantID, id, doc, b["signer_name"], b["signer_document"], b["device_at"], c.UserID); err != nil {
		return endpoint.Result{}, err
	}
	detail := map[string]any{"document_id": doc, "sha256": hash}
	if err = workEvent(ctx, tx, id, "signature", detail); err != nil {
		return endpoint.Result{}, err
	}
	if err = record(ctx, tx, "work_order.signature", "work_order", id, map[string]any{"document_id": doc, "subscriber_id": order.Get("subscriber_id"), "sha256": hash, "size_bytes": len(content)}); err != nil {
		return endpoint.Result{}, err
	}
	rows, err := tx.Objects(ctx, `select `+signatureColumns+` from work_order_signatures s join documents d on d.id = s.document_id and d.tenant_id = s.tenant_id
  left join users u on u.id = s.signed_by where s.work_order_id = $1`, id)
	if err != nil {
		return endpoint.Result{}, err
	}
	return endpoint.Result{Value: rows[0]}, nil
}

func registerWorkOrderField(api huma.API, registry *endpoint.Registry, s Service) {
	base := "/api/work-orders/{id}"
	// os:read opens the route; the handler then requires the assigned technician or os:write.
	for _, route := range []struct{ method, path string }{{"GET", base + "/visits"}, {"POST", base + "/check-in"}, {"POST", base + "/check-out"}, {"GET", base + "/signature"}, {"POST", base + "/signature"}, {"GET", base + "/signature/image"}} {
		route := route
		registry.Handle(api, route.method, route.path, "os:read", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			id := chi.URLParam(r, "id")
			if err := validate.UUID(id); err != nil {
				return endpoint.Result{}, err
			}
			if auth.From(ctx).UserID == "" {
				return endpoint.Result{}, apierr.New(403, "trabalho de campo exige sessão de usuário")
			}
			var body map[string]any
			var content []byte
			if route.method == "POST" {
				var raw any
				if err := apierr.DecodeJSON(r, &raw); err != nil {
					return endpoint.Result{}, err
				}
				schema := fieldBody()
				if route.path == base+"/signature" {
					schema = signatureSchema()
				}
				var err error
				if body, err = schema.Parse(raw, true); err != nil {
					return endpoint.Result{}, err
				}
				if route.path == base+"/signature" {
					if content, err = signatureContent(body["content_base64"].(string)); err != nil {
						return endpoint.Result{}, err
					}
					delete(body, "content_base64")
				}
			}
			var result endpoint.Result
			err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
				var value any
				var err error
				switch route.path {
				case base + "/visits":
					value, err = s.visits(ctx, tx, id)
				case base + "/check-in":
					value, err = s.checkIn(ctx, tx, id, body)
				case base + "/check-out":
					value, err = s.checkOut(ctx, tx, id, body)
				default:
					result, err = s.signature(ctx, tx, id, route.method, route.path == base+"/signature/image", body, content)
					return err
				}
				result = endpoint.Result{Value: value}
				return err
			})
			return result, err
		})
	}
}

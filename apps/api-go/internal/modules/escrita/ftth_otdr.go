package escrita

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

// Medições OTDR por cabo e fibra. O arquivo bruto (.sor ou outro) fica em
// bytea, como os anexos privados de OS, e só sai por download autenticado.

const otdrCols = `o.id,o.cable_id,o.fiber,o.measured_on,o.wavelength_nm,o.total_distance_m,o.total_loss_db,o.events,o.technician,o.notes,o.file_name,o.file_size,o.file_sha256,o.created_at`
const otdrMaxFile = 5 * 1024 * 1024

var otdrEventTypes = map[string]bool{"splice": true, "connector": true, "bend": true, "reflection": true, "break": true, "end": true, "other": true}
var unsafeFileName = regexp.MustCompile(`[\\/\x00-\x1f"<>|:*?]`)

type otdrEvent struct {
	DistanceM float64 `json:"distance_m"`
	LossDB    float64 `json:"loss_db"`
	Type      string  `json:"type"`
}

// decodeUpload aceita base64 estrito de até 5 MB, sem impor formato ao conteúdo.
func decodeUpload(encoded string) ([]byte, error) {
	if len(encoded) > 6990508 {
		return nil, apierr.New(400, "arquivo acima de 5 MB")
	}
	content, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || base64.StdEncoding.EncodeToString(content) != encoded {
		return nil, apierr.New(400, "conteúdo base64 inválido")
	}
	if len(content) == 0 {
		return nil, apierr.New(400, "arquivo vazio")
	}
	if len(content) > otdrMaxFile {
		return nil, apierr.New(400, "arquivo acima de 5 MB")
	}
	return content, nil
}

func otdrBody(r *http.Request) (map[string]any, []byte, error) {
	b, err := strictBody(r)
	if err != nil {
		return nil, nil, err
	}
	bad := func(label string) error { return apierr.New(400, "dados de medição inválidos: "+label) }
	out := map[string]any{"notes": "", "file_name": nil}
	var content []byte
	var events []otdrEvent
	for k, v := range b {
		switch k {
		case "fiber":
			n, ok := rawInt(v, 1, 288)
			if !ok {
				return nil, nil, bad("fibra (1 a 288)")
			}
			out[k] = n
		case "wavelength_nm":
			n, ok := rawInt(v, 1310, 1625)
			if !ok || (n != 1310 && n != 1550 && n != 1625) {
				return nil, nil, bad("comprimento de onda (1310, 1550 ou 1625 nm)")
			}
			out[k] = n
		case "total_distance_m":
			f, ok := rawNumber(v)
			if !ok || f <= 0 || f > 300000 {
				return nil, nil, bad("distância total (até 300 km)")
			}
			out[k] = f
		case "total_loss_db":
			f, ok := rawNumber(v)
			if !ok || f < 0 || f > 100 {
				return nil, nil, bad("perda total (0 a 100 dB)")
			}
			out[k] = f
		case "measured_on":
			s, ok := rawString(v)
			day, e := time.Parse("2006-01-02", s)
			if !ok || e != nil || day.Format("2006-01-02") != s || day.Year() < 2000 || day.After(time.Now().UTC().Add(24*time.Hour)) {
				return nil, nil, bad("data da medição (AAAA-MM-DD, até hoje)")
			}
			out[k] = s
		case "technician", "notes", "file_name":
			if k == "file_name" && string(v) == "null" {
				continue
			}
			s, ok := rawString(v)
			s = strings.TrimSpace(s)
			n := utf8.RuneCountInString(s)
			if !ok || (k == "technician" && (n < 2 || n > 120)) || (k == "notes" && n > 500) || (k == "file_name" && (n < 1 || n > 120)) {
				return nil, nil, bad(map[string]string{"technician": "técnico (2 a 120 caracteres)", "notes": "observações (até 500 caracteres)", "file_name": "nome do arquivo (até 120 caracteres)"}[k])
			}
			if k == "file_name" {
				s = unsafeFileName.ReplaceAllString(s, "_")
			}
			out[k] = s
		case "file_content_base64":
			if string(v) == "null" {
				continue
			}
			s, ok := rawString(v)
			if !ok {
				return nil, nil, bad("arquivo")
			}
			if content, err = decodeUpload(s); err != nil {
				return nil, nil, err
			}
		case "events":
			var raw []map[string]json.RawMessage
			if json.Unmarshal(v, &raw) != nil || raw == nil || len(raw) > 200 {
				return nil, nil, bad("eventos (lista de até 200)")
			}
			for i, item := range raw {
				d, okD := rawNumber(item["distance_m"])
				l, okL := rawNumber(item["loss_db"])
				t, okT := rawString(item["type"])
				if len(item) != 3 || item["distance_m"] == nil || item["loss_db"] == nil || !okD || !okL || !okT || d < 0 || l < -5 || l > 30 || !otdrEventTypes[t] {
					return nil, nil, bad(fmt.Sprintf("evento %d (distância, perda de -5 a 30 dB e tipo)", i+1))
				}
				events = append(events, otdrEvent{d, l, t})
			}
		default:
			return nil, nil, bad("campo desconhecido")
		}
	}
	for _, k := range []string{"fiber", "measured_on", "wavelength_nm", "total_distance_m", "total_loss_db", "technician"} {
		if _, ok := out[k]; !ok {
			return nil, nil, bad("informe fibra, data, comprimento de onda, distância, perda e técnico")
		}
	}
	if (out["file_name"] == nil) != (content == nil) {
		return nil, nil, bad("envie o nome e o conteúdo do arquivo juntos")
	}
	if events == nil {
		events = []otdrEvent{}
	}
	for i, ev := range events {
		if ev.DistanceM > num(out["total_distance_m"]) {
			return nil, nil, bad(fmt.Sprintf("evento %d além da distância total", i+1))
		}
	}
	sort.SliceStable(events, func(i, j int) bool { return events[i].DistanceM < events[j].DistanceM })
	encoded, err := json.Marshal(events)
	if err != nil {
		return nil, nil, err
	}
	out["events"] = string(encoded)
	return out, content, nil
}

func registerFTTHOTDR(api huma.API, registry *endpoint.Registry, s Service) {
	base := "/api/ftth/cables/{id}/otdr"
	for _, route := range []struct{ method, path, permission string }{{"GET", base, "network:read"}, {"POST", base, "network:write"}, {"GET", base + "/{measurementId}/file", "network:read"}} {
		route := route
		registry.Handle(api, route.method, route.path, route.permission, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			actor, err := siteActor(ctx)
			if err != nil {
				return endpoint.Result{}, err
			}
			id, mid := chi.URLParam(r, "id"), chi.URLParam(r, "measurementId")
			if err = validate.UUID(id); err != nil {
				return endpoint.Result{}, err
			}
			if mid != "" {
				if err = validate.UUID(mid); err != nil {
					return endpoint.Result{}, err
				}
			}
			var body map[string]any
			var content []byte
			if route.method == "POST" {
				if body, content, err = otdrBody(r); err != nil {
					return endpoint.Result{}, err
				}
			}
			var result endpoint.Result
			err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
				lock := ""
				if route.method == "POST" {
					lock = " for share"
				}
				cables, e := tx.Objects(ctx, `select id,pop_id,name,fiber_count,active from ftth_cables where id=$1`+lock, id)
				if e != nil {
					return e
				}
				if len(cables) == 0 {
					return apierr.New(404, "cabo não encontrado")
				}
				cable := cables[0]
				if mid != "" {
					rows, e := tx.Objects(ctx, `select file_name,file_content from ftth_otdr_measurements where id=$1 and cable_id=$2`, mid, id)
					if e != nil {
						return e
					}
					if len(rows) == 0 || rows[0].Get("file_content") == nil {
						return apierr.New(404, "arquivo da medição não encontrado")
					}
					result = endpoint.Result{Raw: rows[0].Get("file_content").([]byte), ContentType: "application/octet-stream", CacheControl: "private, no-store", CSP: "default-src 'none'; sandbox", Disposition: "attachment; filename*=UTF-8''" + uriComponent(jsonx.String(rows[0].Get("file_name")))}
					return record(ctx, tx, "ftth.otdr_download", "ftth_otdr_measurement", mid, map[string]any{"cable_id": id})
				}
				if route.method == "GET" {
					rows, e := tx.Objects(ctx, `select `+otdrCols+` from ftth_otdr_measurements o where o.cable_id=$1 order by o.measured_on desc,o.created_at desc,o.id`, id)
					if e != nil {
						return e
					}
					result.Value = map[string]any{"cable": cable, "items": rows}
					return nil
				}
				if cable.Get("active") != true {
					return apierr.New(409, "cabo arquivado não recebe novas medições")
				}
				if num(body["fiber"]) > num(cable.Get("fiber_count")) {
					return apierr.New(400, fmt.Sprintf("o cabo tem %g fibra(s)", num(cable.Get("fiber_count"))))
				}
				var size, digest any
				if content != nil {
					sum := sha256.Sum256(content)
					size, digest = len(content), hex.EncodeToString(sum[:])
				}
				rows, e := tx.Objects(ctx, `insert into ftth_otdr_measurements(tenant_id,pop_id,cable_id,fiber,measured_on,wavelength_nm,total_distance_m,total_loss_db,events,technician,notes,file_name,file_size,file_sha256,file_content,created_by) values(app_tenant(),$1,$2,$3,$4::date,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,nullif($15,'')::uuid) returning id`, cable.Get("pop_id"), id, body["fiber"], body["measured_on"], body["wavelength_nm"], body["total_distance_m"], body["total_loss_db"], body["events"], body["technician"], body["notes"], body["file_name"], size, digest, content, auth.From(ctx).UserID)
				if e != nil {
					return e
				}
				created, e := tx.Objects(ctx, `select `+otdrCols+` from ftth_otdr_measurements o where o.id=$1`, rows[0].Get("id"))
				if e != nil {
					return e
				}
				result.Value = created[0]
				return record(ctx, tx, "ftth.otdr_created", "ftth_otdr_measurement", rows[0].Get("id"), map[string]any{"cable_id": id, "fiber": body["fiber"], "wavelength_nm": body["wavelength_nm"], "file_size": size})
			})
			return result, err
		})
	}
}

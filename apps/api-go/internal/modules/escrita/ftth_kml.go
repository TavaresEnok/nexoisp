package escrita

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/validate"
)

// Importação de projeto GIS em KML. A prévia não grava nada; a aplicação
// reprocessa o arquivo no servidor e grava caixas e cabos numa transação única.
// Só a biblioteca padrão é usada: DTD, entidades externas e KMZ são recusados.

const kmlMaxItems = 2000
const kmlMaxDepth = 64
const kmlEndpointMeters = 10.0

type kmlPlacemark struct {
	index    int
	name     string
	geometry string // point, line, other, none
	coords   string
	data     map[string]string
}

func kmlError(message string) error { return apierr.New(400, message) }

// parseKML lê o KML em fluxo. Qualquer diretiva (<!DOCTYPE>, <!ENTITY>) é
// recusada antes de o conteúdo ser interpretado.
func parseKML(content []byte) ([]kmlPlacemark, error) {
	if bytes.HasPrefix(content, []byte("PK\x03\x04")) {
		return nil, kmlError("arquivo KMZ não é aceito; extraia o .kml e envie-o")
	}
	content = bytes.TrimPrefix(content, []byte("\xef\xbb\xbf"))
	if !utf8.Valid(content) {
		return nil, kmlError("o KML deve estar codificado em UTF-8")
	}
	d := xml.NewDecoder(bytes.NewReader(content))
	d.Strict = true
	var stack []string
	var items []kmlPlacemark
	var cur *kmlPlacemark
	var text strings.Builder
	geometries, other, multi := 0, false, 0
	dataName, root := "", false
	for {
		tok, err := d.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, kmlError("KML inválido: XML malformado ou com entidades não permitidas")
		}
		switch t := tok.(type) {
		case xml.Directive:
			return nil, kmlError("KML com DTD ou entidades declaradas não é aceito")
		case xml.StartElement:
			if len(stack) >= kmlMaxDepth {
				return nil, kmlError("KML com aninhamento excessivo")
			}
			name := t.Name.Local
			if len(stack) == 0 {
				if root || name != "kml" {
					return nil, kmlError("o arquivo não é um documento KML")
				}
				root = true
			}
			stack = append(stack, name)
			text.Reset()
			if name == "Placemark" {
				if cur != nil {
					return nil, kmlError("KML inválido: marcador dentro de marcador")
				}
				if len(items) >= kmlMaxItems {
					return nil, kmlError(fmt.Sprintf("o KML tem mais de %d marcadores", kmlMaxItems))
				}
				cur = &kmlPlacemark{index: len(items) + 1, data: map[string]string{}}
				geometries, other, multi = 0, false, 0
				continue
			}
			if cur == nil {
				continue
			}
			switch name {
			case "Point", "LineString":
				geometries++
				if multi > 0 {
					other = true
				}
				if name == "Point" {
					cur.geometry = "point"
				} else {
					cur.geometry = "line"
				}
			case "MultiGeometry":
				multi++
				other = true
			case "Polygon", "LinearRing", "Model", "Track", "MultiTrack":
				other = true
			case "Data", "SimpleData":
				dataName = ""
				for _, a := range t.Attr {
					if a.Name.Local == "name" {
						dataName = strings.ToLower(strings.TrimSpace(a.Value))
					}
				}
			}
		case xml.CharData:
			if cur != nil {
				if text.Len()+len(t) > 1<<20 {
					return nil, kmlError("KML com texto acima do limite em um marcador")
				}
				text.Write(t)
			}
		case xml.EndElement:
			name := stack[len(stack)-1]
			parent := ""
			if len(stack) > 1 {
				parent = stack[len(stack)-2]
			}
			if cur != nil {
				value := strings.TrimSpace(text.String())
				switch {
				case name == "name" && parent == "Placemark":
					cur.name = value
				case name == "coordinates" && (parent == "Point" || parent == "LineString"):
					cur.coords = value
				case name == "value" && parent == "Data" && dataName != "":
					cur.data[dataName] = value
				case name == "SimpleData" && dataName != "":
					cur.data[dataName] = value
				case name == "MultiGeometry":
					multi--
				case name == "Placemark":
					switch {
					case other || geometries > 1:
						cur.geometry = "other"
					case geometries == 0:
						cur.geometry = "none"
					}
					items = append(items, *cur)
					cur = nil
				}
			}
			stack = stack[:len(stack)-1]
			text.Reset()
		}
	}
	if len(stack) != 0 {
		return nil, kmlError("KML inválido: documento incompleto")
	}
	if !root {
		return nil, kmlError("o arquivo não é um documento KML")
	}
	return items, nil
}

func kmlCoordinates(raw string) ([]ftthPoint, error) {
	fields := strings.Fields(raw)
	if len(fields) == 0 {
		return nil, errors.New("coordenadas ausentes")
	}
	if len(fields) > 500 {
		return nil, errors.New("mais de 500 pontos")
	}
	out := make([]ftthPoint, 0, len(fields))
	for i, tuple := range fields {
		parts := strings.Split(tuple, ",")
		if len(parts) < 2 || len(parts) > 3 {
			return nil, fmt.Errorf("coordenada %d inválida", i+1)
		}
		lng, e1 := strconv.ParseFloat(parts[0], 64)
		lat, e2 := strconv.ParseFloat(parts[1], 64)
		if e1 != nil || e2 != nil || math.IsInf(lat, 0) || math.IsInf(lng, 0) || !validPoint(lat, lng) {
			return nil, fmt.Errorf("coordenada %d fora dos limites", i+1)
		}
		if len(parts) == 3 {
			if _, e := strconv.ParseFloat(parts[2], 64); e != nil {
				return nil, fmt.Errorf("altitude %d inválida", i+1)
			}
		}
		out = append(out, ftthPoint{lat, lng})
	}
	return out, nil
}

type kmlOptions struct {
	pop, fileName, boxKind, cableKind string
	boxPorts, cableFibers             int
	content                           []byte
}

func kmlRequest(r *http.Request) (kmlOptions, error) {
	b, err := strictBody(r)
	if err != nil {
		return kmlOptions{}, err
	}
	bad := func(label string) error { return apierr.New(400, "importação inválida: "+label) }
	var o kmlOptions
	for k, v := range b {
		switch k {
		case "pop_id", "file_name", "box_kind", "cable_kind", "content_base64":
			s, ok := rawString(v)
			if !ok {
				return o, bad(k)
			}
			switch k {
			case "pop_id":
				if validate.UUID(s) != nil {
					return o, bad("POP")
				}
				o.pop = s
			case "file_name":
				s = strings.TrimSpace(s)
				if n := utf8.RuneCountInString(s); n < 1 || n > 120 {
					return o, bad("nome do arquivo")
				}
				if strings.HasSuffix(strings.ToLower(s), ".kmz") {
					return o, kmlError("arquivo KMZ não é aceito; extraia o .kml e envie-o")
				}
				o.fileName = unsafeFileName.ReplaceAllString(s, "_")
			case "box_kind":
				if s != "cto" && s != "ceo" {
					return o, bad("tipo padrão de caixa")
				}
				o.boxKind = s
			case "cable_kind":
				if s != "aerial" && s != "underground" && s != "drop" {
					return o, bad("tipo padrão de cabo")
				}
				o.cableKind = s
			case "content_base64":
				if o.content, err = decodeUpload(s); err != nil {
					return o, err
				}
			}
		case "box_ports":
			n, ok := rawInt(v, 1, 144)
			if !ok {
				return o, bad("portas padrão da caixa (1 a 144)")
			}
			o.boxPorts = n
		case "cable_fibers":
			n, ok := rawInt(v, 1, 288)
			if !ok {
				return o, bad("fibras padrão do cabo (1 a 288)")
			}
			o.cableFibers = n
		default:
			return o, bad("campo desconhecido")
		}
	}
	if o.pop == "" || o.fileName == "" || o.boxKind == "" || o.cableKind == "" || o.boxPorts == 0 || o.cableFibers == 0 || o.content == nil {
		return o, bad("informe POP, arquivo e padrões de caixa e cabo")
	}
	return o, nil
}

type kmlBox struct {
	Index     int      `json:"index"`
	Name      string   `json:"name"`
	Kind      string   `json:"kind"`
	Ports     int      `json:"ports"`
	Latitude  *float64 `json:"latitude"`
	Longitude *float64 `json:"longitude"`
	Errors    []string `json:"errors"`
}
type kmlCable struct {
	Index      int         `json:"index"`
	Name       string      `json:"name"`
	Kind       string      `json:"kind"`
	FiberCount int         `json:"fiber_count"`
	Points     int         `json:"points"`
	Path       []ftthPoint `json:"path"`
	Length     float64     `json:"computed_length_m"`
	ABox       *string     `json:"a_box_name"`
	BBox       *string     `json:"b_box_name"`
	Errors     []string    `json:"errors"`
}
type kmlIgnored struct {
	Index  int    `json:"index"`
	Name   string `json:"name"`
	Reason string `json:"reason"`
}
type kmlPlan struct {
	Boxes   []kmlBox     `json:"boxes"`
	Cables  []kmlCable   `json:"cables"`
	Ignored []kmlIgnored `json:"ignored"`
	Valid   bool         `json:"valid"`
	SHA256  string       `json:"sha256"`
	File    string       `json:"file_name"`
	Pop     string       `json:"pop_id"`
}

func kmlData(data map[string]string, keys ...string) (string, bool) {
	for _, k := range keys {
		if v, ok := data[k]; ok {
			return strings.ToLower(strings.TrimSpace(v)), true
		}
	}
	return "", false
}

// buildKMLPlan transforma marcadores em candidatos e confere nomes já usados.
func buildKMLPlan(ctx context.Context, tx *db.Tx, o kmlOptions, marks []kmlPlacemark) (kmlPlan, error) {
	sum := sha256.Sum256(o.content)
	plan := kmlPlan{Boxes: []kmlBox{}, Cables: []kmlCable{}, Ignored: []kmlIgnored{}, SHA256: hex.EncodeToString(sum[:]), File: o.fileName, Pop: o.pop}
	boxNames, cableNames := map[string]bool{}, map[string]bool{}
	for _, m := range marks {
		switch m.geometry {
		case "point":
			box := kmlBox{Index: m.index, Name: m.name, Kind: o.boxKind, Ports: o.boxPorts, Errors: []string{}}
			if n := utf8.RuneCountInString(m.name); n < 2 || n > 80 {
				box.Errors = append(box.Errors, "nome da caixa deve ter de 2 a 80 caracteres")
			} else if boxNames[m.name] {
				box.Errors = append(box.Errors, "nome repetido no arquivo")
			}
			boxNames[m.name] = true
			if v, ok := kmlData(m.data, "tipo", "kind"); ok {
				if v != "cto" && v != "ceo" {
					box.Errors = append(box.Errors, "tipo da caixa deve ser CTO ou CEO")
				} else {
					box.Kind = v
				}
			}
			if v, ok := kmlData(m.data, "portas", "ports"); ok {
				if n, e := strconv.Atoi(v); e != nil || n < 1 || n > 144 {
					box.Errors = append(box.Errors, "portas da caixa devem estar entre 1 e 144")
				} else {
					box.Ports = n
				}
			}
			if pts, e := kmlCoordinates(m.coords); e != nil || len(pts) != 1 {
				if e == nil {
					e = errors.New("ponto com mais de uma coordenada")
				}
				box.Errors = append(box.Errors, e.Error())
			} else {
				lat, lng := math.Round(pts[0].Lat*1e6)/1e6, math.Round(pts[0].Lng*1e6)/1e6
				box.Latitude, box.Longitude = &lat, &lng
			}
			plan.Boxes = append(plan.Boxes, box)
		case "line":
			cable := kmlCable{Index: m.index, Name: m.name, Kind: o.cableKind, FiberCount: o.cableFibers, Path: []ftthPoint{}, Errors: []string{}}
			if n := utf8.RuneCountInString(m.name); n < 2 || n > 120 {
				cable.Errors = append(cable.Errors, "nome do cabo deve ter de 2 a 120 caracteres")
			} else if cableNames[m.name] {
				cable.Errors = append(cable.Errors, "nome repetido no arquivo")
			}
			cableNames[m.name] = true
			if v, ok := kmlData(m.data, "tipo", "kind"); ok {
				kind := map[string]string{"aereo": "aerial", "aéreo": "aerial", "aerial": "aerial", "subterraneo": "underground", "subterrâneo": "underground", "underground": "underground", "drop": "drop"}[v]
				if kind == "" {
					cable.Errors = append(cable.Errors, "tipo do cabo deve ser aéreo, subterrâneo ou drop")
				} else {
					cable.Kind = kind
				}
			}
			if v, ok := kmlData(m.data, "fibras", "fibers"); ok {
				if n, e := strconv.Atoi(v); e != nil || n < 1 || n > 288 {
					cable.Errors = append(cable.Errors, "fibras do cabo devem estar entre 1 e 288")
				} else {
					cable.FiberCount = n
				}
			}
			if pts, e := kmlCoordinates(m.coords); e != nil {
				cable.Errors = append(cable.Errors, e.Error())
			} else if len(pts) < 2 {
				cable.Errors = append(cable.Errors, "o traçado precisa de ao menos 2 pontos")
			} else {
				cable.Path, cable.Points, cable.Length = pts, len(pts), pathLength(pts)
			}
			plan.Cables = append(plan.Cables, cable)
		default:
			reason := "marcador sem geometria"
			if m.geometry == "other" {
				reason = "geometria não suportada (apenas ponto e linha)"
			}
			plan.Ignored = append(plan.Ignored, kmlIgnored{m.index, m.name, reason})
		}
	}
	names := []string{}
	for _, b := range plan.Boxes {
		names = append(names, b.Name)
	}
	if len(names) > 0 {
		rows, err := tx.Objects(ctx, `select name from ftth_boxes where name=any($1::text[])`, names)
		if err != nil {
			return plan, err
		}
		taken := map[string]bool{}
		for _, r := range rows {
			taken[r.Get("name").(string)] = true
		}
		for i := range plan.Boxes {
			if taken[plan.Boxes[i].Name] {
				plan.Boxes[i].Errors = append(plan.Boxes[i].Errors, "já existe caixa com este nome")
			}
		}
	}
	names = []string{}
	for _, c := range plan.Cables {
		names = append(names, c.Name)
	}
	if len(names) > 0 {
		rows, err := tx.Objects(ctx, `select name from ftth_cables where pop_id=$1 and name=any($2::text[])`, o.pop, names)
		if err != nil {
			return plan, err
		}
		taken := map[string]bool{}
		for _, r := range rows {
			taken[r.Get("name").(string)] = true
		}
		for i := range plan.Cables {
			if taken[plan.Cables[i].Name] {
				plan.Cables[i].Errors = append(plan.Cables[i].Errors, "já existe cabo com este nome no POP")
			}
		}
	}
	// Extremidades: caixa importada a até 10 m da primeira ou da última coordenada.
	for i := range plan.Cables {
		c := &plan.Cables[i]
		if len(c.Path) < 2 {
			continue
		}
		c.ABox, c.BBox = kmlNearest(plan.Boxes, c.Path[0]), kmlNearest(plan.Boxes, c.Path[len(c.Path)-1])
	}
	plan.Valid = len(plan.Boxes)+len(plan.Cables) > 0
	for _, b := range plan.Boxes {
		plan.Valid = plan.Valid && len(b.Errors) == 0
	}
	for _, c := range plan.Cables {
		plan.Valid = plan.Valid && len(c.Errors) == 0
	}
	return plan, nil
}

func jsonEncodePath(path []ftthPoint) (string, error) {
	encoded, err := json.Marshal(path)
	return string(encoded), err
}

func kmlNearest(boxes []kmlBox, p ftthPoint) *string {
	var best *string
	distance := kmlEndpointMeters
	for i := range boxes {
		b := &boxes[i]
		if len(b.Errors) > 0 || b.Latitude == nil {
			continue
		}
		if d := haversine(p, ftthPoint{*b.Latitude, *b.Longitude}); d <= distance {
			distance, best = d, &b.Name
		}
	}
	return best
}

func registerFTTHKML(api huma.API, registry *endpoint.Registry, s Service) {
	for _, path := range []string{"/api/ftth/gis/kml/preview", "/api/ftth/gis/kml/apply"} {
		path := path
		registry.Handle(api, "POST", path, "network:write", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			actor, err := siteActor(ctx)
			if err != nil {
				return endpoint.Result{}, err
			}
			o, err := kmlRequest(r)
			if err != nil {
				return endpoint.Result{}, err
			}
			marks, err := parseKML(o.content)
			if err != nil {
				return endpoint.Result{}, err
			}
			var result any
			err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
				if e := sitePop(ctx, tx, o.pop, true); e != nil {
					return e
				}
				plan, e := buildKMLPlan(ctx, tx, o, marks)
				if e != nil {
					return e
				}
				if path == "/api/ftth/gis/kml/preview" {
					result = plan
					return nil
				}
				if len(plan.Boxes)+len(plan.Cables) == 0 {
					return apierr.New(400, "o arquivo não tem caixas nem cabos para importar")
				}
				if !plan.Valid {
					return apierr.New(400, "a importação tem itens com erro; corrija o arquivo e gere nova prévia")
				}
				notes := "Importado do KML " + o.fileName
				if utf8.RuneCountInString(notes) > 500 {
					notes = string([]rune(notes)[:500])
				}
				boxIDs, cableIDs := map[string]string{}, []string{}
				for _, b := range plan.Boxes {
					rows, e := tx.Objects(ctx, `insert into ftth_boxes(tenant_id,name,kind,ports,latitude,longitude,notes) values(app_tenant(),$1,$2,$3,$4,$5,$6) returning id`, b.Name, b.Kind, b.Ports, *b.Latitude, *b.Longitude, notes)
					if e != nil {
						return uniqueViolation(e, map[string]string{"ftth_boxes_tenant_id_name_key": "já existe caixa com o nome " + b.Name})
					}
					boxIDs[b.Name] = rows[0].Get("id").(string)
				}
				for _, c := range plan.Cables {
					encoded, e := jsonEncodePath(c.Path)
					if e != nil {
						return e
					}
					var a, b any
					if c.ABox != nil {
						a = boxIDs[*c.ABox]
					}
					if c.BBox != nil {
						b = boxIDs[*c.BBox]
					}
					minLat, maxLat, minLng, maxLng := pathBounds(c.Path)
					rows, e := tx.Objects(ctx, `insert into ftth_cables(tenant_id,pop_id,name,kind,fiber_count,a_box_id,b_box_id,path,computed_length_m,min_lat,max_lat,min_lng,max_lng,notes) values(app_tenant(),$1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13) returning id`, o.pop, c.Name, c.Kind, c.FiberCount, a, b, encoded, c.Length, minLat, maxLat, minLng, maxLng, notes)
					if e != nil {
						return uniqueViolation(e, cableUnique)
					}
					cableIDs = append(cableIDs, rows[0].Get("id").(string))
				}
				ids := []string{}
				for _, b := range plan.Boxes {
					ids = append(ids, boxIDs[b.Name])
				}
				result = map[string]any{"boxes_created": len(plan.Boxes), "cables_created": len(plan.Cables), "box_ids": ids, "cable_ids": cableIDs, "ignored": len(plan.Ignored)}
				return record(ctx, tx, "ftth.kml_imported", "pop", o.pop, map[string]any{"file_name": o.fileName, "sha256": plan.SHA256, "boxes": len(plan.Boxes), "cables": len(plan.Cables), "ignored": len(plan.Ignored)})
			})
			return endpoint.Result{Value: result}, err
		})
	}
}

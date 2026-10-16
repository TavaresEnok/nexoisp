// Package agent serves the dedicated agent API over direct mutual TLS.
package agent

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/network"
	"nexoisp/api-go/internal/tenancy"
	"nexoisp/api-go/internal/validate"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

//go:embed agentes.json sql/*.sql
var files embed.FS
var queries = func() map[string][]string {
	b, e := files.ReadFile("agentes.json")
	if e != nil {
		panic(e)
	}
	var list []struct {
		Path    string
		Queries []string
	}
	if e = json.Unmarshal(b, &list); e != nil {
		panic(e)
	}
	out := map[string][]string{}
	for _, r := range list {
		out[r.Path] = r.Queries
	}
	return out
}()

func query(key string, index int) string {
	b, e := files.ReadFile("sql/" + queries[key][index])
	if e != nil {
		panic(e)
	}
	return string(b)
}
func one(ctx context.Context, tx *db.Tx, key string, index int, args ...any) (jsonx.Object, error) {
	rs, e := tx.Objects(ctx, query(key, index), args...)
	if len(rs) > 0 {
		return rs[0], e
	}
	return nil, e
}

type Service struct{ DB *db.DB }

func Server(database *db.DB) (*http.Server, error) {
	off := os.Getenv("NEXO_AGENT_MTLS") == "off" && os.Getenv("NODE_ENV") != "production"
	dir := os.Getenv("NEXO_AGENT_TLS_DIR")
	if !off && dir == "" {
		return nil, nil
	}
	addr := os.Getenv("NEXO_GO_AGENT_ADDR")
	if addr == "" {
		addr = ":8443"
	}
	s := &http.Server{Addr: addr, Handler: (Service{DB: database}).Handler(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	if off {
		return s, nil
	}
	cert, e := tls.LoadX509KeyPair(filepath.Join(dir, "server.crt"), filepath.Join(dir, "server.key"))
	if e != nil {
		return nil, e
	}
	ca, e := os.ReadFile(filepath.Join(dir, "ca.crt"))
	if e != nil {
		return nil, e
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, fmt.Errorf("CA de agentes inválida")
	}
	s.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}, ClientCAs: pool, ClientAuth: tls.RequireAndVerifyClientCert}
	return s, nil
}
func (s Service) authenticate(ctx context.Context, r *http.Request) (jsonx.Object, error) {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return nil, apierr.New(401, "agente não autenticado")
	}
	var a jsonx.Object
	e := s.DB.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		var e error
		a, e = one(ctx, tx, "helper:authAgent", 0, cryptox.SHA256(h[7:]))
		return e
	})
	if e != nil {
		return nil, e
	}
	if a == nil || a.Get("status") != "active" {
		return nil, apierr.New(401, "agente desconhecido ou revogado")
	}
	if os.Getenv("NEXO_AGENT_MTLS") == "off" && os.Getenv("NODE_ENV") != "production" {
		return a, nil
	}
	if r.TLS == nil || len(r.TLS.VerifiedChains) == 0 || len(r.TLS.PeerCertificates) == 0 || r.TLS.PeerCertificates[0].Subject.CommonName != "agent:"+a.Get("id").(string) {
		return nil, apierr.New(401, "certificado de cliente não corresponde ao agente")
	}
	hash := sha256.Sum256(r.TLS.PeerCertificates[0].Raw)
	parts := make([]string, len(hash))
	for i, v := range hash {
		parts[i] = strings.ToUpper(hex.EncodeToString([]byte{v}))
	}
	fp := strings.Join(parts, ":")
	scope := tenancy.Scope{TenantID: a.Get("tenant_id").(string)}
	if a.Get("cert_fingerprint") == nil {
		e = s.DB.WithScope(ctx, scope, func(tx *db.Tx) error { return tx.Exec(ctx, query("helper:authAgent", 1), a.Get("id"), fp) })
	} else if a.Get("cert_fingerprint") != fp {
		detail, _ := jsonx.Encode(map[string]any{"presented": fp})
		_ = s.DB.WithScope(ctx, scope, func(tx *db.Tx) error {
			return tx.Exec(ctx, query("helper:authAgent", 2), a.Get("tenant_id"), a.Get("id"), detail)
		})
		return nil, apierr.New(401, "certificado de cliente diferente do fixado para este agente")
	}
	return a, e
}
func (s Service) Handler() http.Handler {
	router := chi.NewRouter()
	for key := range queries {
		if !strings.HasPrefix(key, "/agent/") {
			continue
		}
		router.Post(strings.ReplaceAll(key, ":id", "{id}"), func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			a, e := s.authenticate(ctx, r)
			if e != nil {
				apierr.Write(w, e)
				return
			}
			schema := schemaFor(key)
			body := map[string]any{}
			if schema != nil {
				var raw any
				if e = apierr.DecodeJSON(r, &raw); e == nil {
					body, e = schema.Parse(raw, true)
				}
				if e != nil {
					apierr.Write(w, e)
					return
				}
			}
			id := chi.URLParam(r, "id")
			if id != "" {
				if e = validate.UUID(id); e != nil {
					apierr.Write(w, e)
					return
				}
			}
			var out any
			e = s.DB.WithScope(ctx, tenancy.Scope{TenantID: a.Get("tenant_id").(string)}, func(tx *db.Tx) error { var e error; out, e = s.run(ctx, tx, key, a, id, body); return e })
			if e != nil {
				apierr.Write(w, e)
				return
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			b, e := jsonx.Encode(out)
			if e != nil {
				apierr.Write(w, e)
				return
			}
			_, _ = w.Write(b)
		})
	}
	return router
}
func observation(onu, withID bool) validate.Rule {
	f, str := validate.F, validate.String
	fields := []validate.Field{}
	if withID {
		key := "resource_id"
		if onu {
			key = "onu_id"
		}
		fields = append(fields, f(key, str().UUID()))
	}
	if onu {
		fields = append(fields, f("state", validate.Enum("authorized", "absent")), f("online", validate.Boolean().Nullish()), f("rx_dbm", validate.Number().Min(-60).Max(20).Nullish()), f("tx_dbm", validate.Number().Min(-60).Max(20).Nullish()), f("detail", validate.Any().Opt()))
	} else {
		fields = append(fields, f("policy", validate.Enum("active", "suspended", "absent")), f("profile", str().Nullish()), f("session", validate.Any().Opt()))
	}
	fields = append(fields, f("at", str().Refine(agentDate, "Invalid datetime")))
	return validate.Object(fields...)
}
func agentDate(v any) bool { _, e := time.Parse(time.RFC3339Nano, v.(string)); return e == nil }
func schemaFor(key string) *validate.Rule {
	f, o, str, n, arr := validate.F, validate.Object, validate.String, validate.Number, validate.Array
	uuid := str().UUID()
	checks := arr(o(f("device_id", uuid), f("ok", validate.Boolean()), f("detail", str().Max(500).Opt()), f("at", str()))).Opt()
	var rule validate.Rule
	switch key {
	case "/agent/v1/hello":
		rule = o(f("session_id", str().Min(8).Max(80)), f("version", str().Max(40)), f("info", validate.Record(validate.Any()).Opt()))
	case "/agent/v1/sync-done":
		rule = o(f("session_id", str()), f("observations", arr(observation(false, true)).Max(20000)), f("device_checks", checks))
	case "/agent/v1/poll":
		rule = o(f("session_id", str()))
	case "/agent/v1/attempts/:id/begin":
		return nil
	case "/agent/v1/attempts/:id/progress":
		rule = o(f("status", validate.Enum("EXECUTING", "VERIFYING")), f("steps", arr(validate.Any()).Max(100)))
	case "/agent/v1/attempts/:id/result":
		rule = o(f("outcome", validate.Enum("SUCCEEDED", "FAILED", "NOT_APPLIED")), f("steps", arr(validate.Any()).Max(100)), f("observed", observation(false, false).Opt()), f("onu_observed", observation(true, false).Opt()), f("error", str().Max(1000).Opt()), f("recovered", validate.Boolean().Opt()))
	case "/agent/v1/observations":
		rule = o(f("items", arr(observation(false, true)).Max(20000)), f("device_checks", checks))
	case "/agent/v1/olt-report":
		rule = o(f("device_id", uuid), f("complete", validate.Boolean()), f("unauthorized", arr(o(f("serial", str().Pattern(`^[A-Za-z0-9]{8,20}$`, "Invalid")), f("pon_port", str().Pattern(`^[0-9]{1,3}(/[0-9]{1,3}){0,3}$`, "Invalid")), f("vendor", str().Max(40).Nullish()), f("model", str().Max(60).Nullish()))).Max(5000)), f("states", arr(observation(true, true)).Max(20000)))
	case "/agent/v1/usage-report":
		rule = o(f("device_id", uuid), f("items", arr(o(f("resource_id", uuid), f("month", str().Pattern(`^\d{4}-(0[1-9]|1[0-2])$`, "Invalid")), f("bytes_in", n().Int().Min(0)), f("bytes_out", n().Int().Min(0)), f("session_seconds", n().Int().Min(0)), f("sessions", n().Int().Min(0)))).Max(20000)))
	case "/agent/v1/sessions-report":
		rule = o(f("device_id", uuid), f("items", arr(o(f("resource_id", uuid), f("session_key", str().Min(1).Max(80)), f("started_at", str().Refine(agentDate, "Invalid datetime")), f("stopped_at", str().Refine(agentDate, "Invalid datetime").Nullish()), f("ip", str().Max(45).Nullish()), f("mac", str().Max(40).Nullish()), f("nas_ip", str().Max(45).Nullish()), f("bytes_in", n().Int().Min(0)), f("bytes_out", n().Int().Min(0)), f("seconds", n().Int().Min(0)), f("terminate_cause", str().Max(60).Nullish()))).Max(5000)))
	}
	return &rule
}
func checks(ctx context.Context, tx *db.Tx, a jsonx.Object, b map[string]any) error {
	if values, ok := b["device_checks"].([]any); ok {
		for _, v := range values {
			k := v.(map[string]any)
			encoded, e := jsonx.Encode(map[string]any{"ok": k["ok"], "detail": k["detail"]})
			if e != nil {
				return e
			}
			if e = tx.Exec(ctx, query("helper:saveChecks", 0), k["device_id"], a.Get("id"), k["at"], encoded); e != nil {
				return e
			}
		}
	}
	return nil
}
func (s Service) run(ctx context.Context, tx *db.Tx, key string, a jsonx.Object, id string, b map[string]any) (any, error) {
	agent := a.Get("id").(string)
	tenant := a.Get("tenant_id")
	switch key {
	case "/agent/v1/hello":
		info := b["info"]
		if info == nil {
			info = jsonx.Object{}
		}
		encoded, e := jsonx.Encode(info)
		if e != nil {
			return nil, e
		}
		if e = tx.Exec(ctx, query(key, 0), agent, b["version"], encoded); e != nil {
			return nil, e
		}
		devices, e := tx.Objects(ctx, query(key, 1), agent)
		if e != nil {
			return nil, e
		}
		resources, e := tx.Objects(ctx, query(key, 2), agent)
		if e != nil {
			return nil, e
		}
		onus, e := tx.Objects(ctx, query(key, 3), agent)
		if e != nil {
			return nil, e
		}
		pub, e := cryptox.SigningPublicKey()
		if e != nil {
			return nil, e
		}
		return map[string]any{"agent_id": agent, "tenant_id": tenant, "signing_public_key": pub, "devices": devices, "snapshot": map[string]any{"complete": true, "generated_at": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), "resources": resources, "onus": onus}}, nil
	case "/agent/v1/poll":
		a, e := one(ctx, tx, key, 0, agent)
		if e != nil {
			return nil, e
		}
		if a.Get("sync_session_id") != b["session_id"] {
			return map[string]any{"need_sync": true, "operation": nil}, nil
		}
		op, e := network.Reserve(ctx, tx, agent)
		return map[string]any{"need_sync": false, "operation": op}, e
	case "/agent/v1/attempts/:id/begin":
		return network.Begin(ctx, tx, agent, id)
	case "/agent/v1/attempts/:id/progress":
		return network.Progress(ctx, tx, agent, id, b["status"].(string), b["steps"])
	case "/agent/v1/attempts/:id/result":
		r, e := network.Result(ctx, tx, agent, id, b)
		if e != nil {
			return nil, e
		}
		detail, e := jsonx.Encode(map[string]any{"status": r["status"], "duplicate": r["duplicate"] == true, "recovered": b["recovered"] == true})
		if e != nil {
			return nil, e
		}
		outcome := strings.ToLower(b["outcome"].(string))
		if outcome == "succeeded" {
			outcome = "ok"
		}
		return r, tx.Exec(ctx, query(key, 0), tenant, agent, id, outcome, detail)
	case "/agent/v1/sync-done", "/agent/v1/observations":
		field := "items"
		if strings.HasSuffix(key, "sync-done") {
			field = "observations"
		}
		for _, v := range b[field].([]any) {
			o := v.(map[string]any)
			if e := network.ApplyObservation(ctx, tx, o["resource_id"], o, nil); e != nil {
				return nil, e
			}
		}
		if e := checks(ctx, tx, a, b); e != nil {
			return nil, e
		}
		if field == "observations" {
			if e := tx.Exec(ctx, query(key, 0), agent, b["session_id"]); e != nil {
				return nil, e
			}
		}
		return map[string]any{"ok": true}, nil
	}
	dev, e := one(ctx, tx, key, 0, b["device_id"], agent)
	if e != nil {
		return nil, e
	}
	if dev == nil {
		return nil, apierr.New(404, "equipamento não pertence a este agente")
	}
	if strings.HasSuffix(key, "olt-report") {
		serials := []string{}
		for _, v := range b["unauthorized"].([]any) {
			u := v.(map[string]any)
			serial := strings.ToUpper(u["serial"].(string))
			serials = append(serials, serial)
			if e = tx.Exec(ctx, query(key, 1), tenant, b["device_id"], serial, u["pon_port"], u["vendor"], u["model"]); e != nil {
				return nil, e
			}
		}
		if b["complete"] == true {
			if e = tx.Exec(ctx, query(key, 2), b["device_id"], serials); e != nil {
				return nil, e
			}
		}
		for _, v := range b["states"].([]any) {
			o := v.(map[string]any)
			own, e := one(ctx, tx, key, 3, o["onu_id"], b["device_id"])
			if e != nil {
				return nil, e
			}
			if own != nil {
				if e = network.ApplyOnuObservation(ctx, tx, o["onu_id"], o, nil); e != nil {
					return nil, e
				}
			}
		}
		return map[string]any{"ok": true}, nil
	}
	accepted := int64(0)
	for _, v := range b["items"].([]any) {
		item := v.(map[string]any)
		args := []any{tenant, item["resource_id"]}
		if strings.HasSuffix(key, "usage-report") {
			for _, k := range []string{"month", "bytes_in", "bytes_out", "session_seconds", "sessions"} {
				args = append(args, item[k])
			}
		} else {
			for _, k := range []string{"session_key", "started_at", "stopped_at", "ip", "mac", "nas_ip", "bytes_in", "bytes_out", "seconds", "terminate_cause"} {
				args = append(args, item[k])
			}
		}
		args = append(args, b["device_id"])
		n, e := tx.Affected(ctx, query(key, 1), args...)
		if e != nil {
			return nil, e
		}
		accepted += n
	}
	return map[string]any{"ok": true, "accepted": accepted}, nil
}

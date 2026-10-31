package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"nexoisp/api-go/internal/requestctx"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/fault"

	"github.com/dgraph-io/ristretto/v2"
	"github.com/prometheus/client_golang/prometheus"
)

type routeKey struct{}

func WithRoute(ctx context.Context, route string) context.Context {
	return context.WithValue(ctx, routeKey{}, route)
}

type AuditFunc func(context.Context, *Ctx, string, string, any, map[string]any, string) error
type cacheIndex struct {
	user, tenant string
	expires      time.Time
}
type rateEntry struct {
	minute int64
	n      int
}
type Auth struct {
	loader       Loader
	TTL          time.Duration
	RequireMFA   bool
	Limit        int
	Audit        AuditFunc
	mu           sync.Mutex
	cache        *ristretto.Cache[string, *Ctx]
	epoch        uint64
	online       bool
	index        map[string]cacheIndex
	users        map[string]map[string]struct{}
	tenants      map[string]map[string]struct{}
	lastSweep    time.Time
	rates        map[string]rateEntry
	minute       int64
	Hits, Misses prometheus.Counter
	Invalidation prometheus.Histogram
	Disconnects  prometheus.Counter
	Duration     prometheus.Histogram
	Requests     *prometheus.CounterVec
}

func New(loader Loader, ttl time.Duration, requireMFA bool, limit int, reg prometheus.Registerer) (*Auth, error) {
	cache, err := ristretto.NewCache(&ristretto.Config[string, *Ctx]{NumCounters: 500000, MaxCost: 50000, BufferItems: 64})
	if err != nil {
		return nil, err
	}
	if fault.Active("cache_sem_invalidacao") {
		ttl = 10 * time.Minute
	}
	a := &Auth{loader: loader, TTL: ttl, RequireMFA: requireMFA, Limit: max(30, limit), cache: cache, index: map[string]cacheIndex{}, users: map[string]map[string]struct{}{}, tenants: map[string]map[string]struct{}{}, rates: map[string]rateEntry{}, Hits: prometheus.NewCounter(prometheus.CounterOpts{Name: "nexo_auth_cache_hits_total"}), Misses: prometheus.NewCounter(prometheus.CounterOpts{Name: "nexo_auth_cache_misses_total"}), Invalidation: prometheus.NewHistogram(prometheus.HistogramOpts{Name: "nexo_auth_invalidation_seconds", Buckets: prometheus.ExponentialBuckets(.001, 2, 14)}), Disconnects: prometheus.NewCounter(prometheus.CounterOpts{Name: "nexo_auth_listen_disconnects_total"})}
	a.Duration = prometheus.NewHistogram(prometheus.HistogramOpts{Name: "nexo_auth_transaction_seconds", Buckets: prometheus.DefBuckets})
	a.Requests = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "nexo_tenant_requests_total"}, []string{"tenant", "route", "status", "cell"})
	reg.MustRegister(a.Hits, a.Misses, a.Invalidation, a.Disconnects, a.Duration, a.Requests)
	return a, nil
}
func (a *Auth) Close() { a.cache.Close() }
func (a *Auth) State(online bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.epoch++
	a.clearLocked()
	if a.online && !online {
		a.Disconnects.Inc()
	}
	a.online = online
}
func (a *Auth) Invalidate(n db.Notification) {
	if fault.Active("cache_sem_invalidacao") {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.epoch++
	switch n.Kind {
	case "session":
		a.dropLocked(n.Hash)
	case "user":
		for hash := range a.users[n.User] {
			a.dropLocked(hash)
		}
	case "tenant":
		for hash := range a.tenants[n.Tenant] {
			a.dropLocked(hash)
		}
	case "cell":
		a.clearLocked()
	}
	if !n.At.IsZero() {
		a.Invalidation.Observe(max(0, time.Since(n.At).Seconds()))
	}
}
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// CSRF deriva da sessão o valor exigido em X-Nexo-CSRF quando a sessão vem do
// cookie HttpOnly. A página recebe o valor em /api/me e na resposta do login;
// outro site não consegue lê-lo nem calculá-lo sem o token da sessão.
func CSRF(tokenHash string) string {
	sum := sha256.Sum256([]byte("nexo-csrf\x00" + tokenHash))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// SessionCSRF devolve o valor CSRF de um token de sessão recém-emitido.
func SessionCSRF(token string) string { return CSRF(hashToken(token)) }

func (a *Auth) Load(ctx context.Context, token string) (*Ctx, error) {
	hash := hashToken(token)
	a.mu.Lock()
	epoch := a.epoch
	if a.online && a.TTL > 0 {
		if c, ok := a.cache.Get(hash); ok && c.ExpiresAt.After(time.Now()) {
			a.mu.Unlock()
			a.Hits.Inc()
			return c, nil
		}
	}
	a.mu.Unlock()
	a.Misses.Inc()
	started := time.Now()
	c, err := a.loader.Load(ctx, hash)
	a.Duration.Observe(time.Since(started).Seconds())
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.online && a.TTL > 0 && epoch == a.epoch {
		if len(a.index) >= 50000 {
			a.clearLocked()
		}
		if time.Since(a.lastSweep) > time.Second {
			a.lastSweep = time.Now()
			for h, i := range a.index {
				if !i.expires.After(time.Now()) {
					a.dropLocked(h)
				}
			}
		}
		ttl := min(a.TTL, time.Until(c.ExpiresAt))
		if ttl > 0 {
			a.cache.SetWithTTL(hash, c, 1, ttl)
			a.cache.Wait()
			a.index[hash] = cacheIndex{c.UserID, c.TenantID, time.Now().Add(ttl)}
			if a.users[c.UserID] == nil {
				a.users[c.UserID] = map[string]struct{}{}
			}
			a.users[c.UserID][hash] = struct{}{}
			if a.tenants[c.TenantID] == nil {
				a.tenants[c.TenantID] = map[string]struct{}{}
			}
			a.tenants[c.TenantID][hash] = struct{}{}
		}
	}
	return c, nil
}

var cookieSeparator = regexp.MustCompile(`;\s*`)

func Token(r *http.Request) (string, error) {
	h := r.Header.Get("Authorization")
	token := ""
	if strings.HasPrefix(h, "Bearer ") {
		token = h[7:]
	}
	if token == "" {
		for _, part := range cookieSeparator.Split(r.Header.Get("Cookie"), -1) {
			if strings.HasPrefix(part, "nexo_session=") {
				token = strings.TrimPrefix(part, "nexo_session=")
				break
			}
		}
		if !fault.Active("sem_csrf") && token != "" && r.Method != "GET" && r.Method != "HEAD" && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Nexo-Csrf")), []byte(SessionCSRF(token))) != 1 {
			return "", apierr.New(403, "requisição sem proteção CSRF")
		}
	}
	if token == "" {
		return "", apierr.New(401, "não autenticado")
	}
	return token, nil
}
func (a *Auth) takeRate(ctx context.Context, hash string) (int, int, error) {
	if shared, ok := a.loader.(interface {
		Rate(context.Context, string, int) (int, int, error)
	}); ok {
		return shared.Rate(ctx, hash, a.Limit)
	}
	// In-memory loaders are used by isolated unit tests; DBLoader always uses SQL.
	minute := time.Now().Unix() / 60
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.minute != minute {
		a.minute = minute
		a.rates = map[string]rateEntry{}
	}
	entry := a.rates[hash]
	if entry.minute != minute {
		entry = rateEntry{minute: minute}
	}
	entry.n++
	a.rates[hash] = entry
	return entry.n, 60 - time.Now().Second(), nil
}

func (a *Auth) Guard(ctx context.Context, w http.ResponseWriter, r *http.Request, c *Ctx, perm string, allowMFA bool) error {
	if !fault.Active("limite_desligado") {
		calls, retry, err := a.takeRate(ctx, c.TokenHash)
		if err != nil {
			return err
		}
		if calls > a.Limit {
			w.Header().Set("Retry-After", strconv.Itoa(retry))
			return &apierr.Error{Status: 429, Message: "muitas requisições desta sessão; aguarde um instante", Code: "rate_limited"}
		}
	}
	if !fault.Active("sem_mfa") && a.RequireMFA && (c.Role == "admin" || c.Role == "saas_operator") && !c.MFAEnabled && !allowMFA {
		return &apierr.Error{Status: 403, Message: "configure a verificação em duas etapas para continuar", Code: "mfa_setup_required"}
	}
	if perm != "" && !slices.Contains(c.Permissions, perm) {
		if !fault.Active("sem_auditoria_negativa") && a.Audit != nil {
			_ = a.Audit(ctx, c, "access.denied", "permission", perm, map[string]any{"url": r.URL.RequestURI()}, "denied")
		}
		return apierr.New(403, "sem permissão para esta ação")
	}
	if perm != "" && perm != "tenants:manage" && perm != "portal:self" && c.TenantID == "" {
		return apierr.New(403, "selecione um provedor (acesso de suporte) para esta ação")
	}
	if mods := Modules(r.URL.Path); !fault.Active("sem_modulo") && len(mods) > 0 {
		ok := false
		for _, m := range mods {
			if slices.Contains(c.Modules, m) {
				ok = true
			}
		}
		if !ok {
			return &apierr.Error{Status: 403, Message: "este recurso não está liberado para o provedor", Code: "module_disabled"}
		}
	}
	return nil
}
func (a *Auth) Require(perm string, allowMFA bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorded := &statusWriter{ResponseWriter: w, status: 200}
		w = recorded
		var current *Ctx
		defer func() {
			if current != nil {
				route := "/api/subscribers/:id"
				if r.URL.Path == "/api/subscribers" {
					route = r.URL.Path
				} else if strings.HasPrefix(r.URL.Path, "/api/contracts/") {
					route = "/api/contracts/:id"
				}
				if matched, ok := r.Context().Value(routeKey{}).(string); ok {
					route = matched
				}
				a.Requests.WithLabelValues(current.TenantID, route, strconv.Itoa(recorded.status), current.Scope.Cell).Inc()
			}
		}()
		token, err := Token(r)
		if err != nil {
			apierr.Write(w, err)
			return
		}
		var c *Ctx
		if r.Header.Get("X-Nexo-Context") != "" || r.URL.Path == "/api/me" {
			// A precondição precisa do contexto atual, não de uma entrada de cache
			// que ainda aguarda uma notificação de invalidação.
			c, err = a.loader.Load(r.Context(), hashToken(token))
		} else {
			c, err = a.Load(r.Context(), token)
		}
		current = c
		if c != nil {
			if state := requestctx.From(r.Context()); state != nil {
				state.UserID = c.UserID
				state.TenantID = c.TenantID
			}
		}
		if err == nil {
			marker := ContextMarker(c)
			w.Header().Set("X-Nexo-Context", marker)
			if expected := r.Header.Get("X-Nexo-Context"); expected != "" && subtle.ConstantTimeCompare([]byte(expected), []byte(marker)) != 1 {
				err = &apierr.Error{Status: 409, Message: "contexto da sessão alterado; entre novamente", Code: "session_context_changed"}
			}
		}
		if err == nil {
			err = a.Guard(r.Context(), w, r, c, perm, allowMFA)
		}
		if err != nil {
			apierr.Write(w, err)
			return
		}
		if fault.Active("tenant_do_cabecalho") && r.Header.Get("X-Bench-Tenant") != "" {
			copy := *c
			copy.Scope = c.Scope
			copy.Scope.TenantID = r.Header.Get("X-Bench-Tenant")
			c = &copy
		}
		next.ServeHTTP(w, r.WithContext(With(db.WithCell(r.Context(), c.SessionCell), c)))
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (a *Auth) clearLocked() {
	a.cache.Clear()
	a.index = map[string]cacheIndex{}
	a.users = map[string]map[string]struct{}{}
	a.tenants = map[string]map[string]struct{}{}
}
func (a *Auth) dropLocked(hash string) {
	a.cache.Del(hash)
	if idx, ok := a.index[hash]; ok {
		delete(a.users[idx.user], hash)
		if len(a.users[idx.user]) == 0 {
			delete(a.users, idx.user)
		}
		delete(a.tenants[idx.tenant], hash)
		if len(a.tenants[idx.tenant]) == 0 {
			delete(a.tenants, idx.tenant)
		}
	}
	delete(a.index, hash)
}

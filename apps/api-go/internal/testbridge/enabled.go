//go:build contractbridge

package testbridge

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
)

var mu sync.Mutex
var names = []string{"NEXO_DEMO_MODE", "NEXO_REQUIRE_ADMIN_MFA", "NEXO_PANEL_RATE_PER_MIN", "NEXO_TRUST_PROXY", "NEXO_ACS_URL", "NEXO_RADIUS_KEY", "NEXO_RADIUS_PUBLIC_HOST", "NEXO_RADIUS_COA_RELAY", "NEXO_L2TP_PSK", "NEXO_ALERT_WEBHOOK_URL", "NEXO_GATEWAY_WEBHOOK_SECRET", "NEXO_COOKIE_SECURE"}

// Signed context reproduces Vitest's local simulators only in a dedicated tagged binary.
func Wrap(handler http.Handler, configure func()) http.Handler {
	if os.Getenv("NODE_ENV") == "production" || os.Getenv("NEXO_TEST_RELAY_KEY") == "" {
		panic("contractbridge exige laboratório e chave efêmera")
	}
	key, e := base64.RawURLEncoding.DecodeString(os.Getenv("NEXO_TEST_RELAY_KEY"))
	if e != nil || len(key) != 32 {
		panic("chave de laboratório inválida")
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := r.Header.Get("X-Nexo-Test-Context")
		if raw == "" {
			handler.ServeHTTP(w, r)
			return
		}
		body, sig, ok := strings.Cut(raw, ".")
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write([]byte(body))
		actual, e := hex.DecodeString(sig)
		if !ok || e != nil || !hmac.Equal(actual, mac.Sum(nil)) {
			http.Error(w, "contexto de laboratório inválido", 403)
			return
		}
		data, e := base64.RawURLEncoding.DecodeString(body)
		if e != nil {
			http.Error(w, "contexto inválido", 400)
			return
		}
		var value struct {
			RemoteAddress  string
			ForwardedProto *string
			Env            map[string]*string
		}
		if e = json.Unmarshal(data, &value); e != nil {
			http.Error(w, "contexto inválido", 400)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		old := map[string]*string{}
		for _, name := range names {
			if v, ok := os.LookupEnv(name); ok {
				copy := v
				old[name] = &copy
			}
			if v := value.Env[name]; v != nil {
				_ = os.Setenv(name, *v)
			} else {
				_ = os.Unsetenv(name)
			}
		}
		if configure != nil {
			configure()
		}
		defer func() {
			for _, name := range names {
				if v := old[name]; v != nil {
					_ = os.Setenv(name, *v)
				} else {
					_ = os.Unsetenv(name)
				}
			}
			if configure != nil {
				configure()
			}
		}()
		r.Header.Del("X-Nexo-Test-Context")
		if value.RemoteAddress != "" {
			r.RemoteAddr = value.RemoteAddress + ":12345"
		}
		if value.ForwardedProto != nil {
			r.Header.Set("X-Forwarded-Proto", *value.ForwardedProto)
		}
		handler.ServeHTTP(w, r)
	})
}

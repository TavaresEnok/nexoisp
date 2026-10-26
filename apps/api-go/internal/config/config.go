package config

import (
	"fmt"
	"math"
	"os"
	"strconv"
	"time"
)

type Config struct {
	URL, Addr, InternalAddr, Plan string
	Pool, Rate                    int
	TTL                           time.Duration
	RequireMFA                    bool
}

func Load() (Config, error) {
	c := Config{URL: os.Getenv("DATABASE_URL_GO"), Addr: env("NEXO_GO_ADDR", "127.0.0.1:18082"), InternalAddr: env("NEXO_GO_INTERNAL_ADDR", "127.0.0.1:19082"), Plan: env("NEXO_GO_PLAN_CACHE_MODE", "force_custom_plan"), Pool: 10, Rate: 1200, TTL: 5 * time.Second, RequireMFA: os.Getenv("NEXO_REQUIRE_ADMIN_MFA") == "1"}
	if c.URL == "" {
		return c, fmt.Errorf("DATABASE_URL_GO obrigatória")
	}
	var err error
	if v := os.Getenv("NEXO_GO_DB_POOL"); v != "" {
		c.Pool, err = strconv.Atoi(v)
		if err != nil || c.Pool < 1 {
			return c, fmt.Errorf("NEXO_GO_DB_POOL inválido")
		}
	}
	if v := os.Getenv("NEXO_PANEL_RATE_PER_MIN"); v != "" {
		n, e := strconv.Atoi(v)
		if e != nil || n < 30 || n > 1000000 {
			return c, fmt.Errorf("NEXO_PANEL_RATE_PER_MIN precisa estar entre 30 e 1000000")
		}
		c.Rate = n
	}
	if v := os.Getenv("NEXO_GO_AUTH_CACHE_TTL"); v != "" {
		n, e := strconv.ParseFloat(v, 64)
		if e != nil || math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n > 10 {
			return c, fmt.Errorf("TTL precisa estar entre 0 e 10 segundos")
		}
		c.TTL = time.Duration(n * float64(time.Second))
	}
	return c, nil
}
func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

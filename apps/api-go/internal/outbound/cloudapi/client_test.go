package cloudapi

import (
	"context"
	"encoding/json"
	"errors"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

const (
	caTestBearer = "test-token-not-real"
	caTestPhone  = "5500000000001"
	caTestKey    = "attempt-local-not-on-wire"
)

func TestR07RedirectRefused(t *testing.T) {
	for _, mode := range []string{"body", "no body", "transport error"} {
		t.Run(mode, func(t *testing.T) {
			rt := &caTestCount{fn: func(r *http.Request) (*http.Response, error) {
				if r.URL.Host != "graph.facebook.com" || r.Header.Get("Authorization") != "Bearer "+caTestBearer {
					t.Fatal("requisição fora do destino original ou sem bearer da fixture")
				}
				resp, _ := caTestStatus(302, caTestBearer+caTestPhone)(r)
				resp.Header.Set("Location", "https://invalid.test/"+caTestBearer)
				if mode == "no body" {
					resp.Body = nil
				}
				if mode == "transport error" {
					return resp, errors.New(caTestBearer)
				}
				return resp, nil
			}}
			res, err := caTestClient(t, true, []string{"v0.0"}, rt, 0).Send(context.Background(), caTestRequest())
			if err == nil || !res.Refused || res.Uncertain || res.Submitted || res.HTTPStatus != 302 || res.ProviderMessageID != "" || rt.n != 1 {
				t.Fatalf("redirect não terminou em recusa: result=%+v err=%v viagens=%d", res, err, rt.n)
			}
			if res.BodyExcerpt != "redirect recusado" || err.Error() != "redirect recusado" {
				t.Fatal("diagnóstico de redirect deve ser fixo e sanitizado")
			}
		})
	}
}

func caTestRequest() Request {
	return Request{
		Version:       "v0.0",
		PhoneNumberID: "100",
		To:            caTestPhone,
		TemplateName:  "fixture_min",
		TemplateLang:  "pt_BR",
		Bearer:        caTestBearer,
		AttemptKey:    caTestKey,
	}
}

func caTestClient(t *testing.T, enabled bool, versions []string, rt http.RoundTripper, timeout time.Duration) *Client {
	t.Helper()
	c, err := New(Config{
		Enabled:          enabled,
		AllowVersions:    versions,
		Transport:        rt,
		Timeout:          timeout,
		MaxResponseBytes: defaultMaxResponseBytes,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c
}

func caTestSecretFree(t *testing.T, label, text string) {
	t.Helper()
	if strings.Contains(text, caTestBearer) || strings.Contains(text, caTestPhone) {
		t.Fatalf("%s vazou segredo: %q", label, text)
	}
	if strings.Contains(text, "EAA") {
		t.Fatalf("%s vazou token EAA: %q", label, text)
	}
}

func caTestUTF16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}

type caTestCount struct {
	n    int
	last *http.Request
	fn   func(*http.Request) (*http.Response, error)
}

func (c *caTestCount) RoundTrip(r *http.Request) (*http.Response, error) {
	c.n++
	c.last = r
	if c.fn == nil {
		return nil, errors.New("round trip sem resposta")
	}
	return c.fn(r)
}

func caTestStatus(status int, body string) func(*http.Request) (*http.Response, error) {
	return func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode:    status,
			Header:        make(http.Header),
			Body:          io.NopCloser(strings.NewReader(body)),
			ContentLength: int64(len(body)),
		}, nil
	}
}

func TestCloudAPI_B15_C10(t *testing.T) {
	rt := &caTestCount{fn: func(r *http.Request) (*http.Response, error) {
		<-r.Context().Done()
		return nil, r.Context().Err()
	}}
	c := caTestClient(t, true, []string{"v0.0"}, rt, 150*time.Millisecond)
	res, err := c.Send(context.Background(), caTestRequest())
	if err == nil {
		t.Fatal("timeout sem erro")
	}
	if !res.Uncertain || res.Submitted || res.Refused || res.ProviderMessageID != "" {
		t.Fatalf("resultado = %+v", res)
	}
	if rt.n != 1 {
		t.Fatalf("idas = %d", rt.n)
	}
	caTestSecretFree(t, "erro", err.Error())
	caTestSecretFree(t, "excerpt", res.BodyExcerpt)
}

func TestCloudAPI_B15_C11(t *testing.T) {
	rt := &caTestCount{fn: caTestStatus(429, `{"error":"slow"}`)}
	c := caTestClient(t, true, []string{"v0.0"}, rt, time.Second)
	res, err := c.Send(context.Background(), caTestRequest())
	if err == nil {
		t.Fatal("429 sem erro")
	}
	if !res.Refused || res.Uncertain || res.Submitted || res.ProviderMessageID != "" || res.HTTPStatus != 429 {
		t.Fatalf("resultado = %+v", res)
	}
	if rt.n != 1 {
		t.Fatalf("idas = %d", rt.n)
	}
}

func TestCloudAPI_B15_C12(t *testing.T) {
	rt := &caTestCount{fn: caTestStatus(503, `{"error":"down"}`)}
	c := caTestClient(t, true, []string{"v0.0"}, rt, time.Second)
	res, err := c.Send(context.Background(), caTestRequest())
	if err != nil {
		t.Fatalf("5xx devolve erro de transporte: %v", err)
	}
	if !res.Uncertain || res.Submitted || res.Refused || res.ProviderMessageID != "" || res.HTTPStatus != 503 {
		t.Fatalf("resultado = %+v", res)
	}
	if rt.n != 1 {
		t.Fatalf("idas = %d", rt.n)
	}
}

func TestCloudAPI_B15_C13(t *testing.T) {
	rt := &caTestCount{fn: caTestStatus(400, `{"error":{"message":"template"}}`)}
	c := caTestClient(t, true, []string{"v0.0"}, rt, time.Second)
	res, err := c.Send(context.Background(), caTestRequest())
	if err == nil {
		t.Fatal("template recusado sem erro")
	}
	if !res.Refused || res.Submitted || res.Uncertain || res.ProviderMessageID != "" || res.HTTPStatus != 400 {
		t.Fatalf("resultado = %+v", res)
	}
	if rt.n != 1 {
		t.Fatalf("idas = %d", rt.n)
	}
	var probe struct{ Delivered bool }
	_ = probe.Delivered
}

func TestCloudAPI_B15_C14(t *testing.T) {
	eaa := "EAA" + strings.Repeat("B", 24)
	leaky := caTestBearer + " " + caTestPhone + " " + eaa

	t.Run("transporte", func(t *testing.T) {
		rt := &caTestCount{fn: func(*http.Request) (*http.Response, error) {
			return nil, errors.New("falha depois do Do " + leaky)
		}}
		c := caTestClient(t, true, []string{"v0.0"}, rt, time.Second)
		res, err := c.Send(context.Background(), caTestRequest())
		if err == nil {
			t.Fatal("erro de transporte ausente")
		}
		if !res.Uncertain || res.Submitted {
			t.Fatalf("resultado = %+v", res)
		}
		caTestSecretFree(t, "erro", err.Error())
		caTestSecretFree(t, "excerpt", res.BodyExcerpt)
		if caTestUTF16Len(err.Error()) > textLimitUTF16 || caTestUTF16Len(res.BodyExcerpt) > textLimitUTF16 {
			t.Fatal("texto passou de 300 UTF-16")
		}
	})

	t.Run("corpo 400", func(t *testing.T) {
		rt := &caTestCount{fn: caTestStatus(400, `{"echo":"`+leaky+`"}`)}
		c := caTestClient(t, true, []string{"v0.0"}, rt, time.Second)
		res, err := c.Send(context.Background(), caTestRequest())
		if err == nil {
			t.Fatal("400 sem erro")
		}
		caTestSecretFree(t, "erro", err.Error())
		caTestSecretFree(t, "excerpt", res.BodyExcerpt)
		if !res.Refused || res.Submitted {
			t.Fatalf("resultado = %+v", res)
		}
		if strings.Contains(err.Error(), "v1.") {
			t.Fatal("cliente montou cipher")
		}
	})
}

func TestCloudAPI_B15_C15(t *testing.T) {
	rt := &caTestCount{fn: func(*http.Request) (*http.Response, error) {
		t.Fatal("flag desligada chamou o transporte")
		return nil, errors.New("nao chamar")
	}}
	c := caTestClient(t, false, []string{"v0.0"}, rt, time.Second)
	res, err := c.Send(context.Background(), caTestRequest())
	if err == nil {
		t.Fatal("desligado sem erro")
	}
	if res != (Result{}) {
		t.Fatalf("resultado = %+v", res)
	}
	if rt.n != 0 {
		t.Fatalf("idas = %d", rt.n)
	}
}

func TestCloudAPI_B15_C16(t *testing.T) {
	const id = "wamid.test"
	body := `{"messages":[{"id":"` + id + `"}]}`
	rt := &caTestCount{fn: caTestStatus(200, body)}
	c := caTestClient(t, true, []string{"v0.0"}, rt, time.Second)
	res, err := c.Send(context.Background(), caTestRequest())
	if err != nil {
		t.Fatal(err)
	}
	if !res.Submitted || res.Uncertain || res.Refused || res.ProviderMessageID != id || res.HTTPStatus != 200 {
		t.Fatalf("resultado = %+v", res)
	}
	if res.BodyExcerpt != "" {
		t.Fatalf("sucesso reproduziu payload: %q", res.BodyExcerpt)
	}
	if rt.n != 1 {
		t.Fatalf("idas = %d", rt.n)
	}
	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := reflect.TypeOf(Result{}).FieldByName("Delivered"); ok {
		t.Fatal("Result tem campo Delivered")
	}
	if strings.Contains(string(raw), "Delivered") || strings.Contains(string(raw), "delivered") {
		t.Fatal("Result expõe entrega")
	}

	t.Run("2xx sem id", func(t *testing.T) {
		rt := &caTestCount{fn: caTestStatus(200, `{"messages":[{}]}`)}
		c := caTestClient(t, true, []string{"v0.0"}, rt, time.Second)
		res, err := c.Send(context.Background(), caTestRequest())
		if err != nil {
			t.Fatal(err)
		}
		if res.Submitted || !res.Uncertain || res.ProviderMessageID != "" {
			t.Fatalf("resultado = %+v", res)
		}
		if rt.n != 1 {
			t.Fatalf("idas = %d", rt.n)
		}
	})
}

func TestCloudAPI_B15_C17(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	var saw bool
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		saw = true
		file, err := parser.ParseFile(fset, name, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, imp := range file.Imports {
			path := strings.Trim(imp.Path.Value, `"`)
			switch {
			case path == "database/sql":
				t.Fatal("importa database/sql")
			case path == "nexoisp/api-go/internal/db" || strings.HasPrefix(path, "nexoisp/api-go/internal/db/"):
				t.Fatal("importa db")
			case path == "nexoisp/api-go/internal/outbound":
				t.Fatal("importa o pacote pai")
			case strings.Contains(path, "cloudjournal"):
				t.Fatal("importa cloudjournal")
			case strings.Contains(path, "finance"):
				t.Fatal("importa finance")
			case strings.Contains(path, "notices"):
				t.Fatal("importa notices")
			}
		}
		text, err := os.ReadFile(filepath.Clean(name))
		if err != nil {
			t.Fatal(err)
		}
		src := string(text)
		for _, env := range []string{"NEXO_CLOUD_API", "NEXO_DEMO_MODE", "NEXO_CLOUD_BASE", "GRAPH_VERSION"} {
			if strings.Contains(src, env) {
				t.Fatalf("%s lê %s", name, env)
			}
		}
	}
	if !saw {
		t.Fatal("pacote sem fontes")
	}
}

func TestCloudAPI_B15_C18(t *testing.T) {
	t.Setenv("NEXO_DEMO_MODE", "1")
	t.Setenv("NEXO_CLOUD_API", "on")
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:9")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:9")

	got, err := Endpoint("v0.0", "123456")
	if err != nil {
		t.Fatal(err)
	}
	if got.String() != "https://graph.facebook.com/v0.0/123456/messages" {
		t.Fatalf("url = %s", got.String())
	}
	if got.Scheme != "https" || got.Hostname() != graphHost || got.Port() != "" || got.User != nil || got.RawQuery != "" || got.Fragment != "" {
		t.Fatalf("url solta: %+v", got)
	}

	longID := strings.Repeat("9", 32)
	ok, err := Endpoint("v0.0", longID)
	if err != nil || ok.Path != "/v0.0/"+longID+"/messages" {
		t.Fatalf("id de 32: %v %v", ok, err)
	}
	rejected := [][2]string{
		{"", "1"},
		{"v0.0", ""},
		{"v0", "1"},
		{"0.0", "1"},
		{"V0.0", "1"},
		{"v0.0.1", "1"},
		{"v19.0", strings.Repeat("1", 33)},
		{"../v0.0", "1"},
		{"v0.0/extra", "1"},
		{"v0.0", "12a"},
		{"v0.0", "1/2"},
		{"v0.0", "1?x=1"},
		{"v0.0", "1#f"},
		{"user:pass@evil.example", "1"},
		{"http://evil.example", "1"},
		{"v0.0", "123@127.0.0.1"},
		{"graph.facebook.com", "1"},
	}
	for _, pair := range rejected {
		if _, err := Endpoint(pair[0], pair[1]); err == nil {
			t.Fatalf("aceitou %q %q", pair[0], pair[1])
		}
	}

	rt := &caTestCount{fn: func(*http.Request) (*http.Response, error) {
		t.Fatal("endpoint inválido chamou o transporte")
		return nil, errors.New("nao chamar")
	}}
	versions := []string{"v0.0", "https://evil.example/v0.0", "v0.0/../evil"}
	c := caTestClient(t, true, versions, rt, time.Second)
	for _, version := range versions[1:] {
		in := caTestRequest()
		in.Version = version
		in.PhoneNumberID = "1/../../evil.example"
		res, err := c.Send(context.Background(), in)
		if err == nil || res != (Result{}) || rt.n != 0 {
			t.Fatalf("bypass %s resultado=%+v err=%v idas=%d", version, res, err, rt.n)
		}
	}
	in := caTestRequest()
	in.PhoneNumberID = "12a"
	if _, err := c.Send(context.Background(), in); err == nil || rt.n != 0 {
		t.Fatalf("phone inválido idas=%d err=%v", rt.n, err)
	}

	public := netip.MustParseAddr("1.1.1.1")
	prod := pinnedHTTPClient([]netip.Addr{public}, time.Second)
	transport := prod.Transport.(*http.Transport)
	if transport.Proxy != nil {
		t.Fatal("proxy de produção não é nil")
	}
	if transport.TLSClientConfig == nil || transport.TLSClientConfig.ServerName != graphHost || transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("TLS sem host fixo")
	}
	if err := prod.CheckRedirect(nil, nil); err == nil || !strings.Contains(err.Error(), "redirect") {
		t.Fatalf("redirect = %v", err)
	}
	if _, err := transport.DialContext(context.Background(), "tcp", "evil.example:443"); err == nil {
		t.Fatal("dial aceitou outro host")
	}
	if _, err := transport.DialContext(context.Background(), "tcp", graphHost+":80"); err == nil {
		t.Fatal("dial aceitou outra porta")
	}
	if err := authorizeDial(graphHost+":443", []netip.Addr{public, netip.MustParseAddr("10.0.0.2")}); err == nil {
		t.Fatal("conjunto misto passou")
	}

	caTestPrivatePrefixes(t)
}

func caTestPrivatePrefixes(t *testing.T) {
	t.Helper()
	blocked := []string{
		"127.0.0.1",
		"10.1.2.3",
		"172.16.0.1",
		"192.168.0.1",
		"169.254.1.1",
		"0.0.0.0",
		"255.255.255.255",
		"224.0.0.1",
		"100.64.0.1",
		"100.127.255.255",
		"192.0.0.1",
		"198.18.0.1",
		"198.51.100.1",
		"203.0.113.1",
		"::1",
		"fc00::1",
		"fe80::1",
		"2001:db8::1",
		"::ffff:127.0.0.1",
		"::ffff:8.8.8.8",
		"not-an-ip",
	}
	for _, ip := range blocked {
		if !privateAddress(ip) {
			t.Fatalf("privado não recusado: %s", ip)
		}
	}
	allowed := []string{"8.8.8.8", "1.1.1.1", "9.9.9.9", "2606:4700:4700::1111"}
	for _, ip := range allowed {
		if privateAddress(ip) {
			t.Fatalf("público recusado: %s", ip)
		}
	}
	mixed := []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("100.64.1.1")}
	if err := rejectPrivate(mixed); err == nil {
		t.Fatal("CGNAT no conjunto passou")
	}
	if err := rejectPrivate(nil); err == nil {
		t.Fatal("resolução vazia passou")
	}
}

func TestCloudAPI_B15_C22(t *testing.T) {
	rt := &caTestCount{fn: func(*http.Request) (*http.Response, error) {
		t.Fatal("versão vazia chamou o transporte")
		return nil, errors.New("nao chamar")
	}}
	c, err := New(Config{Enabled: true, Transport: rt, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if c.timeout != time.Second || c.maxResponse != defaultMaxResponseBytes {
		t.Fatalf("defaults alterados timeout=%s max=%d", c.timeout, c.maxResponse)
	}
	for _, version := range []string{"v0.0", "v19.0", "v20.0", "v21.0", "v22.0", "v23.0"} {
		in := caTestRequest()
		in.Version = version
		res, err := c.Send(context.Background(), in)
		if err == nil || res != (Result{}) {
			t.Fatalf("versão %s resultado=%+v err=%v", version, res, err)
		}
	}
	if rt.n != 0 {
		t.Fatalf("idas = %d", rt.n)
	}

	versions := []string{"v0.0"}
	live := caTestClient(t, true, versions, rt, time.Second)
	versions[0] = "v99.0"
	rt.fn = caTestStatus(200, `{"messages":[{"id":"wamid.test"}]}`)
	res, err := live.Send(context.Background(), caTestRequest())
	if err != nil || !res.Submitted || rt.n != 1 {
		t.Fatalf("allowlist mutável resultado=%+v err=%v idas=%d", res, err, rt.n)
	}
	off := Config{Enabled: false, AllowVersions: []string{"v0.0"}, Transport: rt}
	disabled, err := New(off)
	if err != nil {
		t.Fatal(err)
	}
	off.Enabled = true
	before := rt.n
	if _, err := disabled.Send(context.Background(), caTestRequest()); err == nil || rt.n != before {
		t.Fatalf("Enabled mutável idas=%d err=%v", rt.n, err)
	}

	fresh, err := New(Config{})
	if err != nil {
		t.Fatal(err)
	}
	if fresh.enabled || len(fresh.allow) != 0 || fresh.timeout != defaultTimeout || fresh.maxResponse != defaultMaxResponseBytes {
		t.Fatalf("default de produção não é fechado: %+v", fresh)
	}
}

func TestCloudAPI_B15_C23(t *testing.T) {
	var seen []byte
	rt := &caTestCount{fn: func(r *http.Request) (*http.Response, error) {
		var err error
		seen, err = io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		for name, values := range r.Header {
			lower := strings.ToLower(name)
			if strings.Contains(lower, "idempot") {
				t.Fatalf("cabeçalho inventado %s", name)
			}
			for _, value := range values {
				if strings.Contains(value, caTestKey) || strings.Contains(strings.ToLower(value), "biz_opaque_callback_data") {
					t.Fatalf("cabeçalho %s vazou correlação", name)
				}
			}
		}
		if r.Header.Get("Authorization") != "Bearer "+caTestBearer {
			t.Fatalf("authorization = %q", r.Header.Get("Authorization"))
		}
		if r.URL.Scheme != "https" || r.URL.Hostname() != graphHost || r.URL.RawQuery != "" || r.URL.Fragment != "" {
			t.Fatalf("url = %s", r.URL.String())
		}
		if r.Host != graphHost {
			t.Fatalf("host = %s", r.Host)
		}
		return caTestStatus(200, `{"messages":[{"id":"wamid.test"}]}`)(r)
	}}
	c := caTestClient(t, true, []string{"v0.0"}, rt, time.Second)
	res, err := c.Send(context.Background(), caTestRequest())
	if err != nil || !res.Submitted || rt.n != 1 {
		t.Fatalf("resultado=%+v err=%v idas=%d", res, err, rt.n)
	}
	if strings.Contains(string(seen), caTestKey) || strings.Contains(string(seen), "biz_opaque_callback_data") {
		t.Fatalf("corpo vazou campo não verificado: %s", seen)
	}
	var payload map[string]any
	if err := json.Unmarshal(seen, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["messaging_product"] != "whatsapp" || payload["to"] != caTestPhone || payload["type"] != "template" {
		t.Fatalf("corpo = %#v", payload)
	}
	template, _ := payload["template"].(map[string]any)
	if template == nil || template["name"] != "fixture_min" {
		t.Fatalf("template = %#v", template)
	}
	if _, ok := template["components"]; ok {
		t.Fatal("componentes inventados")
	}
	lang, _ := template["language"].(map[string]any)
	if lang["code"] != "pt_BR" {
		t.Fatalf("language = %#v", lang)
	}
	if len(payload) != 4 {
		t.Fatalf("campos a mais: %#v", payload)
	}

	t.Run("body params", func(t *testing.T) {
		blocked := &caTestCount{fn: func(*http.Request) (*http.Response, error) {
			t.Fatal("BodyParams chamou o transporte")
			return nil, errors.New("nao chamar")
		}}
		c := caTestClient(t, true, []string{"v0.0"}, blocked, time.Second)
		in := caTestRequest()
		in.BodyParams = []string{"nao-verificado"}
		res, err := c.Send(context.Background(), in)
		if err == nil || res != (Result{}) || blocked.n != 0 {
			t.Fatalf("params resultado=%+v err=%v idas=%d", res, err, blocked.n)
		}
	})
}

func TestCloudAPI_B15_C25(t *testing.T) {
	t.Run("id depois do corte", func(t *testing.T) {
		tail := &caTestTail{}
		head := strings.Repeat("a", defaultMaxResponseBytes)
		body := io.MultiReader(strings.NewReader(head), tail, strings.NewReader(`{"messages":[{"id":"wamid.hidden"}]}`))
		rt := &caTestCount{fn: func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode:    200,
				Header:        make(http.Header),
				Body:          io.NopCloser(body),
				ContentLength: -1,
			}, nil
		}}
		c := caTestClient(t, true, []string{"v0.0"}, rt, time.Second)
		res, err := c.Send(context.Background(), caTestRequest())
		if err == nil {
			t.Fatal("corte sem falha")
		}
		if tail.n != 0 {
			t.Fatal("leu o byte além do teto")
		}
		if res.Submitted || !res.Uncertain || res.ProviderMessageID != "" || res.Refused {
			t.Fatalf("resultado = %+v", res)
		}
		if rt.n != 1 {
			t.Fatalf("idas = %d", rt.n)
		}
		if caTestUTF16Len(res.BodyExcerpt) > textLimitUTF16 || caTestUTF16Len(err.Error()) > textLimitUTF16 {
			t.Fatal("excerpt passou de 300 UTF-16")
		}
		caTestSecretFree(t, "excerpt", res.BodyExcerpt)
	})

	t.Run("content-length acima", func(t *testing.T) {
		body := &caTestExplode{}
		rt := &caTestCount{fn: func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode:    200,
				Header:        make(http.Header),
				Body:          io.NopCloser(body),
				ContentLength: int64(defaultMaxResponseBytes + 1),
			}, nil
		}}
		c := caTestClient(t, true, []string{"v0.0"}, rt, time.Second)
		res, err := c.Send(context.Background(), caTestRequest())
		if err == nil || body.n != 0 {
			t.Fatalf("leu corpo acima do Content-Length: err=%v leituras=%d", err, body.n)
		}
		if res.Submitted || !res.Uncertain || res.ProviderMessageID != "" {
			t.Fatalf("resultado = %+v", res)
		}
		if rt.n != 1 {
			t.Fatalf("idas = %d", rt.n)
		}
	})

	t.Run("excerpt longo", func(t *testing.T) {
		long := strings.Repeat("á", 800)
		rt := &caTestCount{fn: caTestStatus(400, long)}
		c := caTestClient(t, true, []string{"v0.0"}, rt, time.Second)
		res, err := c.Send(context.Background(), caTestRequest())
		if err == nil {
			t.Fatal("400 sem erro")
		}
		if caTestUTF16Len(res.BodyExcerpt) > textLimitUTF16 || caTestUTF16Len(err.Error()) > textLimitUTF16 {
			t.Fatalf("excerpt=%d erro=%d", caTestUTF16Len(res.BodyExcerpt), caTestUTF16Len(err.Error()))
		}
		if !res.Refused || res.Submitted {
			t.Fatalf("resultado = %+v", res)
		}
	})
}

type caTestTail struct{ n int }

func (t *caTestTail) Read(p []byte) (int, error) {
	t.n++
	if len(p) == 0 {
		return 0, nil
	}
	return 0, errors.New("leitura além do teto")
}

type caTestExplode struct{ n int }

func (e *caTestExplode) Read([]byte) (int, error) {
	e.n++
	return 0, errors.New("nao ler")
}

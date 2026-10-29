// Package cloudapi is the offline WhatsApp Cloud API client for notice delivery.
// Enabled defaults to false and AllowVersions starts empty. No Graph version is proven here.
// The package does not read accounts, journals, or the parent outbound sender.
package cloudapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	defaultTimeout          = 10 * time.Second
	defaultMaxResponseBytes = 4096
)

// Config is copied into the client. Enabled and AllowVersions do not change after New.
// An empty AllowVersions list allows no Graph version. Transport nil selects the pinned
// production dialer. A non-nil Transport is used as-is and does not resolve or dial.
type Config struct {
	Enabled          bool
	AllowVersions    []string
	Transport        http.RoundTripper
	Timeout          time.Duration
	MaxResponseBytes int
}

// Request is one template send. AttemptKey is local correlation and never goes on the wire.
// BodyParams stays empty until a verified template schema exists. A non-empty list is refused.
type Request struct {
	Version       string
	PhoneNumberID string
	To            string
	TemplateName  string
	TemplateLang  string
	BodyParams    []string
	Bearer        string
	AttemptKey    string
}

// Result classifies one HTTP acceptance. Submitted is not handset delivery.
type Result struct {
	HTTPStatus        int
	ProviderMessageID string
	Submitted         bool
	Uncertain         bool
	Refused           bool
	BodyExcerpt       string
}

// Client is safe for concurrent Send. Configuration is fixed at New.
type Client struct {
	enabled     bool
	allow       map[string]struct{}
	transport   http.RoundTripper
	timeout     time.Duration
	maxResponse int
}

type templateLanguage struct {
	Code string `json:"code"`
}

type templateObject struct {
	Name     string           `json:"name"`
	Language templateLanguage `json:"language"`
}

// Minimal body confirmed by the public Meta Postman collection. No components,
// no biz_opaque_callback_data, and no idempotency field.
type templatePayload struct {
	MessagingProduct string         `json:"messaging_product"`
	To               string         `json:"to"`
	Type             string         `json:"type"`
	Template         templateObject `json:"template"`
}

type providerMessage struct {
	ID string `json:"id"`
}

type providerResponse struct {
	Messages []providerMessage `json:"messages"`
}

var (
	versionPattern = regexp.MustCompile(`^v[0-9]+\.[0-9]+$`)
	phonePattern   = regexp.MustCompile(`^[0-9]{1,32}$`)

	errDisabled   = errors.New("cloud api desligada")
	errVersion    = errors.New("versão graph não allowlisted")
	errBearer     = errors.New("bearer ausente")
	errBodyParams = errors.New("parâmetros de corpo não verificados")
	errTemplate   = errors.New("template incompleto")
	errEndpoint   = errors.New("endpoint cloud api recusado")
)

// New copies Enabled and AllowVersions. Later edits of the caller's slice are ignored.
func New(cfg Config) (*Client, error) {
	if cfg.Timeout < 0 || cfg.MaxResponseBytes < 0 {
		return nil, errors.New("config cloud api recusada")
	}
	timeout := cfg.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}
	maxResponse := cfg.MaxResponseBytes
	if maxResponse == 0 {
		maxResponse = defaultMaxResponseBytes
	}
	allow := make(map[string]struct{}, len(cfg.AllowVersions))
	for _, version := range cfg.AllowVersions {
		allow[version] = struct{}{}
	}
	return &Client{
		enabled:     cfg.Enabled,
		allow:       allow,
		transport:   cfg.Transport,
		timeout:     timeout,
		maxResponse: maxResponse,
	}, nil
}

// Endpoint builds the fixed Graph messages URL. The host, scheme, and path shape are local locks.
// Version uses the vN.N shape. PhoneNumberID is 1 to 32 digits. Neither fact is a Meta citation.
func Endpoint(version, phoneNumberID string) (*url.URL, error) {
	if !versionPattern.MatchString(version) || !phonePattern.MatchString(phoneNumberID) {
		return nil, errEndpoint
	}
	u := &url.URL{
		Scheme: "https",
		Host:   graphHost,
		Path:   "/" + version + "/" + phoneNumberID + "/messages",
	}
	if u.Scheme != "https" || u.Hostname() != graphHost || u.Port() != "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errEndpoint
	}
	return u, nil
}

// Send performs at most one round trip. Refusals before Do return a zero Result and an error.
func (c *Client) Send(ctx context.Context, in Request) (Result, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if !c.enabled {
		return Result{}, errDisabled
	}
	if _, ok := c.allow[in.Version]; !ok {
		return Result{}, errVersion
	}
	endpoint, err := Endpoint(in.Version, in.PhoneNumberID)
	if err != nil {
		return Result{}, err
	}
	if strings.TrimSpace(in.Bearer) == "" {
		return Result{}, errBearer
	}
	if len(in.BodyParams) > 0 {
		return Result{}, errBodyParams
	}
	if strings.TrimSpace(in.To) == "" || strings.TrimSpace(in.TemplateName) == "" || strings.TrimSpace(in.TemplateLang) == "" {
		return Result{}, errTemplate
	}
	payload, err := json.Marshal(templatePayload{
		MessagingProduct: "whatsapp",
		To:               in.To,
		Type:             "template",
		Template: templateObject{
			Name:     in.TemplateName,
			Language: templateLanguage{Code: in.TemplateLang},
		},
	})
	if err != nil {
		return Result{}, errTemplate
	}
	if strings.Contains(string(payload), "biz_opaque_callback_data") || (in.AttemptKey != "" && strings.Contains(string(payload), in.AttemptKey)) {
		return Result{}, errors.New("corpo cloud api recusado")
	}

	callCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	if err := callCtx.Err(); err != nil {
		return Result{}, errors.New("contexto encerrado antes do envio")
	}
	req, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint.String(), bytes.NewReader(payload))
	if err != nil {
		return Result{}, errEndpoint
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+in.Bearer)
	req.Host = graphHost

	var (
		resp  *http.Response
		doErr error
	)
	if c.transport != nil {
		resp, doErr = c.transport.RoundTrip(req)
	} else {
		pinned, lookupErr := lookupPinned(callCtx)
		if lookupErr != nil {
			return Result{}, errors.New(boundSecret(lookupErr.Error(), in.Bearer, in.To))
		}
		client := pinnedHTTPClient(pinned, c.timeout)
		defer client.CloseIdleConnections()
		resp, doErr = client.Do(req)
	}
	if resp != nil && resp.Body != nil {
		defer resp.Body.Close()
	}
	if doErr != nil && (resp == nil || resp.StatusCode < 300 || resp.StatusCode >= 400) {
		return uncertainTransport(doErr, in), errors.New(boundSecret(doErr.Error(), in.Bearer, in.To))
	}
	if doErr != nil && resp != nil && resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return Result{HTTPStatus: resp.StatusCode, Refused: true}, errors.New("redirect recusado")
	}
	if resp == nil {
		return Result{Uncertain: true}, errors.New("falha cloud api")
	}
	return c.classify(resp, in)
}

func uncertainTransport(err error, in Request) Result {
	excerpt := ""
	if err != nil {
		excerpt = boundSecret(err.Error(), in.Bearer, in.To)
	}
	return Result{Uncertain: true, BodyExcerpt: excerpt}
}

func (c *Client) classify(resp *http.Response, in Request) (Result, error) {
	res := Result{HTTPStatus: resp.StatusCode}
	body, truncated, err := c.readBody(resp)
	excerpt := ""
	if len(body) > 0 {
		excerpt = boundSecret(string(body), in.Bearer, in.To)
	}
	if err != nil {
		res.BodyExcerpt = excerpt
		if resp.StatusCode >= 400 && resp.StatusCode < 500 {
			res.Refused = true
		} else {
			res.Uncertain = true
		}
		return res, errors.New(boundSecret(err.Error(), in.Bearer, in.To))
	}
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		if truncated {
			res.Uncertain = true
			res.BodyExcerpt = excerpt
			return res, errors.New("resposta cloud api acima do limite")
		}
		id := providerID(body)
		if id == "" {
			res.Uncertain = true
			res.BodyExcerpt = excerpt
			return res, nil
		}
		res.Submitted = true
		res.ProviderMessageID = id
		return res, nil
	case resp.StatusCode == 429 || (resp.StatusCode >= 400 && resp.StatusCode < 500):
		res.Refused = true
		res.BodyExcerpt = excerpt
		return res, errors.New("cloud api recusou o envio")
	case resp.StatusCode >= 500 && resp.StatusCode < 600:
		res.Uncertain = true
		res.BodyExcerpt = excerpt
		if truncated {
			return res, errors.New("resposta cloud api acima do limite")
		}
		return res, nil
	default:
		res.Refused = true
		res.BodyExcerpt = excerpt
		return res, errors.New("cloud api respondeu status inesperado")
	}
}

func (c *Client) readBody(resp *http.Response) ([]byte, bool, error) {
	if resp.Body == nil {
		return nil, false, errors.New("resposta sem corpo")
	}
	if resp.ContentLength > int64(c.maxResponse) {
		return nil, true, nil
	}
	data, hitCeiling, err := readAtMost(resp.Body, c.maxResponse)
	if err != nil {
		return data, false, err
	}
	if resp.ContentLength > 0 && int64(len(data)) == resp.ContentLength && resp.ContentLength <= int64(c.maxResponse) {
		hitCeiling = false
	}
	return data, hitCeiling, nil
}

// readAtMost never issues a read past limit. A full buffer without EOF is truncated.
func readAtMost(r io.Reader, limit int) ([]byte, bool, error) {
	if limit <= 0 {
		return nil, true, errors.New("limite de resposta inválido")
	}
	buf := make([]byte, limit)
	n := 0
	for n < limit {
		nn, err := r.Read(buf[n:])
		n += nn
		if err == io.EOF {
			return buf[:n], false, nil
		}
		if err != nil {
			return buf[:n], false, err
		}
		if nn == 0 {
			return buf[:n], false, errors.New("leitura vazia da resposta")
		}
	}
	return buf[:n], true, nil
}

func providerID(body []byte) string {
	var parsed providerResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return ""
	}
	for _, message := range parsed.Messages {
		id := strings.TrimSpace(message.ID)
		if id != "" {
			return id
		}
	}
	return ""
}

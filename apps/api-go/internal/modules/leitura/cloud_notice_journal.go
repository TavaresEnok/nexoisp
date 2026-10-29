package leitura

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
)

const (
	cloudNoticeJournalPath       = "/api/notice-log/{id}/cloud-journal"
	cloudNoticeJournalPermission = "settings:manage"
	cloudNoticeJournalLimit      = 100
	cloudNoticeJournalScopeMsg   = "o histórico Cloud exige escopo integral do provedor, fora do suporte"
)

// One indexed read. Attempts use (notice_log_id, attempt_no). Status rows are
// included only when an attempt of this same notice, tenant and account carries
// the same provider message id. The extra row detects truncation; the response
// keeps 100. The statement does not return secrets, phones, bodies or ids.
const cloudNoticeJournalSQL = `
select l.id,
       l.status,
       l.cloud_lock_timeouts,
       coalesce((
         select json_agg(json_build_object(
           'attempt_no', page.attempt_no,
           'state', page.state,
           'created_at', to_char(page.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           'wire_at', case when page.wire_at is null then null
                           else to_char(page.wire_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
           'http_status', page.http_status
         ) order by page.attempt_no desc)
         from (
           select a.attempt_no, a.state, a.created_at, a.wire_at, a.http_status
           from cloud_notice_attempts a
           where a.tenant_id = $1::uuid
             and a.notice_log_id = l.id
           order by a.attempt_no desc
           limit 101
         ) page
       ), '[]'::json),
       coalesce((
         select json_agg(json_build_object(
           'attempt_no', page.attempt_no,
           'raw_status', page.raw_status,
           'created_at', to_char(page.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
         ) order by page.created_at desc, page.id desc)
         from (
           select a.attempt_no, s.raw_status, s.created_at, s.id
           from cloud_notice_attempts a
           join cloud_notice_status s
             on s.tenant_id = a.tenant_id
            and s.cloud_account_id = a.cloud_account_id
            and s.provider_message_id = a.provider_message_id
           where a.tenant_id = $1::uuid
             and s.tenant_id = $1::uuid
             and a.notice_log_id = l.id
             and a.provider_message_id is not null
           order by s.created_at desc, s.id desc
           limit 101
         ) page
       ), '[]'::json)
from notice_log l
where l.tenant_id = $1::uuid
  and l.id = $2`

var cloudNoticeAttemptStates = map[string]struct{}{
	"reserved": {}, "wire": {}, "submitted": {}, "refused": {}, "uncertain": {}, "not_sent": {},
}

type cloudJournalAttempt struct {
	AttemptNo  int32   `json:"attempt_no"`
	State      string  `json:"state"`
	CreatedAt  string  `json:"created_at"`
	WireAt     *string `json:"wire_at"`
	HTTPStatus *int32  `json:"http_status"`
}

type cloudJournalStatus struct {
	AttemptNo int32  `json:"attempt_no"`
	RawStatus string `json:"raw_status"`
	CreatedAt string `json:"created_at"`
}

type cloudJournalResponse struct {
	NoticeLogID       string                `json:"notice_log_id"`
	LogStatus         string                `json:"log_status"`
	CloudLockTimeouts int                   `json:"cloud_lock_timeouts"`
	Attempts          []cloudJournalAttempt `json:"attempts"`
	Statuses          []cloudJournalStatus  `json:"statuses"`
	AttemptsTruncated bool                  `json:"attempts_truncated"`
	StatusesTruncated bool                  `json:"statuses_truncated"`
}

func registerCloudNoticeJournal(api huma.API, r *endpoint.Registry, s Service) {
	r.Get(api, cloudNoticeJournalPath, cloudNoticeJournalPermission, false, s.cloudNoticeJournal)
}

func cloudNoticeJournalScope(ctx context.Context) error {
	if ctx == nil {
		return apierr.New(403, cloudNoticeJournalScopeMsg)
	}
	actor := auth.From(ctx)
	if actor == nil ||
		actor.TenantID == "" ||
		actor.Scope.TenantID == "" ||
		actor.Scope.TenantID != actor.TenantID ||
		actor.SubscriberID != "" ||
		actor.Scope.SubscriberID != "" ||
		actor.PopIDs != nil ||
		actor.Scope.PopIDs != nil ||
		actor.Support ||
		actor.Scope.IsOperator() {
		return apierr.New(403, cloudNoticeJournalScopeMsg)
	}
	return nil
}

func rejectCloudNoticeJournalQuery(q url.Values) error {
	if len(q) == 0 {
		return nil
	}
	for _, values := range q {
		if len(values) != 1 {
			return apierr.New(400, "filtro repetido")
		}
	}
	return apierr.New(400, "filtro desconhecido")
}

func parseCloudNoticeLogID(raw string) (int64, error) {
	if raw == "" || len(raw) > 19 || raw[0] == '0' {
		return 0, apierr.New(400, "identificador inválido")
	}
	for _, c := range raw {
		if c < '0' || c > '9' {
			return 0, apierr.New(400, "identificador inválido")
		}
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n <= 0 || strconv.FormatInt(n, 10) != raw {
		return 0, apierr.New(400, "identificador inválido")
	}
	return n, nil
}

func decodeCloudJournal(raw []byte, dest any) error {
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dest); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("json extra")
	}
	return nil
}

func assembleCloudNoticeJournal(noticeID, logStatus string, timeouts int, attemptsRaw, statusesRaw []byte) (cloudJournalResponse, error) {
	fail := func() (cloudJournalResponse, error) {
		return cloudJournalResponse{}, apierr.New(500, "histórico Cloud inconsistente")
	}
	parsed, err := parseCloudNoticeLogID(noticeID)
	if err != nil || strconv.FormatInt(parsed, 10) != noticeID || logStatus == "" || timeouts < 0 || timeouts > 3 {
		return fail()
	}
	var attempts []cloudJournalAttempt
	var statuses []cloudJournalStatus
	if err = decodeCloudJournal(attemptsRaw, &attempts); err != nil {
		return fail()
	}
	if err = decodeCloudJournal(statusesRaw, &statuses); err != nil {
		return fail()
	}
	if attempts == nil {
		attempts = []cloudJournalAttempt{}
	}
	if statuses == nil {
		statuses = []cloudJournalStatus{}
	}
	for _, row := range attempts {
		if _, ok := cloudNoticeAttemptStates[row.State]; !ok || row.AttemptNo <= 0 || row.CreatedAt == "" {
			return fail()
		}
		if row.WireAt != nil && *row.WireAt == "" {
			return fail()
		}
		if row.HTTPStatus != nil && (*row.HTTPStatus < 100 || *row.HTTPStatus > 599) {
			return fail()
		}
	}
	for _, row := range statuses {
		if row.AttemptNo <= 0 || row.CreatedAt == "" {
			return fail()
		}
		n := utf8.RuneCountInString(row.RawStatus)
		if n < 1 || n > 300 {
			return fail()
		}
	}
	resp := cloudJournalResponse{
		NoticeLogID:       noticeID,
		LogStatus:         logStatus,
		CloudLockTimeouts: timeouts,
		Attempts:          attempts,
		Statuses:          statuses,
	}
	if len(resp.Attempts) > cloudNoticeJournalLimit {
		resp.AttemptsTruncated = true
		resp.Attempts = resp.Attempts[:cloudNoticeJournalLimit]
	}
	if len(resp.Statuses) > cloudNoticeJournalLimit {
		resp.StatusesTruncated = true
		resp.Statuses = resp.Statuses[:cloudNoticeJournalLimit]
	}
	return resp, nil
}

func (s Service) cloudNoticeJournal(ctx context.Context, req *http.Request) (endpoint.Result, error) {
	if err := cloudNoticeJournalScope(ctx); err != nil {
		return endpoint.Result{}, err
	}
	if req == nil || req.URL == nil || req.Context() == nil {
		return endpoint.Result{}, apierr.New(400, "requisição inválida")
	}
	// URL.Query discards parse errors. Invalid escapes and ';' must be 400
	// before the map check and before any database read.
	q, err := url.ParseQuery(req.URL.RawQuery)
	if err != nil {
		return endpoint.Result{}, apierr.New(400, "filtro inválido")
	}
	if err = rejectCloudNoticeJournalQuery(q); err != nil {
		return endpoint.Result{}, err
	}
	id, err := parseCloudNoticeLogID(chi.URLParam(req, "id"))
	if err != nil {
		return endpoint.Result{}, err
	}
	if s.DB == nil {
		return endpoint.Result{}, apierr.New(500, "histórico Cloud indisponível")
	}
	actor := auth.From(ctx)
	var resp cloudJournalResponse
	var found bool
	err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
		var noticeID int64
		var status string
		var timeouts int32
		var attemptsRaw, statusesRaw []byte
		qerr := tx.QueryRow(ctx, cloudNoticeJournalSQL, actor.TenantID, id).Scan(&noticeID, &status, &timeouts, &attemptsRaw, &statusesRaw)
		if errors.Is(qerr, pgx.ErrNoRows) {
			return apierr.New(404, "aviso não encontrado")
		}
		if qerr != nil {
			return qerr
		}
		if noticeID != id {
			return apierr.New(404, "aviso não encontrado")
		}
		built, qerr := assembleCloudNoticeJournal(strconv.FormatInt(noticeID, 10), status, int(timeouts), attemptsRaw, statusesRaw)
		if qerr != nil {
			return qerr
		}
		resp = built
		found = true
		return nil
	})
	if err != nil || !found {
		if err == nil {
			err = apierr.New(404, "aviso não encontrado")
		}
		return endpoint.Result{}, err
	}
	return endpoint.Result{Value: resp}, nil
}

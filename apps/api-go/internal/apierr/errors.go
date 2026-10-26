package apierr

import (
	"errors"
	"log/slog"
	"net/http"
	"nexoisp/api-go/internal/jsonx"

	"github.com/jackc/pgx/v5/pgconn"
)

type Error struct {
	Status  int    `json:"-"`
	Message string `json:"error"`
	Code    string `json:"code,omitempty"`
	Detail  string `json:"detail,omitempty"`
}

func (e *Error) Error() string              { return e.Message }
func (e *Error) GetStatus() int             { return e.Status }
func New(status int, message string) *Error { return &Error{Status: status, Message: message} }
func Map(err error) *Error {
	var h *Error
	if errors.As(err, &h) {
		return h
	}
	var p *pgconn.PgError
	if errors.As(err, &p) {
		switch p.Code {
		case "N6901":
			return New(409, "fatura com emissão no fornecedor: concilie ou cancele a cobrança antes de alterar ou baixar")
		case "23505":
			return &Error{Status: 409, Message: "registro duplicado: já existe um cadastro com estes dados", Detail: p.ConstraintName}
		case "23503":
			return &Error{Status: 400, Message: "referência inválida ou registro em uso", Detail: p.ConstraintName}
		case "42501":
			return New(403, "operação não permitida")
		}
	}
	slog.Error("falha na requisição", "error", err.Error())
	return New(500, "erro interno")
}
func Write(w http.ResponseWriter, err error) {
	e := Map(err)
	b, _ := jsonx.Encode(e)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(e.Status)
	_, _ = w.Write(b)
}

func (e *Error) ContentType(string) string { return "application/json; charset=utf-8" }

package leitura

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"testing"

	"nexoisp/api-go/internal/jsonx"
)

func TestBalanceReadSanitizedLog(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	selection := BalanceReadSelection{Reader: balanceReaderInvoiceDetail, Shadow: true}
	rows := []jsonx.Object{{{Name: "note", Value: "secret-note"}, {Name: "cmp_matches", Value: true}}}
	if err := Strip(selection, rows); err != nil {
		t.Fatal(err)
	}
	if logs.Len() != 0 {
		t.Fatal("match produziu log")
	}
	rows = []jsonx.Object{{{Name: "note", Value: "secret-note"}, {Name: "cmp_matches", Value: false}}}
	if err := Strip(selection, rows); err != nil {
		t.Fatal(err)
	}
	var entry map[string]any
	if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	if len(entry) != 5 || entry["msg"] != "balance_read_mismatch" || entry["level"] != "WARN" || entry["reader"] != balanceReaderInvoiceDetail || entry["result"] != balanceReadMismatch {
		t.Fatalf("campos inesperados no diagnóstico: %v", entry)
	}
	logs.Reset()
	if err := observeBalanceRead("secret-reader", balanceReadMismatch); err == nil {
		t.Fatal("leitor livre aceito")
	}
	if err := observeBalanceRead(balanceReaderInvoiceDetail, "secret-result"); err == nil {
		t.Fatal("resultado livre aceito")
	}
	if logs.Len() != 0 {
		t.Fatal("entrada inválida produziu log")
	}
}

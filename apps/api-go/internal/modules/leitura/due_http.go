package leitura

import (
	"context"
	"fmt"
	"strings"

	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	gen "nexoisp/api-go/internal/modules/leitura/gen"
)

const dueReaderID = "invoice-due"

// duePolicy is a local mode, allowlist and variant registry.
// Tests pass their own value. Production uses dueCompiledPolicy and does not read the environment.
type duePolicy struct {
	mode        string
	shadowAllow map[string]struct{}
	cutAllow    map[string]struct{}
	variants    map[string]string
}

// Allowlists vazias: nenhum leitor sai da sentença legada. Cut não é servido.
func dueCompiledPolicy() duePolicy {
	return duePolicy{mode: "off", shadowAllow: map[string]struct{}{}, cutAllow: map[string]struct{}{}, variants: map[string]string{}}
}

func dueNormalizedMode(mode string) string {
	switch mode {
	case "shadow", "cut", "off":
		return mode
	default:
		return "off"
	}
}

func duePick(p duePolicy, reader, legacy string) (string, bool, error) {
	switch dueNormalizedMode(p.mode) {
	case "shadow":
		if _, ok := p.shadowAllow[reader]; !ok {
			return legacy, false, nil
		}
		sql, ok := p.variants[reader]
		if !ok || strings.TrimSpace(sql) == "" {
			return "", false, fmt.Errorf("invoice-due: shadow sem variante")
		}
		return sql, true, nil
	default:
		return legacy, false, nil
	}
}

func stripDueCompare(shadow bool, rows []jsonx.Object, observe func(result string)) error {
	type cleaned struct {
		kept   jsonx.Object
		result string
		report bool
	}
	next := make([]cleaned, len(rows))
	for i, row := range rows {
		saw := false
		var matches any
		present := false
		kept := make(jsonx.Object, 0, len(row))
		for _, field := range row {
			if strings.HasPrefix(field.Name, "cmp_") {
				saw = true
				if field.Name == "cmp_matches" {
					present = true
					matches = field.Value
				}
				continue
			}
			kept = append(kept, field)
		}
		if !shadow {
			if saw {
				return fmt.Errorf("invoice-due: coluna cmp_ na leitura desligada")
			}
			next[i] = cleaned{kept: kept}
			continue
		}
		if !present {
			return fmt.Errorf("invoice-due: cmp_matches ausente")
		}
		matched, ok := matches.(bool)
		if !ok {
			return fmt.Errorf("invoice-due: cmp_matches inválido")
		}
		result := "match"
		if !matched {
			result = "mismatch"
		}
		next[i] = cleaned{kept: kept, result: result, report: true}
	}
	for i := range rows {
		rows[i] = next[i].kept
	}
	if observe != nil {
		for _, row := range next {
			if row.report {
				observe(row.result)
			}
		}
	}
	return nil
}

func dueServe(ctx context.Context, id string, policy duePolicy, observe func(string), query func(context.Context, string, ...any) ([]jsonx.Object, error), legacy func(context.Context, string) (map[string]any, error)) (map[string]any, error) {
	sql, shadow, err := duePick(policy, dueReaderID, gen.Due)
	if err != nil {
		return nil, err
	}
	if !shadow {
		return legacy(ctx, id)
	}
	rows, err := query(ctx, sql, id)
	if err != nil {
		return nil, err
	}
	if err = stripDueCompare(true, rows, observe); err != nil {
		return nil, err
	}
	return dueBreakdownFromQuery(rows, nil)
}

// dueHTTPWith is the single GET due path.
// Shadow false calls legacy once. Shadow true runs selection.SQL once, then Strip
// and dueBreakdownFromRow. It does not call legacy after the variant.
func dueHTTPWith(ctx context.Context, id string, policy balanceReadPolicy, query func(context.Context, string, ...any) ([]jsonx.Object, error), legacy func(context.Context, string) (map[string]any, error)) (map[string]any, error) {
	selection, err := policy.pick(balanceReaderInvoiceDue, gen.Due)
	if err != nil {
		return nil, err
	}
	if !selection.Shadow {
		return legacy(ctx, id)
	}
	rows, err := query(ctx, selection.SQL, id)
	if err != nil {
		return nil, err
	}
	if err = Strip(selection, rows); err != nil {
		return nil, err
	}
	return dueBreakdownFromQuery(rows, nil)
}

// DueHTTP is the GET /api/invoices/{id}/due entry. Agreement and Manual keep calling DueBreakdown.
// Compiled allowlists are empty, so this delegates to DueBreakdown and runs gen.Due once.
func DueHTTP(ctx context.Context, tx *db.Tx, id string) (map[string]any, error) {
	return dueHTTPWith(ctx, id, productionBalancePolicy(), func(ctx context.Context, sql string, args ...any) ([]jsonx.Object, error) {
		return tx.Objects(ctx, sql, args...)
	}, func(ctx context.Context, id string) (map[string]any, error) {
		return DueBreakdown(ctx, tx, id)
	})
}

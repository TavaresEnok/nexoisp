package leitura

import _ "embed"

//go:embed shadow/contract_finance_totals.sql
var contractFinanceTotalsVariantSQL string

func init() {
	registerBalanceVariant(balanceReaderContractFinanceTotals, contractFinanceTotalsVariantSQL)
}

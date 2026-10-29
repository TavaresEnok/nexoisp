package leitura

import _ "embed"

//go:embed shadow/group91a4cc44_0.sql
var shadowInvoiceDetailSQL string

//go:embed shadow/groupc47037ac_0.sql
var shadowContractFinanceListSQL string

//go:embed shadow/group152f5ccd_0.sql
var shadowReconciliationInvoicesSQL string

//go:embed shadow/readf038858e.sql
var shadowFinanceSummarySQL string

func init() {
	registerBalanceVariant(balanceReaderInvoiceDetail, shadowInvoiceDetailSQL)
	registerBalanceVariant(balanceReaderContractFinanceList, shadowContractFinanceListSQL)
	registerBalanceVariant(balanceReaderReconciliationInvoices, shadowReconciliationInvoicesSQL)
	registerBalanceVariant(balanceReaderFinanceSummary, shadowFinanceSummarySQL)
}

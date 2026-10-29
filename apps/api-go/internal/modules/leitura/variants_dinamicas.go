package leitura

import _ "embed"

//go:embed shadow/4a483e96_1.sql
var invoiceListVariantSQL string

func init() {
	registerBalanceVariant(balanceReaderInvoiceList, invoiceListVariantSQL)
}

package leitura

import _ "embed"

//go:embed shadow/due.sql
var dueShadowSQL string

// dueVariantInitRegistered reports that init stored shadow/due.sql on invoice-due.
var dueVariantInitRegistered bool

func init() {
	registerBalanceVariant(balanceReaderInvoiceDue, dueShadowSQL)
	dueVariantInitRegistered = balanceVariants[balanceReaderInvoiceDue] == dueShadowSQL
}

package leitura

import "embed"

//go:embed shadow/8d9dae54_3.sql shadow/4facfb98_0.sql
var balanceC2SQL embed.FS

func init() {
	registerBalanceVariant(balanceReaderTodayOverdue, mustBalanceC2SQL("shadow/8d9dae54_3.sql"))
	registerBalanceVariant(balanceReaderTerminationQuoteGet, mustBalanceC2SQL("shadow/4facfb98_0.sql"))
}

func mustBalanceC2SQL(name string) string {
	data, err := balanceC2SQL.ReadFile(name)
	if err != nil {
		panic(err)
	}
	return string(data)
}

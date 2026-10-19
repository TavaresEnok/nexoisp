import type { Invoice } from "../../lib/types";
import { normalize } from "../../domain/formatters";

export function selectInvoices(invoices: readonly Invoice[], status: string, query: string) {
  const rows = invoices.filter(i => (status === "Todas" || i.status === status) && normalize(`${i.name} ${i.code}`).includes(normalize(query)));
  return { rows, total: rows.reduce((sum, invoice) => sum + invoice.amount, 0) };
}

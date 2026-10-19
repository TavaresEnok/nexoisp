import type { Activity, Snapshot } from "../../lib/types";
import { date, money, number, percent } from "../../domain/formatters";

export const selectActivities = (activities: readonly Activity[], category: string) => activities.filter(a => category === "Todos" || a.type === category);
export function selectReportIndicators(snapshot: Snapshot): string[][] {
  return [
    ["Assinantes ativos", number(snapshot.active), "Contratos ativos no cenário"],
    ["Receita recorrente", money(snapshot.mrr), "Soma das mensalidades vigentes no cenário"],
    ["Recebido no mês", money(snapshot.received), `Até ${date(snapshot.asOf)} no cenário`],
    ["Inadimplência", `${snapshot.delinquency}%`, "Valor vencido / faturamento do cenário"],
    ["Sessões online", number(snapshot.online), "Sessões PPPoE, não contratos"],
    ["Disponibilidade", percent(snapshot.availability, 2), "Histórico sintético de 30 dias"],
  ];
}

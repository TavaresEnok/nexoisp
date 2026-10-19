import { useState } from "react";
import useSWR from "swr";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { FormField } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { api } from "@/platform/erp-client";
import { categoryLabels } from "./models";
import { orderKinds } from "@/features/field/create";
type CrmData = {
  timezone: string;
  leads: {
    source: string;
    created: number;
    won: number;
    lost: number;
    open: number;
  }[];
  tickets: {
    category: string;
    opened: number;
    closed: number;
    from_portal: number;
    first_response_h: number | null;
    resolution_h: number | null;
  }[];
  work_orders?: {
    kind: string;
    opened: number;
    done: number;
    canceled: number;
    completion_h: number | null;
  }[];
};
export function CrmReport() {
  const today = new Date().toLocaleDateString("en-CA");
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const result = useSWR(["erp-crm-report", from, to], ([, from, to]) =>
    api<CrmData>(`/crm/report?${new URLSearchParams({ from, to })}`),
  );
  const h = (value: number | null) =>
    value === null
      ? "—"
      : `${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} h`;
  return (
    <>
      <PageHeading
        title="Relatórios de atendimento"
        description="Conversão de oportunidades, protocolos e serviços no período."
        actions={
          <div className="erp-columns">
            <FormField label="Período desde">
              <Input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </FormField>
            <FormField label="Período até">
              <Input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </FormField>
          </div>
        }
      />
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {result.data && (
          <div className="erp-stack">
            <Panel title="Prospectos cadastrados por origem">
              {result.data.leads.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      {[
                        "Origem",
                        "Cadastrados",
                        "Convertidos",
                        "Perdidos",
                        "Em negociação",
                        "Conversão",
                      ].map((label) => (
                        <TableHead key={label}>{label}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.data.leads.map((row) => (
                      <TableRow key={row.source}>
                        <TableCell>{row.source || "Não informada"}</TableCell>
                        <TableCell>{row.created}</TableCell>
                        <TableCell>{row.won}</TableCell>
                        <TableCell>{row.lost}</TableCell>
                        <TableCell>{row.open}</TableCell>
                        <TableCell>
                          {row.created
                            ? `${Math.round((row.won / row.created) * 100)}%`
                            : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="profile-footnote">Nenhum prospecto no período.</p>
              )}
            </Panel>
            <Panel title="Atendimentos abertos por categoria">
              {result.data.tickets.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      {[
                        "Categoria",
                        "Abertos",
                        "Encerrados",
                        "Pelo portal",
                        "Primeira resposta (média)",
                        "Até encerrar (média)",
                      ].map((label) => (
                        <TableHead key={label}>{label}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.data.tickets.map((row) => (
                      <TableRow key={row.category}>
                        <TableCell>
                          {categoryLabels[row.category] ?? row.category}
                        </TableCell>
                        <TableCell>{row.opened}</TableCell>
                        <TableCell>{row.closed}</TableCell>
                        <TableCell>{row.from_portal}</TableCell>
                        <TableCell>{h(row.first_response_h)}</TableCell>
                        <TableCell>{h(row.resolution_h)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="profile-footnote">
                  Nenhum atendimento no período.
                </p>
              )}
            </Panel>
            {result.data.work_orders && (
              <Panel title="Ordens de serviço abertas por tipo">
                {result.data.work_orders.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {[
                          "Serviço",
                          "Abertas",
                          "Concluídas",
                          "Canceladas",
                          "Até concluir (média)",
                        ].map((label) => (
                          <TableHead key={label}>{label}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.data.work_orders.map((row) => (
                        <TableRow key={row.kind}>
                          <TableCell>
                            {orderKinds[row.kind] ?? row.kind}
                          </TableCell>
                          <TableCell>{row.opened}</TableCell>
                          <TableCell>{row.done}</TableCell>
                          <TableCell>{row.canceled}</TableCell>
                          <TableCell>{h(row.completion_h)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="profile-footnote">Nenhuma OS no período.</p>
                )}
              </Panel>
            )}
            <p className="profile-footnote">
              Datas no fuso {result.data.timezone}. Médias em horas corridas,
              calculadas a partir dos registros com resposta ou conclusão.
            </p>
          </div>
        )}
      </QueryBoundary>
    </>
  );
}

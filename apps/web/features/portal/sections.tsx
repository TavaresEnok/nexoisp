import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { Panel } from "@/components/workspace-ui";
import { OperationalCatalog } from "@/components/operational-catalog";
import { ProfileFacts } from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { FormField } from "@/features/shared/form";
import { money } from "@/lib/format";
import { shortCode } from "@/features/shared/format";
import { bytes } from "@/features/network/telemetry";
import { api } from "@/platform/erp-client";
import {
  overview,
  portalDate,
  portalAccessLabel,
  type PortalInvoice,
} from "./models";

// Seções do portal do assinante. A página inicial reúne todas; cada endereço
// /portal/<seção> mostra apenas a sua.
export type PortalOverview = z.infer<typeof overview>;
type SectionProps = { data: PortalOverview; refresh: () => Promise<unknown> };

export function PortalNotices({ data }: SectionProps) {
  return (
    <>
      {data.notices.map((item) => (
        <Panel
          key={item.id}
          title={`${item.active ? "Manutenção em andamento" : "Manutenção programada"} · ${item.title}`}
          description={`${portalDate(item.starts_at)} até ${portalDate(item.ends_at)}`}
        >
          <p role="status" className="whitespace-pre-wrap">
            {item.message}
          </p>
        </Panel>
      ))}
    </>
  );
}

export function PortalPlans({ data }: SectionProps) {
  return (
    <OperationalCatalog
      title="Meus planos"
      description="Situação comercial e de aplicação do acesso. Acesso liberado não comprova que seu roteador esteja conectado neste momento."
      columns={[
        "Plano",
        "Download / upload",
        "Mensalidade",
        "Vencimento",
        "Acesso",
      ]}
      rows={data.contracts.map((item) => ({
        id: item.id,
        cells: [
          item.plan_name,
          `${item.down_kbps / 1000} / ${item.up_kbps / 1000} Mbps`,
          money(item.price_cents / 100),
          `Dia ${item.due_day}`,
          portalAccessLabel(item),
        ],
      }))}
    />
  );
}

export function PortalTrustRelease({
  data,
  refresh,
  standalone,
}: SectionProps & { standalone?: boolean }) {
  const eligible = data.contracts.filter(
    (item) =>
      item.status === "active" &&
      (item.trust_release.eligible || item.trust_release.active_until),
  );
  if (!eligible.length)
    return standalone ? (
      <Panel title="Liberação por confiança">
        <p>Nenhum plano pode solicitar liberação por confiança agora.</p>
      </Panel>
    ) : null;
  return (
    <>
      {eligible.map((item) => (
        <Panel
          key={item.id}
          title="Liberação por confiança"
          description={item.plan_name}
        >
          {item.trust_release.active_until ? (
            <p>
              Liberação em curso até{" "}
              {portalDate(item.trust_release.active_until)}. Regularize as
              faturas para evitar nova suspensão após o prazo.
            </p>
          ) : (
            <>
              <p>
                O provedor permite solicitar até {item.trust_release.max_days}{" "}
                dias para regularizar a fatura, respeitando o intervalo entre
                solicitações. A aplicação depende da integração de acesso.
              </p>
              <ActionButton
                confirm={`Solicitar liberação do plano ${item.plan_name} por ${item.trust_release.max_days} dias?`}
                onClick={async () => {
                  await api("/portal/trust-release", {
                    body: { contract_id: item.id },
                  });
                  await refresh();
                }}
              >
                Solicitar liberação por {item.trust_release.max_days} dias
              </ActionButton>
            </>
          )}
        </Panel>
      ))}
    </>
  );
}

export function PortalInvoices({ data }: SectionProps) {
  const [paying, setPaying] = useState<PortalInvoice | null>(null);
  return (
    <>
      <OperationalCatalog
        title="Minhas faturas"
        description="Até trinta e seis faturas não canceladas. Meios de pagamento são apresentados quando emitidos pelo provedor."
        columns={["Referência", "Vencimento", "Valor", "Situação"]}
        rows={data.invoices.map((item) => ({
          id: item.id,
          cells: [
            item.competence
              ? `Mensalidade ${item.competence.slice(0, 7).split("-").reverse().join("/")}`
              : "Avulsa",
            portalDate(item.due_date),
            money(item.amount_cents / 100),
            item.status === "paid"
              ? "Paga"
              : item.overdue
                ? "Em atraso"
                : item.status === "open"
                  ? "Em aberto"
                  : item.status,
          ],
          actions: item.status === "open" && (
            <Button size="sm" variant="outline" onClick={() => setPaying(item)}>
              Pagar fatura {portalDate(item.due_date)}
            </Button>
          ),
        }))}
      />
      {paying && (
        <PaymentDetails invoice={paying} onClose={() => setPaying(null)} />
      )}
    </>
  );
}

export function PortalProfile({ data }: SectionProps) {
  return (
    <Panel
      title="Meus dados"
      description="Solicite ao provedor a correção de informações cadastrais."
    >
      <ProfileFacts
        items={[
          ["Nome", data.subscriber.name],
          ["CPF/CNPJ", data.subscriber.document ?? "Não informado"],
          ["E-mail", data.subscriber.email ?? "Não informado"],
          ["Telefone", data.subscriber.phone ?? "Não informado"],
          [
            "Endereço",
            [
              data.subscriber.address_street,
              data.subscriber.address_number,
              data.subscriber.address_city,
              data.subscriber.address_state,
            ]
              .filter(Boolean)
              .join(", ") || "Não informado",
          ],
        ]}
      />
    </Panel>
  );
}

function PaymentDetails({
  invoice,
  onClose,
}: {
  invoice: PortalInvoice;
  onClose: () => void;
}) {
  const methods = Object.entries(invoice.payment_methods ?? {}).filter(
    ([key]) => key !== "aviso",
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="erp-editor">
        <DialogHeader>
          <DialogTitle>Pagamento da fatura</DialogTitle>
          <DialogDescription>
            {money(invoice.amount_cents / 100)} · vencimento{" "}
            {portalDate(invoice.due_date)}
          </DialogDescription>
        </DialogHeader>
        {invoice.gateway === "demo" && (
          <p role="status">
            <Badge variant="warning">SIMULADO</Badge> Códigos fictícios. Estes
            meios não recebem pagamentos reais.
          </p>
        )}
        {methods.length ? (
          methods.map(([key, value]) => (
            <FormField key={key} label={key.replaceAll("_", " ")}>
              <Input
                readOnly
                value={String(value)}
                onFocus={(event) => event.currentTarget.select()}
              />
              <ActionButton
                onClick={async () => {
                  await navigator.clipboard.writeText(String(value));
                }}
              >
                Copiar {key.replaceAll("_", " ")}
              </ActionButton>
            </FormField>
          ))
        ) : (
          <p>
            Esta fatura ainda não tem meio de pagamento online. Entre em contato
            com o provedor.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
const series = z.array(
  z.object({
    period: z.string(),
    bytes_in: z.coerce.number(),
    bytes_out: z.coerce.number(),
  }),
);
export function PortalUsage({
  contracts,
  usage,
}: {
  contracts: z.infer<typeof overview>["contracts"];
  usage: z.infer<typeof overview>["usage"];
}) {
  const [contract, setContract] = useState(
    contracts.find((item) => item.status === "active")?.id ??
      contracts[0]?.id ??
      "",
  );
  const [view, setView] = useState("month");
  const result = useSWR(
    view !== "month" && contract ? ["portal-usage", contract, view] : null,
    async () =>
      series.parse(
        await api(
          `/portal/usage-series?${new URLSearchParams({ contract_id: contract, by: view })}`,
        ),
      ),
  );
  const rows =
    view === "month"
      ? usage
          .filter((item) => item.contract_id === contract)
          .map((item) => ({ period: item.month, ...item }))
      : (result.data ?? []);
  return (
    <Panel
      title="Meu consumo"
      description="Download: dados recebidos por você. Upload: dados enviados por você. As leituras dependem dos registros recebidos pelo provedor."
    >
      <div className="erp-columns">
        <FormField label="Plano do consumo">
          <select
            className="commercial-select"
            value={contract}
            onChange={(event) => setContract(event.target.value)}
          >
            {contracts.map((item) => (
              <option value={item.id} key={item.id}>
                {item.plan_name} · {shortCode(item.id)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Período do meu consumo">
          <select
            className="commercial-select"
            value={view}
            onChange={(event) => setView(event.target.value)}
          >
            {[
              ["month", "Mensal"],
              ["hour", "Por hora"],
              ["day", "Por dia"],
              ["week", "Por semana"],
              ["year", "Por ano"],
            ].map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <QueryBoundary
        loading={view !== "month" && result.isLoading}
        error={view !== "month" ? result.error : undefined}
        retry={() => result.mutate()}
      >
        <OperationalCatalog
          title="Histórico de consumo"
          description={
            view === "month"
              ? "Até doze registros mensais retornados pelo provedor."
              : "Série conforme o fuso e o período de retenção do provedor."
          }
          columns={["Período", "Download", "Upload"]}
          rows={rows.map((item) => ({
            id: item.period,
            cells: [item.period, bytes(item.bytes_out), bytes(item.bytes_in)],
          }))}
          empty="Nenhum consumo registrado neste período."
        />
      </QueryBoundary>
    </Panel>
  );
}

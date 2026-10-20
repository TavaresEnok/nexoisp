import { useEffect, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  CircleDollarSign,
  ClipboardList,
  Download,
  Headphones,
  Network,
  Pencil,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Status } from "@/components/workspace-ui";
import {
  CopyValue,
  RegistrationView,
  FinancialTotals,
  ProfileFacts,
  ProfileSection,
} from "@/components/subscriber-profile-sections";
import { SubscriberContractList } from "@/components/subscriber-contracts";
import { HistoryTimeline } from "@/components/subscriber-history";
import {
  SubscriberExpandButton,
  SubscriberOverview,
  SubscriberSheetHeader,
  SubscriberSheetTabs,
} from "@/components/subscriber-sheet-parts";
import { QueryBoundary } from "@/features/shared/feedback";
import { can, hasModule } from "@/features/session/model";
import { useSession } from "@/features/session/provider";
import { readSubscriber } from "@/data/erp/subscribers";
import { api, erpClient } from "@/platform/erp-client";
import { copyText } from "@/platform/browser";
import { toast } from "sonner";
import { date, exportCsv, money } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SubscriberEditor } from "./form";
import { CreateContract } from "@/features/contracts/create";
import { LazyContractFinance as ContractFinance } from "@/features/finance/lazy";
import { LazyLinkedOrders } from "@/features/field/lazy";
import { LazySubscriberTickets } from "@/features/crm/lazy";
import { LazyContractService } from "@/features/network/lazy";
import { SubscriberSections } from "./sections";
import { SubscriberServiceWorkspace } from "./service";
import { TechnicalHeading } from "@/components/subscriber-technical-panels";
import { EmptyState } from "@/components/workspace-feedback";
import { Badge } from "@/components/ui/badge";
import { SubscriberAlerts } from "./notes";
import type { SubscriberDetail } from "./model";
import {
  formatDocument,
  formatPhone,
  shortCode,
} from "@/features/shared/format";

type ContractInvoice = {
  status: "open" | "paid" | "canceled" | "reconciling";
  overdue: boolean;
  amount_cents: number;
  paid_cents: number;
  due_date: string;
};
type AccessState = {
  commercial: { state: string; credit_restricted_at: string | null };
  access: { state: string };
};
type TimelineEvent = {
  kind: string;
  title: string;
  detail?: string;
  at: string;
  by?: string;
  contract_id?: string;
};

const accessLabel: Record<string, string> = {
  active: "Ativo",
  blocked: "Bloqueado",
  no_account: "Não provisionado",
};

export function OperationalSubscriberSheet() {
  const [params, setParams] = useSearchParams();
  const id = params.get("ficha");
  const [expanded, setExpanded] = useState(false);
  const close = () => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("ficha");
        next.delete("abaFicha");
        return next;
      },
      { replace: true },
    );
    setExpanded(false);
  };
  return (
    <Sheet
      open={Boolean(id)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent
        className={cn(
          "subscriber-sheet",
          "subscriber-workspace",
          expanded && "subscriber-workspace-expanded",
        )}
      >
        {id && (
          <SubscriberDetails
            key={id}
            id={id}
            expanded={expanded}
            onExpand={() => setExpanded((value) => !value)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

async function count(path: string) {
  const response = await erpClient.request<unknown>(path);
  if (response.total === null)
    throw new Error("O servidor não informou a contagem de registros.");
  return response.total;
}

function optionalFacts(
  items: [string, string | null | undefined][],
): [string, string][] {
  return items.filter((item): item is [string, string] => Boolean(item[1]));
}

function contractAddress(
  contract: SubscriberDetail["contracts"][number],
  subscriber: SubscriberDetail,
) {
  const own = [contract.install_street, contract.install_number]
    .filter(Boolean)
    .join(", ");
  if (own)
    return [own, contract.install_district, contract.install_city]
      .filter(Boolean)
      .join(" · ");
  const registered = [subscriber.address_street, subscriber.address_number]
    .filter(Boolean)
    .join(", ");
  return registered
    ? `${registered} · endereço cadastral`
    : "Endereço de instalação não informado";
}

function SubscriberDetails({
  id,
  expanded,
  onExpand,
}: {
  id: string;
  expanded: boolean;
  onExpand: () => void;
}) {
  const { me } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState(false);
  const [creatingContract, setCreatingContract] = useState(false);
  const { mutate } = useSWRConfig();
  const copy = async (value: string) => {
    try {
      await copyText(value);
      toast.success("Copiado para a área de transferência.");
    } catch {
      toast.error("O navegador não permitiu copiar o texto.");
    }
  };
  const subscriber = useSWR(["erp-subscriber", id], ([, id]) =>
    readSubscriber(id),
  );
  const s = subscriber.data;
  const finance = can(me, "finance:read");
  const network = can(me, "network:read");
  const crm = can(me, "crm:read") && hasModule(me, "crm");
  const field = can(me, "os:read") && hasModule(me, "field");
  const contractIds = s?.contracts.map((contract) => contract.id) ?? [];
  const activeContracts =
    s?.contracts.filter((contract) => contract.status === "active") ?? [];
  const invoices = useSWR(
    s && finance && contractIds.length
      ? ["erp-contract-finance", "subscriber", ...contractIds]
      : null,
    async () =>
      (
        await Promise.all(
          contractIds.map((contractId) =>
            api<{ invoices: ContractInvoice[] }>(
              `/contracts/${contractId}/finance`,
            ),
          ),
        )
      ).flatMap((result) => result.invoices),
  );
  const states = useSWR(
    s && activeContracts.length
      ? [
          "erp-contract-states",
          "subscriber",
          ...activeContracts.map((c) => c.id),
        ]
      : null,
    async () =>
      Promise.all(
        activeContracts.map((contract) =>
          api<AccessState>(`/contracts/${contract.id}/states`),
        ),
      ),
  );
  const openTickets = useSWR(crm ? ["erp-tickets", "count", id] : null, () =>
    count(
      `/tickets?${new URLSearchParams({ subscriber_id: id, status: "pending" })}&limit=1`,
    ),
  );
  const openOrders = useSWR(field ? ["erp-orders", "count", id] : null, () =>
    count(
      `/work-orders?${new URLSearchParams({ subscriber_id: id, status: "pending" })}&limit=1`,
    ),
  );
  const timeline = useSWR(s ? ["erp-timeline", id] : null, ([, id]) =>
    api<TimelineEvent[]>(`/subscribers/${id}/timeline`),
  );
  const tabs = [
    ["resumo", "Visão geral"],
    ["cadastro", "Cadastro"],
    ["contrato", "Contratos"],
    ...(finance ? [["financeiro", "Financeiro"]] : []),
    ...(network ? [["conexao", "Conexão"]] : []),
    ...(crm || field ? [["atendimento", "Atendimento e OS"]] : []),
    ["documentos", "Documentos e privacidade"],
    ["historico", "Histórico"],
  ];
  const tab = tabs.some(([key]) => key === params.get("abaFicha"))
    ? params.get("abaFicha")!
    : "resumo";
  const setTab = (value: string) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        value === "resumo"
          ? next.delete("abaFicha")
          : next.set("abaFicha", value);
        return next;
      },
      { replace: true },
    );
  const revalidateSummary = () =>
    Promise.all([
      timeline.mutate(),
      invoices.mutate(),
      states.mutate(),
      openTickets.mutate(),
      openOrders.mutate(),
    ]);
  // Ações nas abas geram eventos e mudam totais; cada troca de aba relê o resumo.
  useEffect(() => {
    void revalidateSummary();
  }, [tab]);
  const refresh = async () => {
    await Promise.all([
      subscriber.mutate(),
      mutate((key) => Array.isArray(key) && key[0] === "erp-subscribers"),
      revalidateSummary(),
    ]);
  };
  const remaining = (invoice: ContractInvoice) =>
    Math.max(0, invoice.amount_cents - invoice.paid_cents);
  const sum = (rows: ContractInvoice[], value = remaining) =>
    rows.reduce((total, invoice) => total + value(invoice), 0);
  const rows = invoices.data ?? [];
  const overdue = rows.filter((i) => i.status === "open" && i.overdue);
  const pending = rows.filter((i) => i.status === "open" && !i.overdue);
  const reconciling = rows.filter((i) => i.status === "reconciling");
  const paid = rows.filter((i) => i.status === "paid");
  const overdueCents = sum(overdue);
  const oldestOverdue = overdue.map((i) => i.due_date).sort()[0];
  const overdueDays = oldestOverdue
    ? Math.max(
        0,
        Math.floor(
          (Date.now() -
            new Date(
              `${oldestOverdue.slice(0, 10)}T00:00:00-03:00`,
            ).getTime()) /
            86400000,
        ),
      )
    : 0;
  const monthly =
    activeContracts.reduce(
      (total, contract) => total + contract.price_cents,
      0,
    ) / 100;
  const accessStates = states.data ?? [];
  const blocked = accessStates.filter(
    (state) => state.access.state === "blocked",
  );
  const unprovisioned = accessStates.filter(
    (state) => state.access.state === "no_account",
  );
  const restricted = accessStates.filter(
    (state) => state.commercial.state === "credit_restricted",
  );
  const exportProfile = () =>
    s &&
    exportCsv(
      `nexo-ficha-${s.id.slice(0, 8)}`,
      [
        "Código",
        "Nome",
        "Documento",
        "E-mail",
        "Telefone",
        "Endereço",
        "Bairro",
        "Cidade",
        "Contratos vigentes",
        "Planos",
        "Mensalidade base",
        "Situação cadastral",
      ],
      [
        [
          s.id,
          s.name,
          s.document ?? "",
          s.email ?? "",
          s.phone ?? "",
          [s.address_street, s.address_number].filter(Boolean).join(", "),
          s.address_district ?? "",
          [s.address_city, s.address_state].filter(Boolean).join(" / "),
          activeContracts.length,
          activeContracts.map((contract) => contract.plan_name).join("; "),
          monthly,
          s.status === "active" ? "Ativo" : "Inativo",
        ],
      ],
    );
  const contractList = s && (
    <SubscriberContractList
      count={s.contracts.length}
      total={monthly}
      totalLabel="Mensalidade base dos contratos vigentes"
      empty="O titular ainda não possui contratos."
      onConsult={() =>
        navigate(`/contratos?busca=${encodeURIComponent(s.name)}`)
      }
      contracts={s.contracts.map((contract) => ({
        id: contract.id,
        title: `${contract.plan_name} · #${shortCode(contract.id)}`,
        status: contract.status === "active" ? "Vigente" : "Encerrado",
        plan: `${contract.plan_name} v${contract.plan_version} · ${contract.down_kbps / 1000} / ${contract.up_kbps / 1000} Mbps`,
        address: contractAddress(contract, s),
        monthly: contract.price_cents / 100,
        dueDay: contract.due_day,
        action: (
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/contratos/${contract.id}`)}
          >
            Abrir contrato
            <ArrowUpRight data-icon="inline-end" />
          </Button>
        ),
      }))}
    />
  );
  return (
    <>
      {s ? (
        <SubscriberSheetHeader
          code={shortCode(id)}
          name={s.name}
          description={[
            `${s.contracts.length} contrato(s)`,
            `Cliente desde ${date(s.created_at)}`,
            s.address_district || s.address_city,
          ]
            .filter(Boolean)
            .join(" · ")}
          statuses={[s.status === "active" ? "Ativo" : "Inativo"]}
          context="Cadastro conectado ao ERP"
        />
      ) : (
        <SubscriberSheetHeader
          code={shortCode(id)}
          name={
            subscriber.error
              ? "Assinante não encontrado"
              : "Carregando assinante…"
          }
          description="Consulta ao cadastro do provedor"
          statuses={[]}
          context="Cadastro conectado ao ERP"
        />
      )}
      <div className="subscriber-quick-actions">
        {s && crm && (
          <Button
            variant="outline"
            onClick={() =>
              navigate(`/atendimentos?busca=${encodeURIComponent(s.name)}`)
            }
          >
            <Headphones data-icon="inline-start" />
            Atendimentos
            <ArrowUpRight data-icon="inline-end" />
          </Button>
        )}
        {s && (
          <Button variant="outline" onClick={exportProfile}>
            <Download data-icon="inline-start" />
            Exportar ficha
          </Button>
        )}
        {s && s.status === "active" && can(me, "contracts:write") && (
          <Button variant="outline" onClick={() => setCreatingContract(true)}>
            Novo contrato
          </Button>
        )}
        {s && can(me, "subscribers:write") && !s.anonymized_at && (
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil data-icon="inline-start" />
            Editar cadastro
          </Button>
        )}
        <SubscriberExpandButton expanded={expanded} onExpand={onExpand} />
      </div>
      {s && <SubscriberAlerts id={id} />}
      <QueryBoundary
        loading={subscriber.isLoading}
        error={subscriber.error}
        retry={() => subscriber.mutate()}
      >
        {s && (
          <SubscriberSheetTabs
            value={tab}
            onChange={setTab}
            tabs={tabs.map(([value, label]) => ({
              value,
              label,
              alert: value === "financeiro" && overdue.length > 0,
              count:
                value === "atendimento" && openTickets.data
                  ? openTickets.data
                  : undefined,
            }))}
          >
            <TabsContent value="resumo">
              <SubscriberOverview
                kpis={[
                  {
                    label: "Mensalidade total do titular",
                    value: money(monthly),
                    detail: `${activeContracts.length} contrato(s) · vigentes`,
                    onClick: () => setTab("contrato"),
                  },
                  {
                    label: "Saldo vencido registrado",
                    value: finance
                      ? invoices.data
                        ? money(overdueCents / 100)
                        : "…"
                      : "—",
                    danger: overdueCents > 0,
                    detail: !finance
                      ? "Disponível para perfis financeiros"
                      : overdue.length
                        ? `${overdue.length} título(s) · até ${overdueDays} dias`
                        : "Sem títulos vencidos registrados",
                    onClick: finance ? () => setTab("financeiro") : undefined,
                  },
                  {
                    label: "Atendimentos em aberto",
                    value: crm
                      ? String(openTickets.data ?? 0).padStart(2, "0")
                      : "—",
                    detail: crm
                      ? "Pendentes neste titular"
                      : "Módulo de atendimento indisponível",
                    onClick:
                      crm || field ? () => setTab("atendimento") : undefined,
                  },
                  {
                    label: "Ordens de serviço pendentes",
                    value: field
                      ? String(openOrders.data ?? 0).padStart(2, "0")
                      : "—",
                    detail: field
                      ? "Pendentes neste titular"
                      : "Módulo de campo indisponível",
                    onClick:
                      crm || field ? () => setTab("atendimento") : undefined,
                  },
                ]}
                attention={[
                  ...(blocked.length
                    ? [
                        {
                          icon: Network,
                          title: `${blocked.length} contrato(s) com acesso bloqueado`,
                          detail:
                            "Estado desejado registrado no ERP. Confira causa e confirmação no equipamento.",
                          onClick: () =>
                            setTab(network ? "conexao" : "contrato"),
                        },
                      ]
                    : []),
                  ...(overdue.length
                    ? [
                        {
                          icon: CircleDollarSign,
                          title: `${money(overdueCents / 100)} em títulos vencidos`,
                          detail:
                            "Confira as cobranças antes de tratar uma suspensão como falha técnica.",
                          onClick: () => setTab("financeiro"),
                        },
                      ]
                    : []),
                  ...(restricted.length
                    ? [
                        {
                          icon: ShieldAlert,
                          title: "Restrição de crédito registrada",
                          detail:
                            "A restrição é comercial e não bloqueia o acesso por si.",
                          onClick: () => setTab("contrato"),
                        },
                      ]
                    : []),
                  ...(unprovisioned.length
                    ? [
                        {
                          icon: ClipboardList,
                          title: `${unprovisioned.length} contrato(s) sem acesso provisionado`,
                          detail:
                            "Confira a OS de instalação e o provisionamento do acesso.",
                          onClick: () =>
                            setTab(field || crm ? "atendimento" : "contrato"),
                        },
                      ]
                    : []),
                ]}
                contracts={contractList}
                contact={{
                  phone: formatPhone(s.phone),
                  email: s.email,
                  caption: "Informação útil no primeiro atendimento.",
                  facts: [
                    [
                      "Endereço",
                      [s.address_street, s.address_number]
                        .filter(Boolean)
                        .join(", ") || "—",
                    ],
                    ["Bairro", s.address_district || "—"],
                    ["Documento", formatDocument(s.document) || "—"],
                    [
                      "Cidade / UF",
                      [s.address_city, s.address_state]
                        .filter(Boolean)
                        .join(" / ") || "—",
                    ],
                  ],
                  onOpen: () => setTab("cadastro"),
                }}
                technical={{
                  caption:
                    "Estado de acesso registrado no ERP para os contratos vigentes.",
                  facts: [
                    [
                      "Acesso registrado",
                      accessStates.length ? (
                        <Status
                          key="access"
                          value={
                            accessLabel[accessStates[0].access.state] ??
                            accessStates[0].access.state
                          }
                        />
                      ) : activeContracts.length ? (
                        "Consultando…"
                      ) : (
                        "Sem contrato vigente"
                      ),
                    ],
                    [
                      "Contratos liberados",
                      accessStates.length
                        ? `${accessStates.filter((state) => state.access.state === "active").length} de ${accessStates.length}`
                        : "—",
                    ],
                    [
                      "Velocidade contratada",
                      activeContracts[0]
                        ? `${activeContracts[0].down_kbps / 1000} / ${activeContracts[0].up_kbps / 1000} Mbps`
                        : "—",
                    ],
                    ["Plano principal", activeContracts[0]?.plan_name ?? "—"],
                  ],
                  footnote:
                    "É a intenção registrada no ERP. A confirmação no equipamento fica na aba Conexão.",
                  onOpen: network ? () => setTab("conexao") : undefined,
                }}
                recent={{
                  items: (timeline.data ?? [])
                    .slice(0, 3)
                    .map((event, index) => ({
                      id: `${event.at}-${index}`,
                      title: event.title,
                      description: event.detail,
                      meta: `${date(event.at)} · ${event.by ?? "Sistema"}`,
                    })),
                  loading: timeline.isLoading,
                  empty: timeline.error
                    ? "Não foi possível consultar os eventos."
                    : "Nenhum evento registrado.",
                  onAll: () => setTab("historico"),
                }}
                footnote="Resumo dos registros do ERP conforme suas permissões. Não é monitoramento em tempo real."
              />
            </TabsContent>
            <TabsContent value="cadastro">
              <div className="sheet-content-body">
                <RegistrationView
                  identity={[
                    ["Nome / Razão social", s.name],
                    [
                      "CPF / CNPJ",
                      formatDocument(s.document) || "Não informado",
                    ],
                    ["Código do assinante", shortCode(s.id)],
                    ["Cliente desde", date(s.created_at)],
                    [
                      "E-mail principal",
                      s.email ? (
                        <CopyValue
                          key="email"
                          href={`mailto:${s.email}`}
                          value={s.email}
                          label="Copiar e-mail"
                          copy={copy}
                        />
                      ) : (
                        "Não informado"
                      ),
                    ],
                    [
                      "Telefone principal",
                      s.phone ? (
                        <CopyValue
                          key="phone"
                          href={`tel:${s.phone.replace(/[^+\d]/g, "")}`}
                          value={formatPhone(s.phone)}
                          label="Copiar telefone"
                          copy={copy}
                        />
                      ) : (
                        "Não informado"
                      ),
                    ],
                    ...optionalFacts([
                      [
                        "Nascimento / abertura",
                        s.birth_date ? date(s.birth_date) : null,
                      ],
                      [
                        "RG / Emissor",
                        [s.rg, s.rg_issuer].filter(Boolean).join(" / ") || null,
                      ],
                      ["Nome da mãe", s.mother_name],
                      ["Nome fantasia", s.trade_name],
                    ]),
                  ]}
                  addressTitle="Endereço cadastral"
                  addressCaption="Endereço do titular; cada contrato pode ter o seu."
                  address={{
                    line:
                      [s.address_street, s.address_number]
                        .filter(Boolean)
                        .join(", ") || "Endereço não informado",
                    detail:
                      [s.address_district, s.address_city, s.address_state]
                        .filter(Boolean)
                        .join(" · ") || "Bairro e cidade não informados",
                  }}
                  addressFacts={[
                    ["Bairro", s.address_district || "Não informado"],
                    [
                      "Cidade / UF",
                      [s.address_city, s.address_state]
                        .filter(Boolean)
                        .join(" / ") || "Não informado",
                    ],
                    ...optionalFacts([
                      ["CEP", s.address_zip],
                      ["Observações", s.notes],
                    ]),
                  ]}
                />
                <SubscriberSections
                  subscriber={s}
                  section="cadastro"
                  refresh={refresh}
                />
              </div>
            </TabsContent>
            <TabsContent value="contrato">
              <div className="sheet-content-body">
                {contractList}
                <p className="profile-footnote">
                  Fidelidade, descontos, adicionais e aceite ficam na ficha de
                  cada contrato.
                </p>
              </div>
            </TabsContent>
            {finance && (
              <TabsContent value="financeiro">
                <div className="sheet-content-body">
                  <QueryBoundary
                    loading={invoices.isLoading}
                    error={invoices.error}
                    retry={() => invoices.mutate()}
                  >
                    <FinancialTotals
                      items={[
                        [
                          "Vencido",
                          money(overdueCents / 100),
                          `${overdue.length} título(s)`,
                        ],
                        [
                          "A vencer",
                          money(sum(pending) / 100),
                          `${pending.length} título(s)`,
                        ],
                        [
                          "Em conciliação",
                          money(sum(reconciling) / 100),
                          "Baixa não confirmada",
                        ],
                        [
                          "Pago nos títulos listados",
                          money(sum(paid, (i) => i.paid_cents) / 100),
                          `${paid.length} título(s)`,
                        ],
                      ]}
                    />
                  </QueryBoundary>
                  {s.contracts.length ? (
                    s.contracts.map((contract) => (
                      <ContractFinance
                        key={contract.id}
                        id={contract.id}
                        totals={false}
                        title={`Títulos · ${contract.plan_name} · #${shortCode(contract.id)}`}
                      />
                    ))
                  ) : (
                    <p className="profile-footnote">
                      O titular ainda não possui contratos.
                    </p>
                  )}
                  <p className="profile-footnote">
                    Pagamento em conciliação não é considerado recebido. Multa,
                    juros e saldo devido são calculados pelo servidor.
                  </p>
                </div>
              </TabsContent>
            )}
            {(crm || field) && (
              <TabsContent value="atendimento">
                <div className="sheet-content-body">
                  <SubscriberServiceWorkspace
                    firstName={s.name.split(" ")[0]}
                    openTickets={crm ? (openTickets.data ?? null) : null}
                    openOrders={field ? (openOrders.data ?? null) : null}
                    events={timeline.data ? timeline.data.length : null}
                    onHistory={() => setTab("historico")}
                    tickets={
                      crm ? <LazySubscriberTickets id={s.id} /> : undefined
                    }
                    orders={
                      field ? (
                        <LazyLinkedOrders subscriberId={s.id} />
                      ) : undefined
                    }
                  />
                </div>
              </TabsContent>
            )}
            {network && (
              <TabsContent value="conexao">
                <div className="sheet-content-body">
                  <div className="technical-workspace">
                    <div className="profile-manual-banner">
                      <ShieldCheck size={18} />
                      <div>
                        <strong>Intenção e equipamento, lado a lado.</strong>
                        <p>
                          O estado desejado vem do ERP; a confirmação vem do
                          relato do agente ou do concentrador. Ações remotas
                          dependem da sua permissão.
                        </p>
                      </div>
                      <Badge variant="outline">Por contrato</Badge>
                    </div>
                    {s.contracts.length ? (
                      s.contracts.map((contract) => (
                        <div className="erp-stack" key={contract.id}>
                          <TechnicalHeading
                            title={`Acesso · ${contract.plan_name}`}
                            description={`Contrato #${shortCode(contract.id)} · ${contract.down_kbps / 1000} / ${contract.up_kbps / 1000} Mbps · ${contract.status === "active" ? "vigente" : "encerrado"}`}
                          />
                          <LazyContractService
                            id={contract.id}
                            status={contract.status}
                          />
                        </div>
                      ))
                    ) : (
                      <EmptyState
                        icon={Network}
                        title="Nenhum contrato com acesso"
                        description="O titular ainda não possui contratos."
                      />
                    )}
                  </div>
                </div>
              </TabsContent>
            )}
            <TabsContent value="documentos">
              <div className="sheet-content-body">
                <SubscriberSections
                  subscriber={s}
                  section="documentos"
                  refresh={refresh}
                />
              </div>
            </TabsContent>
            <TabsContent value="historico">
              <div className="sheet-content-body">
                <ProfileSection
                  title="Histórico e marcos do assinante"
                  caption="Do mais recente ao mais antigo: contrato, rede, fatura, pagamento, OS e atendimento, conforme suas permissões."
                >
                  <QueryBoundary
                    loading={timeline.isLoading}
                    error={timeline.error}
                    retry={() => timeline.mutate()}
                  >
                    <HistoryTimeline
                      entries={(timeline.data ?? [])
                        .slice(0, 80)
                        .map((event, index) => ({
                          id: `${event.at}-${index}`,
                          title: event.title,
                          description: event.detail,
                          at: event.at,
                          instant: true,
                          meta: ` · ${event.by ?? "Sistema"}`,
                          action: event.contract_id ? (
                            <a
                              className="profile-text-action"
                              href={`/contratos/${event.contract_id}`}
                            >
                              Abrir contrato
                            </a>
                          ) : undefined,
                        }))}
                    />
                    {!timeline.data?.length && (
                      <p className="profile-footnote">
                        Nenhum evento disponível.
                      </p>
                    )}
                  </QueryBoundary>
                </ProfileSection>
              </div>
            </TabsContent>
          </SubscriberSheetTabs>
        )}
      </QueryBoundary>
      <div className="sheet-bottom-note">
        <ShieldCheck size={13} />
        Dados do provedor conforme suas permissões · equipamentos não são
        consultados automaticamente
      </div>
      {creatingContract && (
        <CreateContract
          subscriberId={id}
          onClose={() => setCreatingContract(false)}
          onDone={async () => {
            setCreatingContract(false);
            setTab("contrato");
            await refresh();
          }}
        />
      )}
      {editing && s && (
        <SubscriberEditor
          initial={s}
          onClose={() => setEditing(false)}
          onDone={async () => {
            setEditing(false);
            await refresh();
          }}
        />
      )}
    </>
  );
}

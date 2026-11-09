import { useState, type FormEvent, type ReactNode } from "react";
import useSWR from "swr";
import { z } from "zod";
import { Link } from "react-router-dom";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { ProfileFacts } from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { FormField, MutationForm } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { searchSchema } from "@/features/search/models";
import { invoiceSchema } from "@/features/finance/models";
import { orderSchema } from "@/features/field/models";
import { orderKinds, orderStates } from "@/features/field/labels";
import { stamp } from "@/features/network/models";
import { api, erpClient } from "@/platform/erp-client";
import { money, date } from "@/lib/format";
import {
  allowedIntents,
  intentLabels,
  parseIntent,
  suggestionsFor,
  type AssistantIntent,
} from "./intents";

type Search = z.infer<typeof searchSchema>["results"];
type Entry = { id: number; question: string; intent: AssistantIntent };

const diagnosisSchema = z.object({
  severity: z.string(),
  verdict: z.string(),
  limits: z.string(),
  findings: z.array(
    z.object({
      code: z.string(),
      severity: z.string(),
      title: z.string(),
      suggestion: z.string().optional(),
    }),
  ),
});
const legalSchema = z.object({
  sessions: z.array(
    z.object({
      subscriber_id: z.string(),
      name: z.string(),
      login: z.string(),
      ip: z.string(),
      started_at: z.string(),
      stopped_at: z.string().nullable(),
    }),
  ),
  fixed: z.array(z.object({ ip: z.string(), name: z.string() })),
  notes: z.array(z.string()),
});

function useSearch(term: string | null) {
  return useSWR(term ? ["assistant-search", term] : null, async ([, q]) =>
    searchSchema.parse(await api(`/search?q=${encodeURIComponent(q)}`)),
  );
}
const contractsOf = (results: Search) =>
  results.filter(
    (row, index) =>
      row.contract_id &&
      results.findIndex((other) => other.contract_id === row.contract_id) ===
        index,
  );
const subscriberLink = (id: string) => `/assinantes?ficha=${id}`;
const contractLink = (id: string) => `/contratos?contrato=${id}`;

function Answer({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="erp-contract-card">
      <header>
        <strong>{title}</strong>
      </header>
      {children}
    </div>
  );
}

function SearchBoundary({
  term,
  children,
}: {
  term: string;
  children: (results: Search) => ReactNode;
}) {
  const result = useSearch(term);
  return (
    <QueryBoundary
      loading={result.isLoading}
      error={result.error}
      retry={() => result.mutate()}
    >
      {result.data &&
        (result.data.results.length ? (
          children(result.data.results)
        ) : (
          <p role="status">Nenhum cliente encontrado para “{term}”.</p>
        ))}
    </QueryBoundary>
  );
}

function CustomerAnswer({ subject }: { subject: string }) {
  return (
    <SearchBoundary term={subject}>
      {(results) => (
        <ul className="erp-stack" aria-label="Clientes encontrados">
          {results.slice(0, 10).map((row) => (
            <li key={row.contract_id ?? row.subscriber_id}>
              <Link
                className="profile-text-action"
                to={subscriberLink(row.subscriber_id)}
              >
                {row.subscriber_name}
              </Link>{" "}
              {row.document && <small>· {row.document}</small>}{" "}
              {row.contract_id && (
                <Link
                  className="profile-text-action"
                  to={contractLink(row.contract_id)}
                >
                  {row.plan_name || "Abrir contrato"}
                </Link>
              )}{" "}
              {row.pppoe_username && (
                <small>· login {row.pppoe_username}</small>
              )}{" "}
              {row.online != null && (
                <Badge variant={row.online ? "outline" : "warning"}>
                  {row.online ? "Online" : "Offline"}
                </Badge>
              )}{" "}
              {row.overdue != null && row.overdue > 0 && (
                <Badge variant="warning">
                  {row.overdue} fatura(s) vencida(s)
                </Badge>
              )}
            </li>
          ))}
          {results.length > 10 && (
            <li>
              <Link
                className="profile-text-action"
                to={`/busca?q=${encodeURIComponent(subject)}`}
              >
                Ver os {results.length} resultados na busca
              </Link>
            </li>
          )}
        </ul>
      )}
    </SearchBoundary>
  );
}

function Diagnosis({ contract, name }: { contract: string; name: string }) {
  const result = useSWR(["assistant-diagnosis", contract], async () =>
    diagnosisSchema.parse(await api(`/contracts/${contract}/diagnosis`)),
  );
  return (
    <QueryBoundary
      loading={result.isLoading}
      error={result.error}
      retry={() => result.mutate()}
    >
      {result.data && (
        <div className="erp-stack">
          <p>
            <strong>{name}:</strong> {result.data.verdict}
          </p>
          <ul>
            {result.data.findings.slice(0, 5).map((finding) => (
              <li key={finding.code}>
                {finding.title}
                {finding.suggestion ? ` — ${finding.suggestion}` : ""}
              </li>
            ))}
          </ul>
          <p className="profile-footnote">{result.data.limits}</p>
          <Link className="profile-text-action" to={contractLink(contract)}>
            Abrir contrato e diagnóstico completo
          </Link>
        </div>
      )}
    </QueryBoundary>
  );
}

function DiagnosisAnswer({ subject }: { subject: string }) {
  const [chosen, setChosen] = useState<string | null>(null);
  return (
    <SearchBoundary term={subject}>
      {(results) => {
        const contracts = contractsOf(results);
        if (!contracts.length)
          return <p role="status">O cliente encontrado não tem contrato.</p>;
        const selected =
          contracts.length === 1
            ? contracts[0]
            : contracts.find((row) => row.contract_id === chosen);
        return (
          <>
            {contracts.length > 1 && (
              <div
                className="erp-inline-actions"
                role="group"
                aria-label="Escolha o contrato"
              >
                {contracts.slice(0, 8).map((row) => (
                  <Button
                    key={row.contract_id}
                    variant={row.contract_id === chosen ? "default" : "outline"}
                    size="sm"
                    onClick={() => setChosen(row.contract_id)}
                  >
                    Diagnosticar {row.subscriber_name}
                    {row.plan_name ? ` · ${row.plan_name}` : ""}
                  </Button>
                ))}
              </div>
            )}
            {selected?.contract_id && (
              <Diagnosis
                contract={selected.contract_id}
                name={selected.subscriber_name}
              />
            )}
          </>
        );
      }}
    </SearchBoundary>
  );
}

function OverdueList({ path, label }: { path: string; label?: string }) {
  const result = useSWR(["assistant-invoices", path], async ([, query]) => {
    const response = await erpClient.request(query);
    return {
      rows: z.array(invoiceSchema).parse(response.data),
      total: response.total,
    };
  });
  return (
    <QueryBoundary
      loading={result.isLoading}
      error={result.error}
      retry={() => result.mutate()}
    >
      {result.data &&
        (result.data.rows.length ? (
          <ul aria-label={label ?? "Faturas vencidas"}>
            {result.data.rows.map((invoice) => (
              <li key={invoice.id}>
                <Link
                  className="profile-text-action"
                  to={subscriberLink(invoice.subscriber_id)}
                >
                  {invoice.subscriber_name}
                </Link>{" "}
                · vencimento {date(invoice.due_date)} · valor{" "}
                {money(invoice.amount_cents / 100)}
              </li>
            ))}
            {result.data.total != null &&
              result.data.total > result.data.rows.length && (
                <li>
                  Mais {result.data.total - result.data.rows.length} fatura(s).
                </li>
              )}
          </ul>
        ) : (
          <p role="status">Nenhuma fatura vencida{label ? ` ${label}` : ""}.</p>
        ))}
    </QueryBoundary>
  );
}

function OverdueAnswer({ subject }: { subject: string | null }) {
  const footer = (
    <Link
      className="profile-text-action"
      to="/financeiro/faturas?situacao=Vencida"
    >
      Abrir faturas vencidas
    </Link>
  );
  if (!subject)
    return (
      <>
        <OverdueList path="/invoices?status=overdue&limit=10&offset=0" />
        {footer}
      </>
    );
  return (
    <SearchBoundary term={subject}>
      {(results) => {
        const contracts = contractsOf(results).slice(0, 5);
        return contracts.length ? (
          <>
            {contracts.map((row) => (
              <div key={row.contract_id}>
                <p>
                  <Link
                    className="profile-text-action"
                    to={contractLink(row.contract_id!)}
                  >
                    {row.subscriber_name}
                    {row.plan_name ? ` · ${row.plan_name}` : ""}
                  </Link>
                </p>
                <OverdueList
                  path={`/invoices?status=overdue&contract_id=${row.contract_id}&limit=20&offset=0`}
                  label={`de ${row.subscriber_name}`}
                />
              </div>
            ))}
            {footer}
          </>
        ) : (
          <p role="status">O cliente encontrado não tem contrato.</p>
        );
      }}
    </SearchBoundary>
  );
}

function OrdersList({
  today,
  subscriber,
}: {
  today: boolean;
  subscriber: string | null;
}) {
  const path = `/work-orders?status=pending${subscriber ? `&subscriber_id=${subscriber}` : ""}&limit=200&offset=0`;
  const result = useSWR(["assistant-orders", path], async ([, query]) =>
    z.array(orderSchema).parse((await erpClient.request(query)).data),
  );
  const day = new Date().toLocaleDateString("en-CA");
  const local = (value: string | null) =>
    value ? new Date(value).toLocaleDateString("en-CA") : null;
  const rows = (result.data ?? []).filter(
    (order) =>
      !today ||
      local(order.created_at) === day ||
      local(order.scheduled_for) === day,
  );
  return (
    <QueryBoundary
      loading={result.isLoading}
      error={result.error}
      retry={() => result.mutate()}
    >
      {result.data &&
        (rows.length ? (
          <ul aria-label="Ordens de serviço encontradas">
            {rows.slice(0, 20).map((order) => (
              <li key={order.id}>
                <Link
                  className="profile-text-action"
                  to={`/ordens-de-servico?ordem=${order.id}`}
                >
                  OS {order.number}
                </Link>{" "}
                · {orderKinds[order.kind] ?? order.kind} ·{" "}
                {orderStates[order.status] ?? order.status} ·{" "}
                {order.subscriber_name}
                {order.scheduled_for
                  ? ` · agendada para ${stamp(order.scheduled_for)}`
                  : ""}
              </li>
            ))}
            {rows.length > 20 && <li>Mais {rows.length - 20} ordem(ns).</li>}
          </ul>
        ) : (
          <p role="status">
            Nenhuma ordem de serviço aberta
            {today ? " criada ou agendada para hoje" : ""}.
          </p>
        ))}
      <Link className="profile-text-action" to="/ordens-de-servico">
        Abrir ordens de serviço
      </Link>
    </QueryBoundary>
  );
}

function OrdersAnswer({
  today,
  subject,
}: {
  today: boolean;
  subject: string | null;
}) {
  const { me } = useSession();
  if (!subject || !can(me, "subscribers:read"))
    return <OrdersList today={today} subscriber={null} />;
  return (
    <SearchBoundary term={subject}>
      {(results) => (
        <>
          <p>
            Cliente:{" "}
            <Link
              className="profile-text-action"
              to={subscriberLink(results[0].subscriber_id)}
            >
              {results[0].subscriber_name}
            </Link>
          </p>
          <OrdersList today={today} subscriber={results[0].subscriber_id} />
        </>
      )}
    </SearchBoundary>
  );
}

function IpAnswer({
  intent,
}: {
  intent: Extract<AssistantIntent, { kind: "ip" }>;
}) {
  const { me } = useSession();
  const [reference, setReference] = useState("");
  const [report, setReport] = useState<z.infer<typeof legalSchema> | null>(
    null,
  );
  const day = intent.date ?? new Date().toLocaleDateString("en-CA");
  const instant = intent.time ? `${day}T${intent.time}:00-03:00` : null;
  return (
    <div className="erp-stack">
      {can(me, "subscribers:read") && (
        <>
          <p className="profile-footnote">
            Associação atual do endereço {intent.ip}:
          </p>
          <CustomerAnswer subject={intent.ip} />
        </>
      )}
      {can(me, "legal:query") &&
        (instant ? (
          <>
            <p className="profile-footnote">
              Consulta de rastreabilidade em {date(day)} às {intent.time}{" "}
              (horário de Brasília)
              {intent.port ? `, porta ${intent.port}` : ""}. A consulta é
              registrada em auditoria e exige o número do ofício ou processo.
            </p>
            <MutationForm
              submit="Consultar IP no instante"
              onSubmit={async () => {
                setReport(
                  legalSchema.parse(
                    await api("/legal/ip-lookup", {
                      body: {
                        ip: intent.ip,
                        port: intent.port,
                        from: instant,
                        to: instant,
                        reference: reference.trim(),
                        margin_minutes: 0,
                      },
                    }),
                  ),
                );
              }}
            >
              <FormField label="Número do ofício ou processo">
                <Input
                  required
                  minLength={3}
                  maxLength={120}
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                />
              </FormField>
            </MutationForm>
            {report && (
              <ul aria-label="Sessões no instante consultado">
                {report.sessions.map((row) => (
                  <li key={`${row.login}-${row.started_at}`}>
                    <Link
                      className="profile-text-action"
                      to={subscriberLink(row.subscriber_id)}
                    >
                      {row.name}
                    </Link>{" "}
                    · login {row.login} · IP {row.ip} · de{" "}
                    {stamp(row.started_at)} até{" "}
                    {row.stopped_at ? stamp(row.stopped_at) : "em andamento"}
                  </li>
                ))}
                {report.fixed.map((row) => (
                  <li key={`fixo-${row.ip}`}>
                    IP fixo {row.ip} · {row.name}
                  </li>
                ))}
                {!report.sessions.length && !report.fixed.length && (
                  <li>Nenhuma sessão encontrada no instante consultado.</li>
                )}
              </ul>
            )}
          </>
        ) : (
          <p className="profile-footnote">
            Informe o horário (por exemplo, “IP {intent.ip} às 10h”) para
            consultar quem usava o endereço naquele instante.
          </p>
        ))}
      <Link className="profile-text-action" to="/rede/consulta-ip">
        Abrir consulta de IP completa
      </Link>
    </div>
  );
}

function IntentAnswer({ intent }: { intent: AssistantIntent }) {
  switch (intent.kind) {
    case "customer":
      return <CustomerAnswer subject={intent.subject} />;
    case "diagnosis":
      return intent.subject ? (
        <DiagnosisAnswer subject={intent.subject} />
      ) : (
        <p role="status">
          Diga qual cliente: por exemplo, “por que o cliente Maria Souza está
          sem internet?”.
        </p>
      );
    case "overdue":
      return <OverdueAnswer subject={intent.subject} />;
    case "orders":
      return <OrdersAnswer today={intent.today} subject={intent.subject} />;
    case "ip":
      return <IpAnswer intent={intent} />;
    default:
      return null;
  }
}

/** Assistente por regras: reconhece a pergunta e responde com as consultas que a sessão já pode fazer. */
export function OperationalAssistant() {
  const { me } = useSession();
  const [question, setQuestion] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const allowed = allowedIntents(me);
  const examples = suggestionsFor(me);
  const ask = (text: string) => {
    const value = text.trim();
    if (!value) return;
    setEntries((previous) =>
      [
        { id: Date.now(), question: value, intent: parseIntent(value) },
        ...previous,
      ].slice(0, 5),
    );
    setQuestion("");
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    ask(question);
  };
  const suggestionButtons = (
    <div
      className="erp-inline-actions"
      role="group"
      aria-label="Sugestões de perguntas"
    >
      {examples.map((item) => (
        <Button
          key={item.question}
          variant="outline"
          size="sm"
          onClick={() => ask(item.question)}
        >
          {item.question}
        </Button>
      ))}
    </div>
  );
  return (
    <>
      <PageHeading
        eyebrow="GESTÃO DO WORKSPACE"
        title="Assistente"
        description="Pergunte em linguagem natural. O assistente reconhece a pergunta por regras, sem modelo de linguagem externo, e responde com as consultas permitidas à sua sessão."
      />
      <Panel title="Pergunte ao assistente">
        <form className="erp-form" onSubmit={submit}>
          <FormField
            label="Pergunta ao assistente"
            hint="Ex.: cliente, documento ou login; por que um cliente está sem internet; faturas vencidas; OS abertas de hoje; IP e horário."
          >
            <Input
              value={question}
              maxLength={200}
              onChange={(event) => setQuestion(event.target.value)}
            />
          </FormField>
          <footer>
            <Button type="submit" disabled={!question.trim()}>
              Perguntar
            </Button>
          </footer>
        </form>
        {examples.length ? (
          suggestionButtons
        ) : (
          <p className="profile-footnote">
            Sua sessão não tem acesso às consultas usadas pelo assistente.
          </p>
        )}
      </Panel>
      {entries.map((entry) => (
        <Panel
          key={entry.id}
          title={`“${entry.question}”`}
          description={
            entry.intent.kind === "unknown"
              ? "Pergunta não reconhecida."
              : intentLabels[entry.intent.kind]
          }
        >
          {entry.intent.kind === "unknown" ? (
            <Answer title="Não entendi a pergunta">
              <p className="profile-footnote">Tente uma destas perguntas:</p>
              {suggestionButtons}
            </Answer>
          ) : !allowed.has(entry.intent.kind) ? (
            <Answer title="Consulta indisponível para sua sessão">
              <p className="profile-footnote">
                Sua conta não tem permissão para{" "}
                {intentLabels[entry.intent.kind].toLowerCase()}. Perguntas
                disponíveis:
              </p>
              {suggestionButtons}
            </Answer>
          ) : (
            <IntentAnswer intent={entry.intent} />
          )}
          {entry.intent.kind !== "unknown" &&
            allowed.has(entry.intent.kind) && (
              <ProfileFacts
                items={[
                  [
                    "Entendido como",
                    intentLabels[entry.intent.kind] +
                      ("subject" in entry.intent && entry.intent.subject
                        ? ` · ${entry.intent.subject}`
                        : ""),
                  ],
                ]}
              />
            )}
        </Panel>
      ))}
    </>
  );
}

import { useState } from "react";
import useSWR from "swr";
import { useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { toast } from "sonner";
import { InvoiceCatalog } from "@/components/financial";
import { Panel } from "@/components/workspace-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { FormField, MutationForm } from "@/features/shared/form";
import { ActionButton } from "@/features/shared/action";
import { ServerPager, useUrlPage } from "@/features/shared/pagination";
import { ConnectedNotice, QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api, download, erpClient } from "@/platform/erp-client";
import { exportCsv } from "@/features/shared/export";
import { invoiceSchema, projectInvoice, summarySchema } from "./models";
import { FinanceOverview } from "./overview";
import { OperationalInvoice } from "./invoice";
import { useCreateRequest } from "@/features/shared/create-request";
export function OperationalInvoices() {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [generating, setGenerating] = useState(false);
  useCreateRequest(
    "mensalidades",
    () => setGenerating(true),
    can(me, "finance:write"),
  );
  const [accounting, setAccounting] = useState(false);
  const [competence, setCompetence] = useState(
    new Date().toLocaleDateString("en-CA").slice(0, 7),
  );
  const query = params.get("busca") ?? "";
  const statusLabel =
    params.get("situacao") ??
    (params.get("filtro") === "vencidas"
      ? "Vencida"
      : params.get("filtro") === "conciliacao"
        ? "Em conciliação"
        : "Todas");
  const status =
    (
      {
        "Em aberto": "open",
        Vencida: "overdue",
        Paga: "paid",
        "Em conciliação": "reconciling",
        Cancelada: "canceled",
      } as Record<string, string>
    )[statusLabel] ?? "";
  const company = params.get("empresa") ?? "";
  const { page, setPage, size, setSize } = useUrlPage();
  const filters = new URLSearchParams({
    q: query,
    ...(status ? { status } : {}),
    ...(company ? { company_id: company } : {}),
  });
  const list = useSWR(
    ["erp-invoices", `${filters}&limit=${size}&offset=${page * size}`],
    async ([, filters]) => {
      const response = await erpClient.request(`/invoices?${filters}`);
      if (response.total === null)
        throw new Error("O servidor não informou a contagem de faturas.");
      return {
        rows: z.array(invoiceSchema).parse(response.data),
        total: response.total,
      };
    },
  );
  const summary = useSWR(["erp-finance-summary", company], async ([, id]) =>
    summarySchema.parse(
      await api(
        `/finance/summary${id ? `?company_id=${encodeURIComponent(id)}` : ""}`,
      ),
    ),
  );
  const companies = useSWR("erp-companies", () =>
    api<{ id: string; name: string }[]>("/companies"),
  );
  const refresh = async () => {
    await Promise.all([list.mutate(), summary.mutate()]);
  };
  return (
    <>
      <ConnectedNotice demo={me?.demo} />
      <InvoiceCatalog
        operational
        invoices={(list.data?.rows ?? []).map(projectInvoice)}
        openSubscriber={(id) => navigate(`/assinantes?ficha=${id}`)}
        loading={list.isLoading}
        error={list.error}
        onOpen={(invoice) => {
          const next = new URLSearchParams(params);
          next.set("fatura", invoice.id);
          setParams(next);
        }}
        actions={
          <>
            <select
              className="commercial-select"
              aria-label="Empresa faturadora"
              value={company}
              onChange={(event) =>
                setParams(
                  (current) => {
                    const next = new URLSearchParams(current);
                    next.delete("pagina");
                    event.target.value
                      ? next.set("empresa", event.target.value)
                      : next.delete("empresa");
                    return next;
                  },
                  { replace: true },
                )
              }
            >
              <option value="">Todas as empresas</option>
              {companies.data?.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
            <Button variant="outline" onClick={() => setAccounting(true)}>
              Contabilidade
            </Button>
            {can(me, "finance:write") && (
              <Button onClick={() => setGenerating(true)}>
                Gerar mensalidades
              </Button>
            )}
          </>
        }
        onExport={() => {
          void exportCsv(
            `/invoices?${filters}&format=csv&limit=5000`,
            "faturas.csv",
          ).catch((error) => toast.error((error as Error).message));
        }}
        top={
          <>
            <FinanceOverview
              summary={summary.data}
              loading={summary.isLoading}
              error={summary.error}
              company={company}
            />
          </>
        }
        pagination={
          <ServerPager
            page={page}
            setPage={setPage}
            size={size}
            setSize={setSize}
            total={list.data?.total ?? 0}
            loading={list.isLoading}
          />
        }
      />
      {params.get("fatura") && (
        <OperationalInvoice
          key={params.get("fatura")}
          id={params.get("fatura")!}
          onClose={() => {
            const next = new URLSearchParams(params);
            next.delete("fatura");
            setParams(next, { replace: true });
            void refresh();
          }}
        />
      )}
      {accounting && (
        <Dialog open onOpenChange={setAccounting}>
          <DialogContent className="erp-editor">
            <DialogHeader>
              <DialogTitle>Exportação para contabilidade</DialogTitle>
              <DialogDescription>
                Planilha de conferência; a emissão fiscal não é realizada pelo
                NexoISP.
              </DialogDescription>
            </DialogHeader>
            <AccountingExport />
          </DialogContent>
        </Dialog>
      )}
      {generating && (
        <Dialog open onOpenChange={setGenerating}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Gerar mensalidades</DialogTitle>
              <DialogDescription>
                O servidor usa as versões e condições de cada contrato. Faturas
                existentes da competência são preservadas.
              </DialogDescription>
            </DialogHeader>
            <MutationForm
              submit="Gerar faturas"
              onCancel={() => setGenerating(false)}
              onSubmit={async () => {
                const generation = await api<{
                  created: number;
                  already_existing: number;
                  gateway: string;
                  charges_emitted: number;
                }>("/finance/generate", { body: { competence } });
                toast.success(
                  `${generation.created} fatura(s) criada(s); ${generation.already_existing} já existente(s). ${
                    generation.gateway === "none"
                      ? "Sem gateway: cobranças não emitidas."
                      : `${generation.charges_emitted} cobrança(s) emitida(s).`
                  }`,
                );
                setGenerating(false);
                await refresh();
              }}
            >
              <FormField label="Competência">
                <Input
                  type="month"
                  required
                  value={competence}
                  onChange={(e) => setCompetence(e.target.value)}
                />
              </FormField>
            </MutationForm>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
function AccountingExport() {
  const companies = useSWR("erp-companies", () =>
    api<{ id: string; name: string }[]>("/companies"),
  );
  const today = new Date().toLocaleDateString("en-CA");
  const [form, setForm] = useState({
    kind: "payments",
    company_id: "",
    from: `${today.slice(0, 8)}01`,
    to: today,
  });
  return (
    <div className="erp-stack">
      <div className="erp-columns">
        <FormField label="Empresa da exportação contábil">
          <QueryBoundary
            loading={companies.isLoading}
            error={companies.error}
            retry={() => companies.mutate()}
          >
            <select
              className="commercial-select"
              value={form.company_id}
              onChange={(event) =>
                setForm({ ...form, company_id: event.target.value })
              }
            >
              <option value="">Todas as empresas</option>
              {companies.data?.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </QueryBoundary>
        </FormField>
        <FormField label="O que exportar">
          <select
            className="commercial-select"
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value })}
          >
            <option value="payments">Recebimentos por data de pagamento</option>
            <option value="invoices">Faturas por vencimento</option>
          </select>
        </FormField>
        <FormField label="Data inicial">
          <Input
            type="date"
            value={form.from}
            onChange={(e) => setForm({ ...form, from: e.target.value })}
          />
        </FormField>
        <FormField label="Data final">
          <Input
            type="date"
            value={form.to}
            onChange={(e) => setForm({ ...form, to: e.target.value })}
          />
        </FormField>
      </div>
      <ActionButton
        onClick={() =>
          download(
            `/finance/export?${new URLSearchParams(Object.entries(form).filter(([, value]) => value))}`,
            `contabilidade-${form.kind}.csv`,
          )
        }
      >
        Baixar CSV contábil
      </ActionButton>
    </div>
  );
}

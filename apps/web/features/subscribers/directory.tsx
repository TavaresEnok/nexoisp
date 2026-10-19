import { useState } from "react";
import useSWR from "swr";
import { useSearchParams } from "react-router-dom";
import { Download, Users, Check, CreditCard, UserX, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  SubscriberDirectoryView,
  type SubscriberListRow,
} from "@/components/subscribers";
import { QueryBoundary, ConnectedNotice } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api, download } from "@/platform/erp-client";
import { money } from "@/lib/format";
import { readSubscribers, subscriberQuery } from "@/data/erp/subscribers";
import type { SubscriberRecord } from "./model";
import { SubscriberEditor } from "./form";

export const subscriberPageSizes = [8, 25, 50];

export function subscriberListRow(row: SubscriberRecord): SubscriberListRow {
  const contracts = row.active_contracts ?? 0;
  return {
    id: row.id,
    code: row.id.slice(0, 8),
    name: row.name,
    contact: row.email || row.phone || "Sem contato principal",
    plan: row.active_plan_names || "Sem plano ativo",
    status:
      contracts > 0
        ? "Ativo"
        : row.status === "inactive"
          ? "Inativo"
          : "Sem contrato ativo",
    connection: contracts === 1 ? "1 contrato" : `${contracts} contratos`,
    locality:
      [row.address_district, row.address_city].filter(Boolean).join(" · ") ||
      "—",
    monthly:
      row.active_base_cents === null ? null : row.active_base_cents / 100,
  };
}

function useSubscriberCount(query: string, status: string) {
  return useSWR(
    ["erp-subscribers", "count", query, status],
    async () =>
      (
        await readSubscribers(
          subscriberQuery({ query, status, page: 0, pageSize: 1 }),
        )
      ).total,
  );
}

export function SubscriberDirectory() {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const query = params.get("busca") ?? "";
  const status = ["active", "inactive"].includes(params.get("cadastro") ?? "")
    ? params.get("cadastro")!
    : "";
  const descending = params.get("ordenacao") === "desc";
  const requestedSize = Number(params.get("linhas") ?? "8");
  const pageSize = subscriberPageSizes.includes(requestedSize)
    ? requestedSize
    : 8;
  const rawPage = Number(params.get("pagina") ?? "1");
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage - 1 : 0;
  const path = subscriberQuery({ query, status, page, pageSize, descending });
  const list = useSWR(["erp-subscribers", path], ([, path]) =>
    readSubscribers(path),
  );
  const all = useSubscriberCount(query, "");
  const active = useSubscriberCount(query, "active");
  const inactive = useSubscriberCount(query, "inactive");
  const dashboard = useSWR("erp-dashboard", () =>
    api<{ contracts: number; mrr_cents: number }>("/dashboard"),
  );
  const totals = dashboard.data;
  const change = (values: Record<string, string | null>) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(values))
          value ? next.set(key, value) : next.delete(key);
        return next;
      },
      { replace: true },
    );
  const open = (id: string) => change({ ficha: id, abaFicha: null });
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const exportRows = async () => {
    setExporting(true);
    try {
      await download(
        `/subscribers?${new URLSearchParams({ q: query, ...(status ? { status } : {}), ...(descending ? { order: "desc" } : {}), format: "csv", limit: "5000" })}`,
        "assinantes.csv",
      );
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setExporting(false);
    }
  };
  const statusLabel = status === "active" ? "Ativo" : "Inativo";
  return (
    <>
      <SubscriberDirectoryView
        description="Cadastro, contratos e atendimento. Todo o contexto em uma única ficha."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => void exportRows()}
              disabled={exporting}
            >
              <Download data-icon="inline-start" />
              {exporting ? "Exportando…" : "Exportar CSV"}
            </Button>
            {can(me, "subscribers:write") && (
              <Button onClick={() => setCreating(true)}>
                <Plus data-icon="inline-start" />
                Novo assinante
              </Button>
            )}
          </>
        }
        before={<ConnectedNotice />}
        summary={[
          {
            icon: Users,
            value: all.data ?? "—",
            label: query ? "cadastros na busca" : "cadastros no provedor",
          },
          {
            icon: Check,
            value: totals?.contracts ?? "—",
            label: "contratos ativos",
          },
          {
            icon: CreditCard,
            value: totals ? money(Number(totals.mrr_cents) / 100) : "—",
            label: "mensalidade base ativa",
          },
          {
            icon: UserX,
            value: inactive.data ?? "—",
            label: "cadastros inativos",
            warning: true,
          },
        ]}
        panelDescription="Cadastros do provedor, com plano e mensalidade dos contratos ativos"
        badge={list.data ? `${total} registros` : "Consulta"}
        tabs={[
          { value: "all", label: "Todos", count: all.data },
          { value: "active", label: "Ativos", count: active.data },
          { value: "inactive", label: "Inativos", count: inactive.data },
        ]}
        status={status || "all"}
        onStatus={(value) =>
          change({ cadastro: value === "all" ? null : value, pagina: null })
        }
        query={query}
        onQuery={(value) => change({ busca: value || null, pagina: null })}
        searchPlaceholder="Nome, documento, e-mail ou telefone…"
        filters={[
          ...(query
            ? [
                {
                  label: `Busca: ${query}`,
                  onRemove: () => change({ busca: null, pagina: null }),
                },
              ]
            : []),
          ...(status
            ? [
                {
                  label: `Cadastro: ${statusLabel}`,
                  onRemove: () => change({ cadastro: null, pagina: null }),
                },
              ]
            : []),
        ]}
        filteredCount={total}
        onClearFilters={() =>
          change({ busca: null, cadastro: null, pagina: null })
        }
        sortAsc={!descending}
        onToggleSort={() =>
          change({ ordenacao: descending ? null : "desc", pagina: null })
        }
        columns={{
          connection: "Contratos",
          connectionStatus: false,
          monthly: "Mensalidade base",
        }}
        rows={rows.map(subscriberListRow)}
        onOpen={open}
        empty={{
          title: "Nenhum assinante encontrado.",
          description: "Tente outro termo ou remova os filtros.",
        }}
        boundary={(content) => (
          <QueryBoundary
            loading={list.isLoading}
            error={list.error}
            retry={() => list.mutate()}
          >
            {content}
          </QueryBoundary>
        )}
        pagination={{
          start: total ? page * pageSize + 1 : 0,
          end: Math.min(page * pageSize + rows.length, total),
          total,
          page,
          pages,
          onPage: (next) =>
            change({ pagina: next === 0 ? null : String(next + 1) }),
          pageSize: {
            value: pageSize,
            options: subscriberPageSizes,
            onChange: (value) =>
              change({
                linhas: value === 8 ? null : String(value),
                pagina: null,
              }),
          },
        }}
      />
      {creating && (
        <SubscriberEditor
          onClose={() => setCreating(false)}
          onDone={async (id) => {
            setCreating(false);
            await list.mutate();
            open(id);
          }}
        />
      )}
    </>
  );
}

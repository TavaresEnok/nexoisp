import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Plus } from "lucide-react";
import { z } from "zod";
import { PlanCatalog } from "@/components/plans";
import { Button } from "@/components/ui/button";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { QueryBoundary, ConnectedNotice } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { api } from "@/platform/erp-client";
import {
  planSchema,
  projectPlan,
  type ErpPlan,
} from "@/features/contracts/models";
import { PlanDialog, type PlanDialogKind } from "./dialog";
import { useCreateRequest } from "@/features/shared/create-request";
export function OperationalPlans() {
  const { me } = useSession();
  const { mutate } = useSWRConfig();
  const dashboard = useSWR("erp-dashboard", () =>
    api<{ mrr_cents: number }>("/dashboard"),
  );
  const catalog = useSWR("erp-plans", async () =>
    z.array(planSchema).parse(await api("/plans")),
  );
  const [dialog, setDialog] = useState<{
    kind: PlanDialogKind;
    id?: string;
  } | null>(null);
  useCreateRequest(
    "plano",
    () => setDialog({ kind: "new" }),
    can(me, "plans:write"),
  );
  const refresh = async () => {
    await Promise.all([catalog.mutate(), mutate("erp-plans-for-contract")]);
  };
  const plan = catalog.data?.find((plan) => plan.id === dialog?.id);
  const actions = (row: ErpPlan) => (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setDialog({ kind: "history", id: row.id })}
      >
        Histórico de versões
      </Button>
      {can(me, "plans:write") && (
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDialog({ kind: "version", id: row.id })}
          >
            Alterar preço/velocidade
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDialog({ kind: "dunning", id: row.id })}
          >
            Degraus de cobrança
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDialog({ kind: "loyalty", id: row.id })}
          >
            Fidelidade
          </Button>
          <ActionButton
            onClick={async () => {
              await api(`/plans/${row.id}`, {
                method: "PATCH",
                body: { active: !row.active },
              });
              await refresh();
            }}
          >
            {row.active ? "Desativar" : "Ativar"}
          </ActionButton>
        </>
      )}
      {can(me, "network:write") && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDialog({ kind: "network", id: row.id })}
        >
          Parâmetros de rede
        </Button>
      )}
    </>
  );
  return (
    <>
      <ConnectedNotice demo={me?.demo} />
      <QueryBoundary
        loading={catalog.isLoading}
        error={catalog.error}
        retry={() => catalog.mutate()}
      >
        {catalog.data && (
          <PlanCatalog
            plans={catalog.data.map(projectPlan)}
            contracts={[]}
            recurringTotal={
              dashboard.data ? Number(dashboard.data.mrr_cents) / 100 : null
            }
            activeCounts={Object.fromEntries(
              catalog.data.map((plan) => [plan.id, plan.active_contracts]),
            )}
            actions={
              can(me, "plans:write") && (
                <Button onClick={() => setDialog({ kind: "new" })}>
                  <Plus />
                  Novo plano
                </Button>
              )
            }
            detailActions={(selected) => {
              const row = catalog.data!.find((plan) => plan.id === selected.id);
              return row ? actions(row) : null;
            }}
          />
        )}
      </QueryBoundary>
      {dialog && (
        <PlanDialog
          key={`${dialog.kind}:${dialog.id ?? "new"}`}
          kind={dialog.kind}
          plan={plan}
          onClose={() => {
            setDialog(null);
            if (dialog.kind === "network") void refresh();
          }}
          onDone={async () => {
            setDialog(null);
            await refresh();
          }}
        />
      )}
    </>
  );
}

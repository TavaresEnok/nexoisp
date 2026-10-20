import { useState } from "react";
import useSWR from "swr";
import { useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { toast } from "sonner";
import { OrderWorkspace } from "@/components/field-operations";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ConnectedNotice } from "@/features/shared/feedback";
import { ServerPager, useUrlPage } from "@/features/shared/pagination";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api, erpClient, download } from "@/platform/erp-client";
import { orderSchema, projectOrder } from "./models";
import { orderStates } from "./labels";
import { CreateWorkOrder } from "./create";
import { FilterToggle } from "@/features/shared/filter-toggle";
import { useStatusCounts } from "@/features/shared/status-counts";
export function OperationalOrders() {
  const { me } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const { page, setPage, size, setSize } = useUrlPage();
  const label = params.get("situacao") ?? "Pendentes";
  const status =
    Object.entries(orderStates).find(([, value]) => value === label)?.[0] ??
    (label === "Todas" ? "" : "pending");
  const technician = params.get("tecnico");
  const mine = params.get("minhas") === "1";
  const filters = new URLSearchParams({
    q: params.get("busca") ?? "",
    ...(status ? { status } : {}),
    ...(mine
      ? { mine: "1" }
      : technician && technician !== "Todos"
        ? { assignee_id: technician }
        : {}),
    ...(params.get("assinante")
      ? { subscriber_id: params.get("assinante")! }
      : {}),
    ...(params.get("contrato") ? { contract_id: params.get("contrato")! } : {}),
  });
  const path = `/work-orders?${filters}&limit=${size}&offset=${page * size}`;
  const statusCounts = useStatusCounts("erp-orders", "/work-orders", filters, {
    Pendentes: "pending",
    Todas: "",
    [orderStates.awaiting_schedule]: "awaiting_schedule",
    [orderStates.scheduled]: "scheduled",
    [orderStates.in_progress]: "in_progress",
    [orderStates.done]: "done",
  });
  const result = useSWR(
    ["erp-orders", path],
    async ([, path]) => {
      const response = await erpClient.request(path);
      if (response.total === null)
        throw new Error("O servidor não informou a contagem de OS.");
      return {
        rows: z.array(orderSchema).parse(response.data),
        total: response.total,
        readAt: new Date().toISOString(),
      };
    },
    { refreshInterval: 30000 },
  );
  const staff = useSWR("erp-staff", () =>
    api<{ id: string; name: string }[]>("/staff"),
  );
  const changeTechnician = (value: string) => {
    const next = new URLSearchParams(params);
    next.delete("minhas");
    next.delete("pagina");
    value === "Todos" ? next.delete("tecnico") : next.set("tecnico", value);
    setParams(next, { replace: true });
  };
  return (
    <>
      <ConnectedNotice demo={me?.demo} />
      <OrderWorkspace
        operational
        onTechnician={changeTechnician}
        onResetFilters={() => {
          const next = new URLSearchParams(params);
          for (const key of ["busca", "tecnico", "minhas", "pagina"])
            next.delete(key);
          next.set("situacao", "Todas");
          setParams(next, { replace: true });
        }}
        orders={(result.data?.rows ?? []).map(projectOrder)}
        reference={result.data?.readAt ?? new Date().toISOString()}
        provider={me?.tenant?.name ?? "Provedor"}
        total={result.data?.total}
        statusOptions={[
          "Pendentes",
          "Todas",
          orderStates.awaiting_schedule,
          orderStates.scheduled,
          orderStates.in_progress,
          orderStates.done,
        ]}
        statusCounts={statusCounts}
        technicianOptions={
          staff.data?.map((user) => ({ value: user.id, label: user.name })) ??
          []
        }
        loading={result.isLoading || staff.isLoading}
        error={result.error || staff.error}
        openSubscriber={(id) => navigate(`/assinantes?ficha=${id}`)}
        onOpen={(order) => {
          const next = new URLSearchParams(params);
          next.set("ordem", order.id);
          setParams(next);
        }}
        actions={
          can(me, "os:write") && (
            <Button onClick={() => setCreating(true)}>
              Nova ordem de serviço
            </Button>
          )
        }
        onExport={() => {
          void download(
            `/work-orders?${filters}&format=csv&limit=5000`,
            "ordens-de-servico.csv",
          ).catch((error) => toast.error((error as Error).message));
        }}
        controls={
          <div className="commercial-toolbar">
            <FilterToggle
              active={mine}
              onChange={(value) => {
                const next = new URLSearchParams(params);
                next.delete("pagina");
                next.delete("tecnico");
                value ? next.set("minhas", "1") : next.delete("minhas");
                setParams(next, { replace: true });
              }}
            >
              Somente minhas OS
            </FilterToggle>
            {(params.get("assinante") || params.get("contrato")) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.delete("assinante");
                  next.delete("contrato");
                  next.delete("pagina");
                  setParams(next, { replace: true });
                }}
              >
                Remover filtro de vínculo
              </Button>
            )}
          </div>
        }
        pagination={
          <ServerPager
            page={page}
            setPage={setPage}
            size={size}
            setSize={setSize}
            total={result.data?.total ?? 0}
            loading={result.isLoading}
          />
        }
      />
      {creating && (
        <CreateWorkOrder
          onClose={() => setCreating(false)}
          onDone={async (order) => {
            setCreating(false);
            await result.mutate();
            const next = new URLSearchParams(params);
            next.set("ordem", order.id);
            setParams(next);
          }}
        />
      )}
    </>
  );
}

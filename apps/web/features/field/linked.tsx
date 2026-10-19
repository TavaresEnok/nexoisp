import { useState } from "react";
import useSWR from "swr";
import { useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { ProfileSection } from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Status } from "@/components/workspace-ui";
import { QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { erpClient } from "@/platform/erp-client";
import { orderSchema, projectOrder } from "./models";
import { CreateWorkOrder } from "./create";

export function LinkedOrders({
  subscriberId,
  contractId,
}: {
  subscriberId: string;
  contractId?: string;
}) {
  const { me } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const filters = new URLSearchParams({
    subscriber_id: subscriberId,
    ...(contractId ? { contract_id: contractId } : {}),
  });
  const path = `/work-orders?${filters}&limit=8`;
  const result = useSWR(["erp-orders", path], async ([, path]) => {
    const response = await erpClient.request(path);
    if (response.total === null)
      throw new Error("O servidor não informou a contagem de OS.");
    return {
      rows: z.array(orderSchema).parse(response.data),
      total: response.total,
    };
  });
  const open = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("ordem", id);
    setParams(next);
  };
  return (
    <ProfileSection
      title="Ordens de serviço"
      caption="Até oito ordens deste vínculo, priorizando pendências e agendamentos."
      action={
        can(me, "os:write") && (
          <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
            Nova OS deste vínculo
          </Button>
        )
      }
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {result.data?.rows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>OS / serviço</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead>Agendamento</TableHead>
                <TableHead>Técnico</TableHead>
                <TableHead>Ação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.data.rows.map((row) => {
                const order = projectOrder(row);
                return (
                  <TableRow key={order.id}>
                    <TableCell>
                      #{order.code} · {order.type}
                    </TableCell>
                    <TableCell>
                      <Status value={order.status} />
                    </TableCell>
                    <TableCell>{order.time}</TableCell>
                    <TableCell>{order.technician}</TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => open(order.id)}
                      >
                        Consultar OS {order.code}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <p className="profile-footnote">
            Nenhuma ordem de serviço neste vínculo.
          </p>
        )}
        <div className="erp-pagination">
          <span>{result.data?.total ?? "—"} OS no vínculo</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              navigate(
                `/ordens-de-servico?assinante=${subscriberId}${contractId ? `&contrato=${contractId}` : ""}&situacao=Todas`,
              )
            }
          >
            Ver todas as OS deste vínculo
          </Button>
        </div>
      </QueryBoundary>
      {creating && (
        <CreateWorkOrder
          subscriberId={subscriberId}
          contractId={contractId}
          onClose={() => setCreating(false)}
          onDone={async (order) => {
            setCreating(false);
            await result.mutate();
            open(order.id);
          }}
        />
      )}
    </ProfileSection>
  );
}

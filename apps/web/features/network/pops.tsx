import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { useNavigate } from "react-router-dom";
import { Panel } from "@/components/workspace-ui";
import { CoreNetworkFrame } from "@/components/core-network";
import { coreTabs } from "./core-tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { RecordEditor } from "@/features/shared/record-editor";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { can, sessionScope } from "@/features/session/model";
import { PhysicalSites } from "./physical-sites";
import { useSession } from "@/features/session/provider";
import { api } from "@/platform/erp-client";
const popSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  active: z.boolean(),
  active_contracts: z.coerce.number(),
  suspended_contracts: z.coerce.number(),
  ended_contracts: z.coerce.number(),
});
type Pop = z.infer<typeof popSchema>;
export function NetworkPops() {
  const { me } = useSession();
  const navigate = useNavigate();
  const result = useSWR(me ? ["erp-pops", sessionScope(me)] : null, async () =>
    z.array(popSchema).parse(await api("/pops")),
  );
  const [editor, setEditor] = useState<Pop | "create" | null>(null);
  const write = can(me, "network:write");
  const editing = editor && editor !== "create" ? editor : null;
  return (
    <CoreNetworkFrame
      tab="pops"
      tabs={coreTabs(me)}
      onTab={navigate}
      title="Pontos de presença"
      description="POPs e vínculos comerciais do provedor."
      actions={
        write && <Button onClick={() => setEditor("create")}>Novo POP</Button>
      }
    >
      <Panel title="POPs cadastrados">
        <QueryBoundary
          loading={result.isLoading}
          error={result.error}
          retry={() => result.mutate()}
        >
          {result.data?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  {[
                    "POP",
                    "Cidade / UF",
                    "Vigentes",
                    "Suspensos",
                    "Encerrados",
                    "Situação",
                    "Ações",
                  ].map((label) => (
                    <TableHead key={label}>{label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.map((pop) => (
                  <TableRow key={pop.id}>
                    <TableCell>{pop.name}</TableCell>
                    <TableCell>
                      {[pop.city, pop.state].filter(Boolean).join(" / ") ||
                        "Não informada"}
                    </TableCell>
                    <TableCell>{pop.active_contracts}</TableCell>
                    <TableCell>{pop.suspended_contracts}</TableCell>
                    <TableCell>{pop.ended_contracts}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {pop.active ? "Ativo" : "Inativo"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {write && (
                        <div className="erp-inline-actions">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setEditor(pop)}
                          >
                            Editar POP
                          </Button>
                          <ActionButton
                            confirm={
                              pop.active
                                ? "Inativar o POP? Os contratos existentes conservam o vínculo."
                                : undefined
                            }
                            onClick={async () => {
                              await api(`/pops/${pop.id}`, {
                                method: "PATCH",
                                body: { active: !pop.active },
                              });
                              await result.mutate();
                            }}
                          >
                            {pop.active ? "Inativar POP" : "Ativar POP"}
                          </ActionButton>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="profile-footnote">Nenhum POP cadastrado.</p>
          )}
        </QueryBoundary>
      </Panel>
      {me && can(me, "network:read") && result.data && (
        <PhysicalSites
          key={sessionScope(me)}
          scope={sessionScope(me)}
          pops={result.data}
          write={write}
        />
      )}
      {editor && (
        <RecordEditor
          title={editing ? "Editar POP" : "Novo POP"}
          initial={{
            name: editing?.name ?? "",
            city: editing?.city ?? "",
            state: editing?.state ?? "",
          }}
          fields={[
            {
              key: "name",
              label: "Nome do POP",
              required: true,
              maxLength: 80,
            },
            { key: "city", label: "Cidade do POP", maxLength: 80 },
            { key: "state", label: "UF do POP", maxLength: 2 },
          ]}
          onClose={() => setEditor(null)}
          onSubmit={async (values) => {
            await api(editing ? `/pops/${editing.id}` : "/pops", {
              method: editing ? "PATCH" : "POST",
              body: {
                name: values.name,
                city: values.city || null,
                state: values.state.toUpperCase() || null,
              },
            });
            setEditor(null);
            await result.mutate();
          }}
        />
      )}
    </CoreNetworkFrame>
  );
}

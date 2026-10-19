import useSWR from "swr";
import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
} from "@/components/ui/table";
import { QueryBoundary } from "@/features/shared/feedback";
import { api } from "@/platform/erp-client";
import { date } from "@/lib/format";
type States = {
  commercial: {
    state: string;
    end_date: string | null;
    end_reason: string | null;
    end_note: string | null;
    credit_restricted_at: string | null;
  };
  access: {
    state: string;
    mode: string | null;
    cause: string | null;
    reason: string | null;
    since: string | null;
    applied: boolean | null;
  };
  speed: { state: string };
};
export function ContractStates({ id }: { id: string }) {
  const result = useSWR(
    ["erp-contract-states", id],
    ([, id]) => api<States>(`/contracts/${id}/states`),
    { refreshInterval: 10000 },
  );
  const data = result.data;
  return (
    <ProfileSection title="Situação comercial e técnica">
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {data && (
          <>
            <div className="erp-inline-actions">
              <Badge
                variant={
                  data.commercial.state === "credit_restricted"
                    ? "warning"
                    : "outline"
                }
              >
                {(
                  {
                    active: "Contrato vigente",
                    ended: "Contrato encerrado",
                    credit_restricted: "Vigente · restrição de crédito",
                  } as Record<string, string>
                )[data.commercial.state] ?? data.commercial.state}
              </Badge>
              <Badge
                variant={
                  data.access.state === "blocked" ? "destructive" : "outline"
                }
              >
                {(
                  {
                    no_account: "Acesso não provisionado",
                    active: "Acesso liberado",
                    blocked: "Acesso bloqueado",
                  } as Record<string, string>
                )[data.access.state] ?? data.access.state}
              </Badge>
              {data.access.state !== "no_account" && (
                <Badge
                  variant={
                    data.speed.state === "reduced" ? "warning" : "outline"
                  }
                >
                  {data.speed.state === "reduced"
                    ? "Velocidade reduzida"
                    : "Velocidade normal"}
                </Badge>
              )}
            </div>
            <ProfileFacts
              items={[
                [
                  "Confirmação do equipamento",
                  data.access.applied === true
                    ? "Confirmado"
                    : data.access.applied === false
                      ? "Aguardando confirmação"
                      : "Sem confirmação disponível",
                ],
                [
                  "Modo",
                  data.access.mode === "manual"
                    ? "Manual"
                    : data.access.mode === "automatic"
                      ? "Automático"
                      : "—",
                ],
                [
                  "Motivo do acesso",
                  data.access.reason ||
                    (data.access.cause === "contract_ended"
                      ? "Contrato encerrado"
                      : "—"),
                ],
                ...(data.access.since
                  ? [
                      ["Situação desde", date(data.access.since)] as [
                        string,
                        string,
                      ],
                    ]
                  : []),
                ...(data.commercial.credit_restricted_at
                  ? [
                      [
                        "Restrição desde",
                        date(data.commercial.credit_restricted_at),
                      ] as [string, string],
                    ]
                  : []),
                ...(data.commercial.end_date
                  ? [
                      ["Encerramento", date(data.commercial.end_date)] as [
                        string,
                        string,
                      ],
                      [
                        "Motivo do encerramento",
                        data.commercial.end_reason ||
                          data.commercial.end_note ||
                          "Não informado",
                      ] as [string, string],
                    ]
                  : []),
              ]}
            />
          </>
        )}
      </QueryBoundary>
    </ProfileSection>
  );
}
type Equipment = {
  id: string;
  serial: string;
  item_name: string;
  contract_mode: string;
  work_order_number: number | null;
};
export function ContractEquipment({ id }: { id: string }) {
  const result = useSWR(["erp-contract-equipment", id], ([, id]) =>
    api<{ units: Equipment[]; to_recover: Equipment[] }>(
      `/contracts/${id}/equipment`,
    ),
  );
  return (
    <ProfileSection
      title="Equipamentos instalados"
      caption="A instalação e a retirada são registradas pelas ordens de serviço e pelo estoque."
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {Boolean(result.data?.to_recover.length) && (
          <p role="alert" className="text-danger">
            Comodato a recolher:{" "}
            {result.data!.to_recover.map((unit) => unit.serial).join(", ")}.
          </p>
        )}
        {result.data?.units.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Equipamento</TableHead>
                <TableHead>Série</TableHead>
                <TableHead>Modalidade</TableHead>
                <TableHead>OS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.data.units.map((unit) => (
                <TableRow key={unit.id}>
                  <TableCell>{unit.item_name}</TableCell>
                  <TableCell>{unit.serial}</TableCell>
                  <TableCell>
                    {unit.contract_mode === "comodato" ? "Comodato" : "Venda"}
                  </TableCell>
                  <TableCell>
                    {unit.work_order_number
                      ? `#${unit.work_order_number}`
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="profile-footnote">Nenhum equipamento instalado.</p>
        )}
      </QueryBoundary>
    </ProfileSection>
  );
}

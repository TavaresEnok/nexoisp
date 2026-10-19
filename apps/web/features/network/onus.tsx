import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { OpticalNavigation } from "@/components/optical-ui";
import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { QueryBoundary } from "@/features/shared/feedback";
import { MutationForm, FormField } from "@/features/shared/form";
import { ActionButton } from "@/features/shared/action";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import {
  operationSchema,
  actionLabels,
  operationLabels,
  stamp,
} from "./models";
import { useDevices } from "./queries";
export const discoverySchema = z.object({
  id: z.coerce.string(),
  device_id: z.string().uuid(),
  device_name: z.string(),
  driver: z.string(),
  serial: z.string(),
  pon_port: z.string(),
  vendor: z.string().nullable(),
  model: z.string().nullable(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
});
export const onuSchema = z.object({
  id: z.string().uuid(),
  contract_id: z.string().uuid(),
  serial: z.string(),
  device_id: z.string().uuid(),
  device_name: z.string(),
  driver: z.string(),
  subscriber_name: z.string(),
  pon_port: z.string(),
  line_profile: z.string(),
  service_profile: z.string().nullable(),
  service_vlan: z.coerce.number(),
  desired_state: z.string(),
  desired_version: z.coerce.number(),
  desired_at: z.string(),
  observed_state: z.string().nullable(),
  observed_online: z.boolean().nullable(),
  observed_version: z.coerce.number().nullable(),
  observed_at: z.string().nullable(),
  observed_rx_dbm: z.coerce.number().nullable(),
  observed_tx_dbm: z.coerce.number().nullable(),
  agent_online: z.boolean(),
  agent_name: z.string().nullable(),
  drift: z.boolean(),
});
const dbm = (value: number | null) =>
  value == null ? "Não informado" : `${value.toFixed(2)} dBm`;
function state(n: z.infer<typeof onuSchema>) {
  return !n.observed_at
    ? "Ainda não lida"
    : n.observed_state !== "authorized"
      ? "Não autorizada na OLT"
      : n.observed_online === null
        ? "Sessão não informada"
        : n.observed_online
          ? "Online"
          : "Offline";
}
function useOnuRefresh() {
  const { mutate } = useSWRConfig();
  return () =>
    mutate(
      (key) =>
        key === "erp-onus" ||
        key === "erp-discoveries" ||
        key === "erp-noc" ||
        (Array.isArray(key) &&
          [
            "erp-contract-onu",
            "erp-operations",
            "erp-operation",
            "erp-diagnosis",
          ].includes(key[0])),
    );
}
export function NetworkOnus() {
  const { me } = useSession();
  const navigate = useNavigate();
  const operate = can(me, "network:operate");
  const found = useSWR(
    "erp-discoveries",
    async () => z.array(discoverySchema).parse(await api("/olt/discoveries")),
    { refreshInterval: 5000 },
  );
  const linked = useSWR(
    "erp-onus",
    async () => z.array(onuSchema).parse(await api("/onus")),
    { refreshInterval: 5000 },
  );
  const [authorization, setAuthorization] = useState<{
    discovery?: z.infer<typeof discoverySchema>;
  } | null>(null);
  const refresh = useOnuRefresh();
  return (
    <>
      <PageHeading
        title="ONUs e autorizações"
        description="Descobertas e vínculos reportados pelas OLTs do provedor."
        actions={
          operate && (
            <Button onClick={() => setAuthorization({})}>
              Autorizar por serial
            </Button>
          )
        }
      />
      <OpticalNavigation mode="onu" />
      <div className="erp-stack">
        <Panel
          title="Aguardando autorização"
          description="A lista vem dos relatos dos agentes. A descoberta não confirma o vínculo a um contrato."
        >
          <QueryBoundary
            loading={found.isLoading}
            error={found.error}
            retry={() => found.mutate()}
          >
            {found.data?.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    {[
                      "Serial",
                      "OLT",
                      "Porta PON",
                      "Fabricante / modelo",
                      "Primeira leitura",
                      "Última leitura",
                      "Ação",
                    ].map((label) => (
                      <TableHead key={label}>{label}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {found.data.map((n) => (
                    <TableRow key={n.id}>
                      <TableCell>{n.serial}</TableCell>
                      <TableCell>
                        {n.device_name}
                        {n.driver === "olt_demo" && (
                          <Badge variant="warning">Simulada</Badge>
                        )}
                      </TableCell>
                      <TableCell>{n.pon_port}</TableCell>
                      <TableCell>
                        {[n.vendor, n.model].filter(Boolean).join(" · ") ||
                          "Não informado"}
                      </TableCell>
                      <TableCell>{stamp(n.first_seen_at)}</TableCell>
                      <TableCell>{stamp(n.last_seen_at)}</TableCell>
                      <TableCell>
                        {operate && (
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`Autorizar ONU ${n.serial}`}
                            onClick={() => setAuthorization({ discovery: n })}
                          >
                            Autorizar
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="profile-footnote">
                Nenhuma ONU aguardando autorização.
              </p>
            )}
          </QueryBoundary>
        </Panel>
        <Panel title="ONUs vinculadas a contratos">
          <QueryBoundary
            loading={linked.isLoading}
            error={linked.error}
            retry={() => linked.mutate()}
          >
            {linked.data?.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    {[
                      "Assinante / serial",
                      "OLT / PON",
                      "Perfil / VLAN",
                      "Intenção",
                      "Estado na OLT",
                      "RX / TX",
                      "Última leitura",
                    ].map((label) => (
                      <TableHead key={label}>{label}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {linked.data.map((n) => (
                    <TableRow key={n.id}>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            navigate(`/contratos?contrato=${n.contract_id}`)
                          }
                        >
                          {n.subscriber_name}
                        </Button>
                        <small className="table-subline">{n.serial}</small>
                      </TableCell>
                      <TableCell>
                        {n.device_name}
                        <small className="table-subline">{n.pon_port}</small>
                      </TableCell>
                      <TableCell>
                        {n.line_profile}
                        <small className="table-subline">
                          VLAN {n.service_vlan}
                        </small>
                      </TableCell>
                      <TableCell>
                        {n.desired_state === "authorized"
                          ? "Autorizada"
                          : "Removida"}
                        {n.drift && (
                          <Badge variant="warning">Divergência</Badge>
                        )}
                      </TableCell>
                      <TableCell>{state(n)}</TableCell>
                      <TableCell>
                        {dbm(n.observed_rx_dbm)}
                        <small className="table-subline">
                          {dbm(n.observed_tx_dbm)}
                        </small>
                      </TableCell>
                      <TableCell>{stamp(n.observed_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="profile-footnote">Nenhuma ONU vinculada.</p>
            )}
          </QueryBoundary>
        </Panel>
      </div>
      {authorization && (
        <AuthorizeOnu
          discovery={authorization.discovery}
          onClose={() => setAuthorization(null)}
          onDone={async () => {
            setAuthorization(null);
            await refresh();
          }}
        />
      )}
    </>
  );
}
export function ContractOnu({ id, status }: { id: string; status: string }) {
  const { me } = useSession();
  const [, setParams] = useSearchParams();
  const result = useSWR(
    ["erp-contract-onu", id],
    async () =>
      z
        .object({
          onu: onuSchema.nullable(),
          operations: z.array(operationSchema),
        })
        .parse(await api(`/contracts/${id}/onu`)),
    { refreshInterval: 3000 },
  );
  const refresh = useOnuRefresh();
  const [adding, setAdding] = useState(false);
  const n = result.data?.onu;
  const removed =
    n?.desired_state === "removed" &&
    n.observed_state === "absent" &&
    n.observed_version === n.desired_version;
  const operate = can(me, "network:operate");
  return (
    <ProfileSection
      title="ONU do contrato"
      caption="A autorização desejada e a leitura da OLT são independentes."
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {result.data && (
          <>
            {!n && (
              <p className="profile-footnote">
                Nenhuma ONU vinculada a este contrato.
              </p>
            )}
            {n && (
              <>
                {n.driver === "olt_demo" && (
                  <p role="status">
                    <Badge variant="warning">Simulada</Badge> OLT de
                    demonstração: nenhum equipamento físico é alterado e a
                    leitura relatada é fictícia.
                  </p>
                )}
                {n.driver === "olt_huawei" && (
                  <p role="status">
                    <Badge variant="warning">Não homologada</Badge> Driver
                    Huawei validado apenas contra emulador de CLI; depende de
                    homologação em equipamento físico.
                  </p>
                )}
                {n.drift && (
                  <p role="alert">
                    Divergência entre a intenção e a leitura da OLT. Nenhuma
                    correção foi aplicada automaticamente.
                  </p>
                )}
                {!n.agent_online && (
                  <p role="alert">
                    Agente offline: operações aguardam contato e a leitura pode
                    estar desatualizada.
                  </p>
                )}
                {status !== "active" && n.desired_state === "authorized" && (
                  <p role="alert">
                    Contrato encerrado com ONU ainda autorizada. Verifique a
                    necessidade de desautorizar na OLT.
                  </p>
                )}
                <div className="profile-two-columns">
                  <ProfileSection title="Identidade e intenção">
                    <ProfileFacts
                      items={[
                        ["Serial", n.serial],
                        ["OLT / porta PON", `${n.device_name} · ${n.pon_port}`],
                        [
                          "Perfis de linha / serviço",
                          `${n.line_profile} / ${n.service_profile || "Não informado"}`,
                        ],
                        ["VLAN", n.service_vlan],
                        [
                          "Intenção",
                          n.desired_state === "authorized"
                            ? "Autorizada"
                            : "Removida",
                        ],
                        ["Versão desejada", n.desired_version],
                        ["Solicitada em", stamp(n.desired_at)],
                      ]}
                    />
                  </ProfileSection>
                  <ProfileSection title="Leitura da OLT">
                    <ProfileFacts
                      items={[
                        ["Estado", state(n)],
                        ["RX recebido", dbm(n.observed_rx_dbm)],
                        ["TX transmitido", dbm(n.observed_tx_dbm)],
                        [
                          "Versão observada",
                          n.observed_version ?? "Não informada",
                        ],
                        ["Lida em", stamp(n.observed_at)],
                        ["Agente", n.agent_name || "Não informado"],
                      ]}
                    />
                  </ProfileSection>
                </div>
              </>
            )}
            {operate && (
              <div className="erp-inline-actions">
                {(!n || removed) && status === "active" && (
                  <Button onClick={() => setAdding(true)}>
                    {removed ? "Vincular outra ONU" : "Autorizar ONU"}
                  </Button>
                )}
                {n?.desired_state === "authorized" && (
                  <>
                    <ActionButton
                      danger
                      confirm="Desautorizar esta ONU na OLT? O assinante ficará sem sinal de dados."
                      onClick={async () => {
                        await api(`/onus/${n.id}/deauthorize`, {
                          body: { reason: "desautorização manual" },
                        });
                        await refresh();
                      }}
                    >
                      Desautorizar ONU
                    </ActionButton>
                    <ActionButton
                      disabled={status !== "active"}
                      onClick={async () => {
                        await api(`/onus/${n.id}/authorize`, {
                          body: { reason: "reaplicar autorização" },
                        });
                        await refresh();
                      }}
                    >
                      Reaplicar autorização
                    </ActionButton>
                  </>
                )}
              </div>
            )}
            {result.data.operations.map((o) => (
              <div key={o.id} className="erp-contract-card">
                <header>
                  <strong>{actionLabels[o.action] ?? o.action}</strong>
                  <Badge variant="outline">
                    {operationLabels[o.status] ?? o.status}
                  </Badge>
                </header>
                <p className="profile-footnote">
                  {stamp(o.created_at)} · versão {o.desired_version} ·{" "}
                  {o.reason}
                  {o.note ? ` · ${o.note}` : ""}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setParams((previous) => {
                      const next = new URLSearchParams(previous);
                      next.set("operacao", o.id);
                      return next;
                    })
                  }
                >
                  Evidências da operação
                </Button>
              </div>
            ))}
          </>
        )}
      </QueryBoundary>
      {adding && (
        <AuthorizeOnu
          contractId={id}
          onClose={() => setAdding(false)}
          onDone={async () => {
            setAdding(false);
            await refresh();
          }}
        />
      )}
    </ProfileSection>
  );
}
function AuthorizeOnu({
  contractId,
  discovery,
  onClose,
  onDone,
}: {
  contractId?: string;
  discovery?: z.infer<typeof discoverySchema>;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const devices = useDevices();
  const [query, setQuery] = useState("");
  const contracts = useSWR(
    !contractId && query.trim().length >= 2
      ? ["erp-onu-contract-pick", query.trim()]
      : null,
    ([, q]) =>
      api<{ id: string; subscriber_name: string; plan_name: string }[]>(
        `/contracts?status=active&limit=20&q=${encodeURIComponent(q)}`,
      ),
  );
  const [values, setValues] = useState({
    contract_id: contractId ?? "",
    device_id: discovery?.device_id ?? "",
    serial: discovery?.serial ?? "",
    pon_port: discovery?.pon_port ?? "",
    line_profile: "",
    service_profile: "",
    service_vlan: "",
  });
  const huawei =
    devices.data?.find((d) => d.id === values.device_id)?.driver ===
    "olt_huawei";
  const set = (key: keyof typeof values, value: string) =>
    setValues((previous) => ({ ...previous, [key]: value }));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="erp-editor">
        <DialogHeader>
          <DialogTitle>Autorizar ONU</DialogTitle>
          <DialogDescription>
            Informe os perfis existentes na OLT. A solicitação será executada
            pelo agente e depende de confirmação posterior.
          </DialogDescription>
        </DialogHeader>
        <QueryBoundary
          loading={devices.isLoading}
          error={devices.error}
          retry={() => devices.mutate()}
        >
          <MutationForm
            submit="Solicitar autorização"
            onCancel={onClose}
            onSubmit={async () => {
              await api(`/contracts/${values.contract_id}/onu`, {
                body: {
                  device_id: values.device_id,
                  serial: values.serial,
                  pon_port: values.pon_port,
                  line_profile: values.line_profile,
                  service_profile: values.service_profile || null,
                  service_vlan: Number(values.service_vlan),
                },
              });
              await onDone();
            }}
          >
            {!contractId && (
              <>
                <FormField label="Buscar contrato pelo assinante">
                  <Input
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      set("contract_id", "");
                    }}
                  />
                </FormField>
                <FormField label="Contrato para a ONU">
                  <select
                    required
                    className="commercial-select"
                    value={values.contract_id}
                    onChange={(event) => set("contract_id", event.target.value)}
                  >
                    <option value="">
                      {contracts.isLoading
                        ? "Consultando…"
                        : "Selecione um contrato vigente"}
                    </option>
                    {contracts.data?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.subscriber_name} · {c.plan_name} · {c.id.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </FormField>
                <QueryBoundary
                  error={contracts.error}
                  retry={() => contracts.mutate()}
                >
                  {null}
                </QueryBoundary>
              </>
            )}
            <div className="erp-columns">
              <FormField label="OLT da ONU">
                <select
                  required
                  disabled={Boolean(discovery)}
                  className="commercial-select"
                  value={values.device_id}
                  onChange={(event) => set("device_id", event.target.value)}
                >
                  <option value="">Selecione…</option>
                  {devices.data
                    ?.filter((d) => d.driver.startsWith("olt"))
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                        {d.driver === "olt_demo" ? " · simulada" : ""}
                      </option>
                    ))}
                </select>
              </FormField>
              <FormField label="Serial da ONU">
                <Input
                  required
                  readOnly={Boolean(discovery)}
                  maxLength={20}
                  value={values.serial}
                  onChange={(event) => set("serial", event.target.value)}
                />
              </FormField>
              <FormField label="Porta PON da ONU">
                <Input
                  required
                  readOnly={Boolean(discovery)}
                  maxLength={15}
                  value={values.pon_port}
                  onChange={(event) => set("pon_port", event.target.value)}
                />
              </FormField>
              <FormField label="Perfil de linha">
                <Input
                  required
                  maxLength={80}
                  value={values.line_profile}
                  onChange={(event) => set("line_profile", event.target.value)}
                />
              </FormField>
              <FormField label="Perfil de serviço">
                <Input
                  required={huawei}
                  maxLength={80}
                  value={values.service_profile}
                  onChange={(event) =>
                    set("service_profile", event.target.value)
                  }
                />
              </FormField>
              <FormField label="VLAN de serviço">
                <Input
                  type="number"
                  required
                  min={1}
                  max={4094}
                  value={values.service_vlan}
                  onChange={(event) => set("service_vlan", event.target.value)}
                />
              </FormField>
            </div>
            {huawei && (
              <p role="status" className="profile-footnote">
                Driver Huawei não homologado em OLT física. Valide os perfis e o
                projeto em laboratório.
              </p>
            )}
          </MutationForm>
        </QueryBoundary>
      </DialogContent>
    </Dialog>
  );
}

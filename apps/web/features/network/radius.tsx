import { RadiusAccountingReview } from "./radius-accounting";
import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { toast } from "sonner";
import { Panel } from "@/components/workspace-ui";
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
import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
import { RecordEditor } from "@/features/shared/record-editor";
import { FormField } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { CodePreview } from "@/components/technical-ui";
import { vendors, stamp, type Device } from "./models";
import { useNetworkRefresh } from "./queries";
import { useCreateRequest } from "@/features/shared/create-request";
const statusSchema = z.object({
  capabilities: z.object({
    authorization_store_reachable: z.boolean(),
    disconnect_write_enabled: z.boolean(),
    accounting_sync_enabled: z.boolean(),
    accounting_review_allowed: z.boolean(),
    counts: z.object({
      accounts: z.coerce.number(),
      nas: z.coerce.number(),
      recent_nas: z.coerce.number(),
      open_sessions: z.coerce.number(),
      stale_sessions: z.coerce.number(),
      quarantined_events: z.coerce.number(),
      unmapped_sessions: z.coerce.number(),
      ipv6_sessions: z.coerce.number(),
      uncertain_operations: z.coerce.number(),
    }),
  }),
  enabled: z.boolean(),
  host: z.string(),
  host_configured: z.boolean(),
  authPort: z.number(),
  acctPort: z.number(),
  vendors: z.array(
    z.object({ id: z.string(), tunnel: z.boolean(), validated: z.boolean() }),
  ),
  vpn: z.object({ enabled: z.boolean(), l2tp: z.boolean() }),
});
const setupSchema = z.object({
  secret: z.string().optional(),
  accounts_requested: z.number().optional(),
  accounts_without_secret: z.number().optional(),
  setup: z.object({
    commands: z.string(),
    vendor: z.string(),
    validated: z.boolean(),
    host_configured: z.boolean(),
    server_host: z.string(),
    auth_port: z.number(),
    acct_port: z.number(),
    coa_port: z.number(),
    connection: z.string(),
    tunnel: z
      .object({ kind: z.string(), endpoint: z.string(), tunnel_ip: z.string() })
      .nullable(),
  }),
});
type RadiusStatus = z.infer<typeof statusSchema>;
const nasSchema = z.object({
  vendor: z.string(),
  nas_ip: z.string().nullable(),
  coa_host: z.string().nullable(),
  coa_port: z.coerce.number(),
});
type Nas = z.infer<typeof nasSchema>;
type Setup = z.infer<typeof setupSchema>;
function useRadiusStatus() {
  return useSWR("erp-radius-status", async () =>
    statusSchema.parse(await api("/radius/status")),
  );
}
function connections(status: RadiusStatus | undefined, vendor: string) {
  const tunnel = status?.vendors.find((item) => item.id === vendor)?.tunnel;
  return [
    { value: "direct", label: "Direto ao NexoISP" },
    ...(tunnel && status?.vpn.enabled
      ? [{ value: "vpn", label: "Túnel WireGuard" }]
      : []),
    ...(tunnel && status?.vpn.l2tp
      ? [{ value: "l2tp", label: "Túnel L2TP/IPsec" }]
      : []),
  ];
}
export function RadiusOverview() {
  const { me } = useSession();
  const result = useRadiusStatus();
  const [creating, setCreating] = useState(false);
  useCreateRequest(
    "concentrador",
    () => setCreating(true),
    result.data ? can(me, "network:write") && result.data.enabled : undefined,
  );
  const [shown, setShown] = useState<Setup | null>(null);
  return (
    <Panel
      title="Autenticação integrada"
      description="Concentradores que autenticam diretamente no NexoISP."
      action={
        can(me, "network:write") && (
          <Button
            disabled={!result.data?.enabled}
            onClick={() => setCreating(true)}
          >
            Novo concentrador
          </Button>
        )
      }
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {result.data && (
          <>
            <ProfileFacts
              items={[
                [
                  "Autenticação integrada",
                  result.data.enabled
                    ? "Habilitada nesta instalação"
                    : "Não habilitada nesta instalação",
                ],
                [
                  "Registro de autorização",
                  result.data.capabilities.authorization_store_reachable
                    ? `${result.data.capabilities.counts.accounts} conta(s) · banco acessível`
                    : "Indisponível",
                ],
                [
                  "Sessões informadas",
                  `${result.data.capabilities.counts.open_sessions} abertas · ${result.data.capabilities.counts.stale_sessions} sem atualização há 15 min`,
                ],
                [
                  "Desconexão de sessão",
                  `${result.data.capabilities.disconnect_write_enabled ? "Envio habilitado" : "Envio desabilitado"} · ${result.data.capabilities.counts.uncertain_operations} resultado(s) desconhecido(s)`,
                ],
                [
                  "Leitura de accounting",
                  result.data.capabilities.accounting_sync_enabled
                    ? "Consumidor habilitado"
                    : "Consumidor desabilitado",
                ],
                [
                  "Accounting em quarentena",
                  String(result.data.capabilities.counts.quarantined_events),
                ],
                [
                  "Histórico sem NAS comprovado",
                  String(result.data.capabilities.counts.unmapped_sessions),
                ],
                [
                  "Sessões com IPv6 informado",
                  String(result.data.capabilities.counts.ipv6_sessions),
                ],
                ["Endereço do servidor", result.data.host],
                [
                  "Autenticação / accounting",
                  `${result.data.authPort} / ${result.data.acctPort} UDP`,
                ],
                [
                  "WireGuard / L2TP",
                  `${result.data.vpn.enabled ? "Habilitado" : "Não habilitado"} / ${result.data.vpn.l2tp ? "Habilitado" : "Não habilitado"}`,
                ],
              ]}
            />
            <p className="profile-footnote">
              Os comandos de configuração não são aplicados automaticamente ao
              concentrador. Túneis dependem dos recursos habilitados nesta
              instalação. Pacote recente e banco acessível não comprovam a
              aplicação de perfil no equipamento. Sessões antigas são
              sinalizadas para conferência; esta tela não as encerra
              automaticamente.
            </p>
            {!result.data.host_configured && (
              <Badge variant="warning" className="h-auto whitespace-normal">
                Endereço público do servidor ainda não configurado
              </Badge>
            )}
          </>
        )}
      </QueryBoundary>
      {result.data?.capabilities.accounting_review_allowed && (
        <RadiusAccountingReview />
      )}
      {creating && (
        <RadiusEditor
          status={result.data}
          onClose={() => setCreating(false)}
          onDone={(value) => {
            setCreating(false);
            setShown(value);
          }}
        />
      )}
      {shown && <RadiusSetup value={shown} onClose={() => setShown(null)} />}
    </Panel>
  );
}
export function RadiusActions({ device }: { device: Device }) {
  const result = useRadiusStatus();
  const refresh = useNetworkRefresh();
  const [shown, setShown] = useState<Setup | null>(null);
  const [converting, setConverting] = useState(false);
  const [editing, setEditing] = useState<Nas | null>(null);
  const integrated = device.driver === "radius";
  return (
    <ProfileSection
      title={
        integrated
          ? "Configuração do concentrador"
          : "Migração para autenticação integrada"
      }
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {integrated ? (
          <>
            <ProfileFacts
              items={[
                [
                  "Conexão",
                  device.tunnel
                    ? `${device.tunnel.kind} · ${device.tunnel.ip}`
                    : `Direta · ${device.nas_ip ?? "IP não informado"}`,
                ],
                [
                  "Último handshake do túnel",
                  device.tunnel
                    ? stamp(device.tunnel.handshake_at)
                    : "Não se aplica",
                ],
              ]}
            />
            <div className="erp-inline-actions">
              <ActionButton
                onClick={async () =>
                  setShown(
                    setupSchema.parse(
                      await api(`/radius/devices/${device.id}/setup`),
                    ),
                  )
                }
              >
                Instruções do concentrador
              </ActionButton>
              <ActionButton
                onClick={async () =>
                  setEditing(
                    nasSchema.parse(
                      await api(`/radius/devices/${device.id}/setup`),
                    ),
                  )
                }
              >
                Editar concentrador
              </ActionButton>
              <ActionButton
                confirm="Gerar um novo segredo? O atual deixa de valer em até dois minutos e precisa ser trocado também no concentrador."
                onClick={async () => {
                  setShown(
                    setupSchema.parse(
                      await api(`/radius/devices/${device.id}/secret`, {
                        method: "POST",
                      }),
                    ),
                  );
                  await refresh();
                }}
              >
                Trocar segredo
              </ActionButton>
              {connections(result.data, device.vendor ?? "generic")
                .filter((item) => item.value !== "direct")
                .map((item) => (
                  <ActionButton
                    key={item.value}
                    confirm="Gerar um novo túnel? O endereço e as credenciais atuais deixarão de valer. Será necessário reconfigurar o concentrador."
                    onClick={async () => {
                      setShown(
                        setupSchema.parse(
                          await api(`/radius/devices/${device.id}/tunnel`, {
                            body: { kind: item.value },
                          }),
                        ),
                      );
                      await refresh();
                    }}
                  >
                    {device.tunnel &&
                    (device.tunnel.kind === "l2tp") === (item.value === "l2tp")
                      ? "Refazer"
                      : "Usar"}{" "}
                    {item.label}
                  </ActionButton>
                ))}
            </div>
          </>
        ) : (
          <>
            <p className="profile-footnote">
              {device.accounts} conta(s) neste equipamento. A conversão altera a
              integração do cadastro; o concentrador deverá ser configurado com
              as instruções emitidas.
            </p>
            <Button
              variant="outline"
              disabled={!result.data?.enabled}
              onClick={() => setConverting(true)}
            >
              Converter para autenticação integrada
            </Button>
          </>
        )}
      </QueryBoundary>
      {converting && (
        <RadiusEditor
          device={device}
          status={result.data}
          onClose={() => setConverting(false)}
          onDone={(value) => {
            setConverting(false);
            setShown(value);
            toast.success(
              `${value.accounts_requested ?? 0} conta(s) reenviada(s) · ${value.accounts_without_secret ?? 0} sem senha cadastrada.`,
            );
          }}
        />
      )}
      {editing && (
        <NasEditor
          device={device}
          nas={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {shown && <RadiusSetup value={shown} onClose={() => setShown(null)} />}
    </ProfileSection>
  );
}
function RadiusEditor({
  device,
  status,
  onClose,
  onDone,
}: {
  device?: Device;
  status?: RadiusStatus;
  onClose: () => void;
  onDone: (value: Setup) => void;
}) {
  const refresh = useNetworkRefresh();
  return (
    <RecordEditor
      title={device ? "Converter concentrador" : "Novo concentrador"}
      description={
        device
          ? `As ${device.accounts} conta(s) passarão à autenticação integrada. O NAS precisa ser configurado com os comandos emitidos; isso não comprova conectividade remota.`
          : "Cadastre o NAS e copie o segredo e as instruções emitidas pelo servidor."
      }
      initial={{
        name: device?.name ?? "",
        vendor: "mikrotik",
        connection: "direct",
        nas_ip: device?.host ?? "",
        coa_port: "3799",
      }}
      fields={[
        ...(!device
          ? [
              {
                key: "name",
                label: "Nome do concentrador",
                required: true,
                maxLength: 80,
              },
            ]
          : []),
        {
          key: "vendor",
          label: "Fabricante do concentrador",
          type: "select",
          options: Object.entries(vendors).map(([value, label]) => ({
            value,
            label: value === "mikrotik" ? label : `${label} · não homologado`,
          })),
        },
        {
          key: "connection",
          label: "Conexão com o NexoISP",
          type: "select",
          options: (values) => connections(status, values.vendor),
        },
        {
          key: "nas_ip",
          label: "IP de origem do concentrador",
          required: true,
          when: (values) =>
            !connections(status, values.vendor).some(
              (item) => item.value === values.connection,
            ) || values.connection === "direct",
          hint: "Endereço de origem dos pacotes que chegam ao NexoISP.",
        },
        ...(!device
          ? [
              {
                key: "coa_port",
                label: "Porta de desconexão (CoA)",
                type: "number" as const,
                required: true,
                min: 1,
                max: 65535,
              },
            ]
          : []),
      ]}
      submit={device ? "Converter" : "Cadastrar concentrador"}
      onClose={onClose}
      onSubmit={async (values) => {
        const connection = connections(status, values.vendor).some(
          (item) => item.value === values.connection,
        )
          ? values.connection
          : "direct";
        const value = setupSchema.parse(
          await api(
            device
              ? `/devices/${device.id}/convert-to-integrated`
              : "/radius/devices",
            {
              body: {
                ...(!device
                  ? { name: values.name, coa_port: Number(values.coa_port) }
                  : {}),
                vendor: values.vendor,
                connection,
                ...(connection === "direct" ? { nas_ip: values.nas_ip } : {}),
              },
            },
          ),
        );
        onDone(value);
        await refresh();
      }}
    />
  );
}
// Ajusta fabricante, IP de origem e destino da desconexão (CoA) do NAS integrado.
function NasEditor({
  device,
  nas,
  onClose,
}: {
  device: Device;
  nas: Nas;
  onClose: () => void;
}) {
  const refresh = useNetworkRefresh();
  return (
    <RecordEditor
      title="Editar concentrador"
      description="Dados usados pela autenticação integrada. Depois de trocar o fabricante, aplique novamente as instruções no concentrador."
      initial={{
        vendor: nas.vendor,
        nas_ip: nas.nas_ip ?? "",
        coa_host: nas.coa_host ?? "",
        coa_port: String(nas.coa_port),
      }}
      fields={[
        {
          key: "vendor",
          label: "Fabricante do concentrador",
          type: "select",
          options: Object.entries(vendors).map(([value, label]) => ({
            value,
            label: value === "mikrotik" ? label : `${label} · não homologado`,
          })),
        },
        ...(!device.tunnel
          ? [
              {
                key: "nas_ip",
                label: "IP de origem do concentrador",
                required: true,
                hint: "Endereço de origem dos pacotes que chegam ao NexoISP.",
              },
            ]
          : []),
        {
          key: "coa_host",
          label: "Endereço para desconexão (CoA)",
          maxLength: 200,
          hint: "Deixe em branco para usar o IP de origem do concentrador.",
        },
        {
          key: "coa_port",
          label: "Porta de desconexão (CoA)",
          type: "number",
          required: true,
          min: 1,
          max: 65535,
        },
      ]}
      submit="Salvar concentrador"
      onClose={onClose}
      onSubmit={async (values) => {
        const result = z
          .object({ reapply_needed: z.boolean().optional() })
          .parse(
            await api(`/radius/devices/${device.id}`, {
              method: "PATCH",
              body: {
                ...(values.vendor !== nas.vendor
                  ? { vendor: values.vendor }
                  : {}),
                ...(!device.tunnel && values.nas_ip !== (nas.nas_ip ?? "")
                  ? { nas_ip: values.nas_ip }
                  : {}),
                coa_host: values.coa_host.trim() || null,
                coa_port: Number(values.coa_port),
              },
            }),
          );
        toast.success(
          result.reapply_needed
            ? "Concentrador atualizado. Aplique novamente as instruções no equipamento."
            : "Concentrador atualizado.",
        );
        onClose();
        await refresh();
      }}
    />
  );
}
function RadiusSetup({
  value,
  onClose,
}: {
  value: Setup;
  onClose: () => void;
}) {
  const setup = value.setup;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="erp-editor">
        <DialogHeader>
          <DialogTitle>Configure o concentrador</DialogTitle>
          <DialogDescription>
            {value.secret
              ? "Copie o segredo agora. Ele não será exibido novamente."
              : "Instruções do cadastro. Segredos anteriores não são recuperados por esta consulta."}
          </DialogDescription>
        </DialogHeader>
        {value.secret && (
          <FormField label="Segredo do concentrador">
            <Input
              readOnly
              className="mono"
              autoComplete="off"
              value={value.secret}
              onFocus={(event) => event.currentTarget.select()}
            />
          </FormField>
        )}
        {!setup.host_configured && (
          <Badge variant="warning" className="h-auto whitespace-normal">
            Substitua o endereço de exemplo pelo endereço público da instalação
          </Badge>
        )}
        {!setup.validated && (
          <Badge variant="warning" className="h-auto whitespace-normal">
            Fabricante não homologado em equipamento real
          </Badge>
        )}
        <ProfileFacts
          items={[
            ["Servidor", setup.server_host],
            [
              "Autenticação / accounting / CoA",
              `${setup.auth_port} / ${setup.acct_port} / ${setup.coa_port} UDP`,
            ],
            ["Conexão", setup.connection],
            [
              "Túnel",
              setup.tunnel
                ? `${setup.tunnel.kind} · ${setup.tunnel.endpoint} · ${setup.tunnel.tunnel_ip}`
                : "Não utilizado",
            ],
          ]}
        />
        {setup.tunnel && (
          <p className="profile-footnote">
            Credenciais privadas de túnel são mostradas na emissão. Consultas
            posteriores usam marcadores; refazer o túnel gera outras credenciais
            e exige reconfiguração.
          </p>
        )}
        <CodePreview
          title="Comandos do concentrador"
          code={setup.commands}
          filename="nexoisp-concentrador.rsc"
        />
        <div className="erp-inline-actions">
          <Button onClick={onClose}>
            {value.secret ? "Já guardei o segredo" : "Fechar instruções"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

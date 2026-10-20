import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
import { QueryBoundary } from "@/features/shared/feedback";
import { RecordEditor } from "@/features/shared/record-editor";
import { FormField } from "@/features/shared/form";
import { ActionButton } from "@/features/shared/action";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import {
  operationSchema,
  operationLabels,
  actionLabels,
  stamp,
} from "./models";
import { useDevices, useNetworkRefresh } from "./queries";
export const serviceSchema = z.object({
  resource: z
    .object({
      id: z.string().uuid(),
      driver: z.string(),
      device_name: z.string(),
      pppoe_username: z.string(),
      access_type: z.string(),
      mac: z.string().nullable(),
      has_secret: z.boolean(),
      agent_name: z.string().nullable(),
      agent_online: z.boolean(),
      agent_last_seen: z.string().nullable(),
      desired_version: z.coerce.number(),
      desired_policy: z.string(),
      desired_profile: z.string(),
      desired_reason: z.string().nullable(),
      desired_at: z.string().nullable(),
      observed_version: z.coerce.number().nullable(),
      observed_policy: z.string().nullable(),
      observed_profile: z.string().nullable(),
      observed_at: z.string().nullable(),
      observed_session: z
        .object({
          online: z.boolean().optional(),
          unknown: z.boolean().optional(),
          ip: z.string().nullable().optional(),
        })
        .passthrough()
        .nullable(),
      drift: z.boolean(),
      maintenance: z.boolean(),
    })
    .nullable(),
  operations: z.array(operationSchema),
});
const policy = (value: string | null) =>
  value
    ? ((
        {
          active: "Liberado",
          suspended: "Suspenso",
          absent: "Sem autorização local",
        } as Record<string, string>
      )[value] ?? value)
    : "Não observado";
export function ContractService({
  id,
  status,
  planName,
}: {
  id: string;
  status: string;
  planName?: string;
}) {
  const { me } = useSession();
  const [, setParams] = useSearchParams();
  const result = useSWR(
    ["erp-service", id],
    async ([, id]) =>
      serviceSchema.parse(await api(`/contracts/${id}/service`)),
    { refreshInterval: 3000 },
  );
  const refresh = useNetworkRefresh();
  const [editor, setEditor] = useState<"create" | "password" | "mac" | null>(
    null,
  );
  const [generated, setGenerated] = useState<string | null>(null);
  const r = result.data?.resource;
  const operate = can(me, "network:operate");
  const command = async (action: string, reason: string) => {
    await api(`/resources/${r!.id}/${action}`, { body: { reason } });
    await refresh();
  };
  const stale =
    r?.driver !== "radius" &&
    r?.observed_at &&
    Date.now() - Date.parse(r.observed_at) > 600000;
  return (
    <ProfileSection
      title={planName ? `Acesso · ${planName}` : "Acesso do contrato"}
      caption="A intenção solicitada e a leitura do equipamento são apresentadas separadamente."
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {result.data && !r && (
          <>
            <p className="profile-footnote">
              {status === "active"
                ? "Este contrato ainda não possui acesso provisionado."
                : "Contrato encerrado sem acesso provisionado."}
            </p>
            {operate && status === "active" && (
              <Button onClick={() => setEditor("create")}>
                Provisionar acesso
              </Button>
            )}
          </>
        )}
        {r && (
          <>
            {r.driver === "demo" && (
              <p role="status">
                <Badge variant="warning">SIMULADO</Badge> Equipamento de
                demonstração: a sessão é fictícia e nenhuma rede real é
                alterada.
              </p>
            )}
            {r.maintenance && (
              <p role="alert">
                Equipamento em manutenção: escritas não são enviadas.
              </p>
            )}
            {r.driver !== "radius" && !r.agent_online && (
              <p role="alert">
                Agente offline. As alterações aguardam contato; a autorização
                local conserva a última política conhecida.
              </p>
            )}
            {result.data?.operations.some((o) => o.status === "UNCERTAIN") && (
              <p role="alert">
                Operação incerta: aguarde a verificação do agente antes de
                repetir.
              </p>
            )}
            {r.drift && (
              <p role="alert">
                Divergência entre a intenção e o estado observado. Confira as
                evidências antes de reaplicar.
              </p>
            )}
            {r.desired_version === 0 && (
              <p role="status">
                Conta importada ainda não enviada ao equipamento.
                {!r.has_secret && " Informe uma senha antes de provisionar."}
              </p>
            )}
            <div className="profile-two-columns">
              <ProfileSection title="Intenção solicitada">
                <ProfileFacts
                  items={[
                    ["Política", policy(r.desired_policy)],
                    ["Perfil", r.desired_profile],
                    ["Versão", String(r.desired_version)],
                    ["Solicitada em", stamp(r.desired_at)],
                    ["Motivo", r.desired_reason || "Não informado"],
                  ]}
                />
              </ProfileSection>
              <ProfileSection title="Estado observado">
                <ProfileFacts
                  items={[
                    ["Política", policy(r.observed_policy)],
                    ["Perfil", r.observed_profile || "Não observado"],
                    [
                      "Versão",
                      r.observed_version == null
                        ? "Não observada"
                        : String(r.observed_version),
                    ],
                    [
                      "Sessão",
                      !r.observed_at
                        ? "Ainda não observada"
                        : r.observed_session?.unknown
                          ? "Desconhecida · concentrador não respondeu"
                          : r.observed_session?.online
                            ? "Online"
                            : "Sem sessão",
                    ],
                    ["IP", r.observed_session?.ip || "Não informado"],
                    ["Leitura", stamp(r.observed_at)],
                  ]}
                />
                {stale && (
                  <Badge variant="warning">Leitura desatualizada</Badge>
                )}
              </ProfileSection>
            </div>
            <ProfileFacts
              items={[
                ["Contrato", status === "active" ? "Vigente" : "Encerrado"],
                [
                  "Tipo de acesso",
                  (
                    {
                      pppoe: "PPPoE",
                      ipoe: "IPoE",
                      hotspot: "Hotspot",
                    } as Record<string, string>
                  )[r.access_type] ?? r.access_type,
                ],
                ["Login", r.pppoe_username],
                ["Equipamento", r.device_name],
                ["Agente", r.agent_name || "Não informado"],
                ["MAC vinculado", r.mac || "Sem vínculo"],
              ]}
            />
            {r.access_type === "ipoe" && (
              <p className="profile-footnote">
                No IPoE, suspensão e troca de plano valem na próxima renovação
                da concessão, em até dez minutos.
              </p>
            )}
            {operate && (
              <div className="erp-inline-actions">
                {r.desired_policy === "active" ? (
                  <ActionButton
                    danger
                    confirm="Suspender o acesso deste contrato?"
                    onClick={() => command("suspend", "suspensão manual")}
                  >
                    Suspender acesso
                  </ActionButton>
                ) : (
                  <ActionButton
                    disabled={status !== "active"}
                    onClick={() => command("resume", "reativação manual")}
                  >
                    Reativar acesso
                  </ActionButton>
                )}
                {r.desired_version > 0 && (
                  <ActionButton
                    confirm="Desconectar a sessão? O assinante poderá reconectar em seguida."
                    onClick={() => command("disconnect", "desconexão manual")}
                  >
                    Desconectar sessão
                  </ActionButton>
                )}
                <ActionButton
                  disabled={
                    status !== "active" ||
                    r.desired_policy !== "active" ||
                    (!r.has_secret && r.access_type !== "ipoe")
                  }
                  onClick={() =>
                    command(
                      "provision",
                      r.desired_version === 0
                        ? "provisionamento de conta importada"
                        : "reaplicar intenção",
                    )
                  }
                >
                  {r.desired_version === 0
                    ? "Provisionar conta importada"
                    : "Reaplicar acesso"}
                </ActionButton>
                {r.access_type !== "ipoe" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditor("password")}
                  >
                    Trocar senha de acesso
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditor("mac")}
                >
                  Alterar vínculo MAC
                </Button>
              </div>
            )}
            <ProfileSection title="Operações deste acesso">
              {result.data?.operations.length ? (
                result.data.operations.map((o) => (
                  <div className="erp-contract-card" key={o.id}>
                    <header>
                      <strong>{actionLabels[o.action] ?? o.action}</strong>
                      <Badge
                        variant={
                          ["FAILED", "UNCERTAIN", "EXPIRED"].includes(o.status)
                            ? "warning"
                            : "outline"
                        }
                      >
                        {operationLabels[o.status] ?? o.status}
                      </Badge>
                    </header>
                    <p className="profile-footnote">
                      {stamp(o.created_at)} · intenção v{o.desired_version} ·{" "}
                      {o.reason}
                      {o.note ? ` · ${o.note}` : ""}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
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
                ))
              ) : (
                <p className="profile-footnote">Nenhuma operação registrada.</p>
              )}
            </ProfileSection>
          </>
        )}
      </QueryBoundary>
      {editor === "create" && (
        <ProvisionAccess
          id={id}
          onClose={() => setEditor(null)}
          onDone={(password) => {
            setEditor(null);
            setGenerated(password);
            void refresh();
          }}
        />
      )}
      {editor === "password" && r && (
        <RecordEditor
          title="Trocar senha de acesso"
          description="A alteração solicita uma operação de provisionamento. A confirmação depende da execução na rede."
          initial={{ password: "" }}
          fields={[
            {
              key: "password",
              label: "Nova senha de acesso",
              type: "password",
              required: true,
              maxLength: 64,
            },
          ]}
          onClose={() => setEditor(null)}
          submit="Trocar e reaplicar"
          onSubmit={async (values) => {
            if (values.password.length < 6)
              throw new Error(
                "Informe uma senha com pelo menos seis caracteres.",
              );
            await api(`/resources/${r.id}/secret`, {
              method: "PATCH",
              body: { password: values.password },
            });
            setEditor(null);
            await refresh();
          }}
        />
      )}
      {editor === "mac" && r && (
        <RecordEditor
          title="Vínculo MAC do acesso"
          description="O vínculo limita a autenticação ao equipamento informado. Em branco, remove o vínculo quando permitido pelo tipo de acesso."
          initial={{ mac: r.mac ?? "" }}
          fields={[
            {
              key: "mac",
              label: "MAC autorizado",
              maxLength: 17,
              required: r.access_type === "ipoe",
            },
          ]}
          onClose={() => setEditor(null)}
          onSubmit={async (values) => {
            await api(`/resources/${r.id}/mac`, {
              method: "PATCH",
              body: { mac: values.mac.trim() || null },
            });
            setEditor(null);
            await refresh();
          }}
        />
      )}
      {generated && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setGenerated(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Senha gerada do acesso</DialogTitle>
              <DialogDescription>
                Copie agora. Esta senha não é recuperada pelas consultas
                posteriores.
              </DialogDescription>
            </DialogHeader>
            <FormField label="Senha gerada">
              <Input
                readOnly
                autoComplete="off"
                value={generated}
                onFocus={(event) => event.currentTarget.select()}
              />
            </FormField>
            <Button onClick={() => setGenerated(null)}>
              Já guardei a senha
            </Button>
          </DialogContent>
        </Dialog>
      )}
    </ProfileSection>
  );
}
function ProvisionAccess({
  id,
  onClose,
  onDone,
}: {
  id: string;
  onClose: () => void;
  onDone: (password: string | null) => void;
}) {
  const devices = useDevices();
  return (
    <RecordEditor
      title="Provisionar acesso"
      description="O servidor valida o contrato e registra a intenção. A solicitação não comprova a aplicação no equipamento."
      loading={devices.isLoading}
      error={devices.error}
      retry={() => devices.mutate()}
      initial={{
        device_id: "",
        access_type: "pppoe",
        pppoe_username: "",
        password: "",
        mac: "",
      }}
      fields={[
        {
          key: "device_id",
          label: "Equipamento de acesso",
          type: "select",
          required: true,
          options: [
            { value: "", label: "Selecione…" },
            ...(devices.data ?? [])
              .filter((d) => !d.driver.startsWith("olt"))
              .map((d) => ({
                value: d.id,
                label: `${d.name}${d.driver === "demo" ? " · simulado" : ""}`,
              })),
          ],
        },
        {
          key: "access_type",
          label: "Tipo de acesso",
          type: "select",
          options: (values) => [
            { value: "pppoe", label: "PPPoE" },
            ...(devices.data?.find((d) => d.id === values.device_id)?.driver ===
            "radius"
              ? [
                  { value: "ipoe", label: "IPoE · DHCP pelo MAC" },
                  { value: "hotspot", label: "Hotspot" },
                ]
              : []),
          ],
        },
        {
          key: "pppoe_username",
          label: "Login do acesso",
          required: true,
          maxLength: 80,
          when: (v) =>
            v.access_type !== "ipoe" ||
            devices.data?.find((d) => d.id === v.device_id)?.driver !==
              "radius",
        },
        {
          key: "password",
          label: "Senha do acesso",
          type: "password",
          maxLength: 64,
          hint: "Em branco: gerada pelo servidor.",
          when: (v) =>
            v.access_type !== "ipoe" ||
            devices.data?.find((d) => d.id === v.device_id)?.driver !==
              "radius",
        },
        {
          key: "mac",
          label: "MAC do equipamento do assinante",
          required: true,
          maxLength: 17,
          when: (v) =>
            v.access_type === "ipoe" &&
            devices.data?.find((d) => d.id === v.device_id)?.driver ===
              "radius",
        },
      ]}
      onClose={onClose}
      submit="Solicitar provisionamento"
      onSubmit={async (values) => {
        const integrated =
          devices.data?.find((d) => d.id === values.device_id)?.driver ===
          "radius";
        const access = integrated ? values.access_type : "pppoe";
        const response = await api<{ generated_password: string | null }>(
          `/contracts/${id}/service`,
          {
            body: {
              device_id: values.device_id,
              access_type: access,
              ...(access === "ipoe"
                ? { mac: values.mac }
                : {
                    pppoe_username: values.pppoe_username,
                    ...(values.password ? { password: values.password } : {}),
                  }),
            },
          },
        );
        onDone(response.generated_password);
      }}
    />
  );
}

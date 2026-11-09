import { useState } from "react";
import useSWR from "swr";
import { Panel } from "@/components/workspace-ui";
import { ProfileFacts } from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RecordEditor } from "@/features/shared/record-editor";
import { QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { sessionScope } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { viabilityRadius, viabilitySettingsSchema } from "./models";

/** Consulta pública de viabilidade: ativação, raio, contato e prospecto no CRM. */
export function ViabilitySettings() {
  const { me } = useSession();
  const current = useSWR(
    me?.tenant ? ["erp-viability-settings", sessionScope(me)] : null,
    async () => viabilitySettingsSchema.parse(await api("/settings/viability")),
  );
  const [editing, setEditing] = useState(false);
  const data = current.data;
  const publicUrl = data ? `${window.location.origin}${data.public_path}` : "";
  return (
    <Panel
      title="Consulta pública de viabilidade"
      description="Página sem login em que o interessado informa a localização e recebe apenas se o local é atendido, sem expor caixas, distâncias ou ocupação."
      action={
        data && (
          <Button variant="outline" onClick={() => setEditing(true)}>
            Editar consulta de viabilidade
          </Button>
        )
      }
    >
      <QueryBoundary
        loading={current.isLoading}
        error={current.error}
        retry={() => current.mutate()}
      >
        {data && (
          <>
            <ProfileFacts
              items={[
                ["Situação", data.enabled ? "Ativa" : "Desativada"],
                ["Raio de atendimento", `${data.radius_m} m`],
                ["Mensagem da página", data.message ?? "Não definida"],
                ["Telefone de contato", data.phone ?? "Não definido"],
                ["WhatsApp de contato", data.whatsapp ?? "Não definido"],
                [
                  "Prospecto no CRM",
                  data.create_lead
                    ? "Criado quando o resultado é positivo e o interessado autoriza o contato"
                    : "Não criado",
                ],
                ["Endereço público", publicUrl],
              ]}
            />
            <div className="erp-inline-actions">
              <Badge variant={data.enabled ? "success" : "secondary"}>
                {data.enabled ? "Página publicada" : "Página indisponível"}
              </Badge>
              {data.enabled && (
                <a
                  href={data.public_path}
                  target="_blank"
                  rel="noreferrer"
                  className="profile-text-action"
                >
                  Abrir página de viabilidade
                </a>
              )}
            </div>
            {!data.modules.ftth && (
              <p className="profile-footnote" role="note">
                A consulta usa as caixas FTTH cadastradas e só é publicada com o
                módulo FTTH liberado para o provedor.
              </p>
            )}
            {data.create_lead && !data.modules.crm && (
              <p className="profile-footnote" role="note">
                O módulo CRM não está liberado: a página não oferece o envio de
                contato enquanto isso.
              </p>
            )}
            <p className="profile-footnote">
              Atende quem estiver dentro do raio de uma caixa de atendimento
              (CTO) com coordenadas e ao menos uma porta livre. Caixas de emenda
              não contam. A página aplica limite de consultas por endereço de
              origem.
            </p>
          </>
        )}
      </QueryBoundary>
      {editing && data && (
        <RecordEditor
          title="Consulta de viabilidade"
          description="As alterações valem imediatamente para a página pública."
          initial={{
            enabled: String(data.enabled),
            radius_m: String(data.radius_m),
            message: data.message ?? "",
            phone: data.phone ?? "",
            whatsapp: data.whatsapp ?? "",
            create_lead: String(data.create_lead),
          }}
          fields={[
            {
              key: "enabled",
              label: "Publicar consulta de viabilidade",
              type: "select",
              options: [
                { value: "true", label: "Sim" },
                { value: "false", label: "Não" },
              ],
            },
            {
              key: "radius_m",
              label: "Raio de atendimento (metros)",
              type: "number",
              required: true,
              min: viabilityRadius.min,
              max: viabilityRadius.max,
              hint: `De ${viabilityRadius.min} a ${viabilityRadius.max} metros; o padrão é ${viabilityRadius.default}.`,
            },
            {
              key: "message",
              label: "Mensagem da página",
              type: "textarea",
              maxLength: 500,
            },
            { key: "phone", label: "Telefone de contato", maxLength: 20 },
            {
              key: "whatsapp",
              label: "WhatsApp com país e DDD",
              maxLength: 25,
            },
            {
              key: "create_lead",
              label: "Criar prospecto no CRM com resultado positivo",
              type: "select",
              options: [
                { value: "true", label: "Sim" },
                { value: "false", label: "Não" },
              ],
            },
          ]}
          onClose={() => setEditing(false)}
          onSubmit={async (values) => {
            const radius = Number(values.radius_m);
            if (
              !Number.isInteger(radius) ||
              radius < viabilityRadius.min ||
              radius > viabilityRadius.max
            )
              throw new Error(
                `Informe um raio inteiro de ${viabilityRadius.min} a ${viabilityRadius.max} metros.`,
              );
            const saved = viabilitySettingsSchema.parse(
              await api("/settings/viability", {
                method: "PUT",
                body: {
                  enabled: values.enabled === "true",
                  radius_m: radius,
                  message: values.message.trim() || null,
                  phone: values.phone.trim() || null,
                  whatsapp: values.whatsapp.trim() || null,
                  create_lead: values.create_lead === "true",
                },
              }),
            );
            setEditing(false);
            await current.mutate(saved, { revalidate: false });
          }}
        />
      )}
    </Panel>
  );
}

import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { QueryBoundary } from "@/features/shared/feedback";
import { RecordEditor } from "@/features/shared/record-editor";
import { ActionButton } from "@/features/shared/action";
import { api } from "@/platform/erp-client";
const schema = z.object({
  kind: z.enum(["efi_pix", "efi_charges"]),
  url: z.string(),
  registration_enabled: z.boolean(),
  charges_receiver_enabled: z.boolean(),
  inbox: z.object({
    total: z.number(),
    pending: z.number(),
    review: z.number(),
    last_received_at: z.string().nullable(),
    last_processed_at: z.string().nullable(),
  }),
  last_registration: z
    .object({ outcome: z.string().nullable(), at: z.string() })
    .nullable(),
});
export function FinancialCallback({ connection }: { connection: string }) {
  const query = useSWR(["financial-callback", connection], async () =>
    schema.parse(await api(`/financial-connections/${connection}/callback`)),
  );
  const [register, setRegister] = useState(false);
  const data = query.data;
  return (
    <ProfileSection title="Notificações do fornecedor">
      <QueryBoundary
        loading={query.isLoading}
        error={query.error}
        retry={() => query.mutate()}
      >
        {data && (
          <div className="erp-stack">
            <ProfileFacts
              items={[
                ["URL definida no servidor", data.url || "Não configurada"],
                ["Avisos recebidos", data.inbox.total],
                ["Pendentes", data.inbox.pending],
                ["Avisos em revisão", data.inbox.review],
                [
                  "Último aviso",
                  data.inbox.last_received_at
                    ? new Date(data.inbox.last_received_at).toLocaleString(
                        "pt-BR",
                      )
                    : "Nenhum",
                ],
                [
                  "Último registro Pix",
                  data.last_registration?.outcome === "confirmed"
                    ? "Confirmado por consulta"
                    : data.last_registration
                      ? "Sem confirmação"
                      : "Não realizado",
                ],
              ]}
            />
            {data.kind === "efi_charges" ? (
              <p>
                Novas emissões Bolix recebem a URL configurada no servidor. O
                aviso contém somente um token; recebimentos dependem da consulta
                autenticada da cobrança. Receptor{" "}
                {data.charges_receiver_enabled ? "habilitado" : "desabilitado"}.
              </p>
            ) : (
              <p>
                Registro Pix requer URL pública HTTPS, receptor mTLS e escopos
                do fornecedor. Configuração local não comprova homologação.
              </p>
            )}
            <div className="erp-inline-actions">
              <ActionButton
                onClick={async () => {
                  await query.mutate();
                }}
              >
                Atualizar notificações
              </ActionButton>
              {data.registration_enabled && (
                <Button variant="outline" onClick={() => setRegister(true)}>
                  Registrar callback Pix
                </Button>
              )}
            </div>
            {register && (
              <RecordEditor
                title="Registrar callback Pix"
                description="Uma chave Pix aceita uma URL de webhook. A operação consulta a configuração atual e exige autorização explícita para substituir outra URL. A confirmação depende de leitura no fornecedor."
                initial={{ reason: "", replace: "false" }}
                fields={[
                  {
                    key: "reason",
                    label: "Justificativa (10 a 500 caracteres)",
                    required: true,
                    maxLength: 500,
                  },
                  {
                    key: "replace",
                    label: "Autorizar substituição de URL existente",
                    type: "select",
                    options: [
                      { value: "false", label: "Não substituir outra URL" },
                      {
                        value: "true",
                        label: "Autorizo substituir a URL existente",
                      },
                    ],
                  },
                ]}
                onClose={() => setRegister(false)}
                submit="Registrar e conferir"
                onSubmit={async (v) => {
                  await api(`/financial-connections/${connection}/callback`, {
                    body: {
                      reason: v.reason,
                      replace_existing: v.replace === "true",
                    },
                  });
                  setRegister(false);
                  await query.mutate();
                }}
              />
            )}
          </div>
        )}
      </QueryBoundary>
    </ProfileSection>
  );
}

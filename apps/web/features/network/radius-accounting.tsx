import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
import { QueryBoundary } from "@/features/shared/feedback";
import { RecordEditor } from "@/features/shared/record-editor";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { stamp } from "./models";
const eventSchema = z.object({
  id: z.string(),
  source_ip: z.string(),
  nas_device_id: z.string().nullable(),
  kind: z.string(),
  username: z.string(),
  session_id: z.string(),
  reason: z.string().nullable(),
  received_at: z.string(),
  deliveries: z.coerce.number(),
  reprocesses: z.coerce.number(),
  review_reason: z.string().nullable(),
});
type AccountingEvent = z.infer<typeof eventSchema>;
const reasons: Record<string, string> = {
  overlapping_generation: "Nova geração sobrepõe uma sessão ainda aberta",
  missing_session_time: "Sem tempo de sessão e sem geração correspondente",
  session_clock_divergence: "Relógio/geração diverge da sessão aberta",
  ambiguous_generation: "Mais de uma geração corresponde ao evento",
  unregistered_nas: "Origem sem identidade de concentrador comprovada",
  event_clock_outside_window: "Data fora da janela de recebimento",
  invalid_values: "Valores inválidos ou acima da capacidade de armazenamento",
  invalid_counters: "Contadores inválidos",
  invalid_ipv6: "IPv6 inválido",
  missing_identity: "Identidade de sessão incompleta",
};
export function RadiusAccountingReview() {
  const { me } = useSession();
  const allowed = !!me && !me.support;
  const { mutate } = useSWRConfig();
  const [action, setAction] = useState<"reconcile" | "dismiss">("reconcile");
  const [before, setBefore] = useState<string | null>(null);
  const result = useSWR(
    allowed ? ["erp-radius-accounting", before] : null,
    async () =>
      z
        .array(eventSchema)
        .parse(
          await api(
            `/radius/accounting/events${before ? `?before=${encodeURIComponent(before)}` : ""}`,
          ),
        ),
  );
  const [review, setReview] = useState<AccountingEvent | null>(null);
  if (!allowed) return null;
  return (
    <ProfileSection title="Eventos de accounting em quarentena">
      <p className="profile-footnote">
        Eventos em páginas de até 100 registros. A conciliação repete somente o
        processamento dos dados originais, sem enviar comandos ao NAS. Ausência
        de sessão não autoriza encerramento por suposição.
      </p>
      <Button
        variant="outline"
        onClick={() => {
          setBefore(null);
          void result.mutate();
          void mutate("erp-radius-status");
        }}
      >
        Atualizar eventos
      </Button>
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {result.data?.length === 0 && (
          <p className="profile-footnote">Nenhum evento em quarentena.</p>
        )}
        {result.data?.map((item) => (
          <div key={item.id} className="border-t py-4">
            <ProfileFacts
              items={[
                [
                  "Evento",
                  `${item.id} · ${item.kind} · ${stamp(item.received_at)}`,
                ],
                [
                  "Sessão",
                  `${item.username || "Sem usuário"} · ${item.session_id || "Sem sessão"}`,
                ],
                [
                  "Origem",
                  `${item.source_ip} · ${item.nas_device_id ? "NAS identificado" : "Sem identidade comprovada"}`,
                ],
                [
                  "Motivo",
                  reasons[item.reason ?? ""] ?? item.reason ?? "A conferir",
                ],
                [
                  "Entregas / revisões",
                  `${item.deliveries} / ${item.reprocesses}`,
                ],
                ...(item.review_reason
                  ? [
                      ["Última justificativa", item.review_reason] as [
                        string,
                        string,
                      ],
                    ]
                  : []),
              ]}
            />
            {can(me, "network:write") && (
              <Button
                variant="outline"
                disabled={!item.nas_device_id}
                onClick={() => {
                  setAction("reconcile");
                  setReview(item);
                }}
              >
                Conciliar evento {item.id}
              </Button>
            )}
            {can(me, "network:write") && (
              <Button
                variant="ghost"
                onClick={() => {
                  setAction("dismiss");
                  setReview(item);
                }}
              >
                Arquivar evento {item.id}
              </Button>
            )}
          </div>
        ))}
      </QueryBoundary>
      {result.data?.length === 100 && (
        <Button
          variant="outline"
          onClick={() => setBefore(result.data![result.data!.length - 1].id)}
        >
          Eventos mais antigos
        </Button>
      )}
      {before && (
        <Button variant="outline" onClick={() => setBefore(null)}>
          Voltar aos recentes
        </Button>
      )}
      {review && (
        <RecordEditor
          title={`${action === "dismiss" ? "Arquivar" : "Conciliar"} evento ${review.id}`}
          description={
            action === "dismiss"
              ? "Arquiva o evento com justificativa. Não encerra sessões, não altera autorização e não resolve operações de rede incertas."
              : "Os dados originais e a identidade do NAS serão preservados. A revisão pode manter o evento em quarentena se faltar evidência."
          }
          initial={{ reason: "" }}
          fields={[
            {
              key: "reason",
              label: "Justificativa",
              type: "textarea",
              required: true,
              maxLength: 500,
              hint: "De 10 a 500 caracteres. Informe a evidência que motivou a revisão.",
            },
          ]}
          submit={
            action === "dismiss"
              ? "Arquivar sem alterar sessões"
              : "Reprocessar dados originais"
          }
          onClose={() => setReview(null)}
          onSubmit={async (values) => {
            if (values.reason.trim().length < 10)
              throw new Error(
                "Informe uma justificativa de pelo menos 10 caracteres",
              );
            const response = z
              .object({ result: z.string(), sends_to_nas: z.literal(false) })
              .parse(
                await api(`/radius/accounting/events/${review.id}/${action}`, {
                  method: "POST",
                  body: { reason: values.reason },
                }),
              );
            toast.success(
              response.result === "ignored"
                ? "Evento arquivado sem alterar sessões"
                : response.result === "applied"
                  ? "Evento conciliado"
                  : response.result === "already_processed"
                    ? "Evento já processado"
                    : "Evento continua em quarentena; confira a evidência disponível",
            );
            setReview(null);
            await Promise.all([result.mutate(), mutate("erp-radius-status")]);
          }}
        />
      )}
    </ProfileSection>
  );
}

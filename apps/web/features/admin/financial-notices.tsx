import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ProfileFacts } from "@/components/subscriber-profile-sections";
import { QueryBoundary } from "@/features/shared/feedback";
import { RecordEditor } from "@/features/shared/record-editor";
import { FormField } from "@/features/shared/form";
import { api } from "@/platform/erp-client";
const noticeSchema = z.object({
  id: z.string(),
  status: z.string(),
  charge_id: z.string(),
  payment_id: z.string(),
  created_at: z.string(),
  processed_at: z.string().nullable(),
  acknowledged: z.boolean(),
  review_reason: z.string().nullable(),
  reviewed_at: z.string().nullable(),
});
type Notice = z.infer<typeof noticeSchema>;
const states: Record<string, string> = {
  review: "Revisão necessária",
  unmatched: "Aguardando identificação/consulta",
  pending: "Consulta de recebimento pendente",
  processed: "Aviso processado",
};
export function FinancialNotices({
  connection,
  onClose,
}: {
  connection: { id: string; name: string };
  onClose: () => void;
}) {
  const { mutate } = useSWRConfig();
  const [view, setView] = useState("open");
  const [before, setBefore] = useState<string | null>(null);
  const [decision, setDecision] = useState<{
    notice: Notice;
    action: "ack" | "retry";
    intent: string;
  } | null>(null);
  const query = useSWR(
    ["financial-notices", connection.id, view, before],
    async () => {
      const params = new URLSearchParams({ view });
      if (before) params.set("before", before);
      return z
        .array(noticeSchema)
        .parse(
          await api(
            `/financial-connections/${connection.id}/notices?${params}`,
          ),
        );
    },
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="erp-editor">
        <DialogHeader>
          <DialogTitle>Triagem de notificações · {connection.name}</DialogTitle>
          <DialogDescription>
            Conferência administrativa não reconhece dinheiro, não libera
            reservas e não autoriza reemissão. Recebimentos dependem de consulta
            autenticada da cobrança.
          </DialogDescription>
        </DialogHeader>
        <div className="erp-stack">
          <FormField label="Visualização">
            <select
              className="commercial-select"
              value={view}
              onChange={(e) => {
                setView(e.target.value);
                setBefore(null);
              }}
            >
              <option value="open">A conferir</option>
              <option value="acknowledged">
                Conferidos administrativamente
              </option>
              <option value="processed">
                Processados pelo fluxo de consulta
              </option>
            </select>
          </FormField>
          <Button variant="outline" onClick={() => void query.mutate()}>
            Atualizar triagem
          </Button>
          <QueryBoundary
            loading={query.isLoading}
            error={query.error}
            retry={() => query.mutate()}
          >
            {query.data?.length === 0 && (
              <p>Nenhuma notificação nesta visualização.</p>
            )}
            {query.data?.map((notice) => (
              <section key={notice.id} className="border-t py-4">
                <ProfileFacts
                  items={[
                    ["Aviso", notice.id],
                    ["Cobrança", notice.charge_id],
                    ["Identificador recebido", notice.payment_id],
                    ["Situação", states[notice.status] ?? notice.status],
                    [
                      "Recebido em",
                      new Date(notice.created_at).toLocaleString("pt-BR"),
                    ],
                    [
                      "Conferência",
                      notice.acknowledged
                        ? "Conferência administrativa registrada"
                        : "A conferir nesta etapa",
                    ],
                    ...(notice.review_reason
                      ? [
                          ["Última justificativa", notice.review_reason] as [
                            string,
                            string,
                          ],
                        ]
                      : []),
                  ]}
                />
                {(notice.status === "review" ||
                  notice.status === "unmatched") && (
                  <div className="erp-inline-actions">
                    {!notice.acknowledged && (
                      <Button
                        variant="outline"
                        onClick={() =>
                          setDecision({
                            notice,
                            action: "ack",
                            intent: crypto.randomUUID(),
                          })
                        }
                      >
                        Marcar conferido {notice.id.slice(0, 8)}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      onClick={() =>
                        setDecision({
                          notice,
                          action: "retry",
                          intent: crypto.randomUUID(),
                        })
                      }
                    >
                      Solicitar nova consulta {notice.id.slice(0, 8)}
                    </Button>
                  </div>
                )}
              </section>
            ))}
          </QueryBoundary>
          {query.data?.length === 100 && (
            <Button
              variant="outline"
              onClick={() => setBefore(query.data![query.data!.length - 1].id)}
            >
              Avisos mais antigos
            </Button>
          )}
          {before && (
            <Button variant="ghost" onClick={() => setBefore(null)}>
              Voltar aos recentes
            </Button>
          )}
        </div>
        {decision && (
          <RecordEditor
            title={
              decision.action === "ack"
                ? "Registrar conferência do aviso"
                : "Solicitar nova consulta do aviso"
            }
            description={
              decision.action === "ack"
                ? "A conferência apenas organiza a fila administrativa. O aviso original, o bloqueio de emissão e as reservas continuam preservados."
                : "Reagenda a consulta usando os dados originais. Não cria cobrança, não devolve dinheiro e não confirma pagamento pelo conteúdo do aviso."
            }
            initial={{ reason: "" }}
            fields={[
              {
                key: "reason",
                label: "Justificativa",
                type: "textarea",
                required: true,
                maxLength: 500,
                hint: "De 10 a 500 caracteres.",
              },
            ]}
            submit={
              decision.action === "ack"
                ? "Registrar conferência"
                : "Reagendar consulta"
            }
            onClose={() => setDecision(null)}
            onSubmit={async (values) => {
              if (values.reason.trim().length < 10)
                throw new Error(
                  "Informe uma justificativa de pelo menos 10 caracteres",
                );
              const response = z
                .object({
                  result: z.string(),
                  funds_changed: z.literal(false),
                  provider_called: z.literal(false),
                })
                .parse(
                  await api(
                    `/financial-connections/${connection.id}/notices/${decision.notice.id}/review`,
                    {
                      body: {
                        action: decision.action,
                        intent_id: decision.intent,
                        reason: values.reason,
                      },
                    },
                  ),
                );
              toast.success(
                response.result === "acknowledged"
                  ? "Conferência registrada sem efeito financeiro"
                  : "Consulta reagendada; aguarde o processamento",
              );
              setDecision(null);
              await mutate(
                (key) =>
                  Array.isArray(key) &&
                  ["financial-notices", "financial-callback"].includes(
                    String(key[0]),
                  ) &&
                  key[1] === connection.id,
                undefined,
                { revalidate: true },
              );
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

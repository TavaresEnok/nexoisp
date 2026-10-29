import useSWR from "swr";
import { AlertCircle } from "lucide-react";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ProfileFacts,
  ProfileSection,
} from "@/components/subscriber-profile-sections";
import { ApiError } from "@/data/erp/http";
import { QueryBoundary } from "@/features/shared/feedback";
import { api } from "@/platform/erp-client";

const MAX_NOTICE_LOG_ID = 9223372036854775807n;

const logStatusLabels: Record<string, string> = {
  queued: "Na fila",
  sending: "Em envio",
  sent: "Registrado como enviado ao serviço",
  failed: "Falhou",
  uncertain: "Resultado desconhecido",
  skipped_no_consent: "Sem consentimento",
  skipped_settled: "Não encaminhado",
  test: "Teste",
};

const attemptStateLabels: Record<string, string> = {
  reserved: "Reservada",
  wire: "Transmissão iniciada",
  submitted: "Submetida ao serviço",
  refused: "Recusada pelo serviço",
  uncertain: "Resultado desconhecido",
  not_sent: "Não enviada",
};

const timestamp = z.iso.datetime({ offset: true });

function canonicalNoticeLogID(value: string): boolean {
  if (!/^[1-9]\d{0,18}$/.test(value)) return false;
  try {
    return BigInt(value) <= MAX_NOTICE_LOG_ID;
  } catch {
    return false;
  }
}

const cloudJournalSchema = z
  .object({
    notice_log_id: z.string().refine(canonicalNoticeLogID),
    log_status: z.string().regex(/^[a-z0-9_]{1,64}$/),
    cloud_lock_timeouts: z.number().int().min(0).max(3),
    attempts: z
      .array(
        z
          .object({
            attempt_no: z
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER),
            state: z.enum([
              "reserved",
              "wire",
              "submitted",
              "refused",
              "uncertain",
              "not_sent",
            ]),
            created_at: timestamp,
            wire_at: timestamp.nullable(),
            http_status: z.number().int().min(100).max(599).nullable(),
          })
          .strict(),
      )
      .max(100),
    statuses: z
      .array(
        z
          .object({
            attempt_no: z
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER),
            raw_status: z.string().min(1).max(300),
            created_at: timestamp,
          })
          .strict(),
      )
      .max(100),
    attempts_truncated: z.boolean(),
    statuses_truncated: z.boolean(),
  })
  .strict();

type CloudJournal = z.infer<typeof cloudJournalSchema>;

async function loadCloudJournal(id: string): Promise<CloudJournal> {
  let payload: unknown;
  try {
    payload = await api<unknown>(`/notice-log/${id}/cloud-journal`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      throw new Error("Consulta não autorizada (403).");
    }
    if (error instanceof ApiError && error.status === 404) {
      throw new Error("Aviso não encontrado (404).");
    }
    throw error;
  }
  const parsed = cloudJournalSchema.safeParse(payload);
  if (!parsed.success || parsed.data.notice_log_id !== id) {
    throw new Error("A resposta do acompanhamento é inválida.");
  }
  return parsed.data;
}

function formatWhen(value: string | null): string {
  if (value === null || value === "") return "Não registrado";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Data indisponível";
  return parsed.toLocaleString("pt-BR");
}

function logStatusLabel(status: string): string {
  return logStatusLabels[status] ?? status;
}

function attemptStateLabel(state: string): string {
  return attemptStateLabels[state] ?? state;
}

function truncationCopy(
  kind: "tentativas" | "status",
  truncated: boolean,
): string {
  if (kind === "tentativas") {
    return truncated
      ? "Tentativas: a lista mostra no máximo cem, e há registros mais antigos."
      : "Tentativas: a lista está completa dentro do limite de cem.";
  }
  return truncated
    ? "Status recebidos: a lista mostra no máximo cem, e há registros mais antigos."
    : "Status recebidos: a lista está completa dentro do limite de cem.";
}

function JournalView({ journal }: { journal: CloudJournal }) {
  return (
    <>
      <ProfileFacts
        items={[
          [
            "Identificador",
            <span className="mono" key="id">
              {journal.notice_log_id}
            </span>,
          ],
          ["Situação do aviso", logStatusLabel(journal.log_status)],
          ["Paradas por tempo limite", String(journal.cloud_lock_timeouts)],
        ]}
      />
      <p className="profile-footnote">
        Estes dados não confirmam entrega ao destinatário, leitura nem baixa.
      </p>
      <ProfileSection
        title="Tentativas"
        caption="Cada linha é uma tentativa registrada. O código HTTP não indica entrega."
      >
        <p>{truncationCopy("tentativas", journal.attempts_truncated)}</p>
        {journal.attempts.length === 0 ? (
          <p>Nenhuma tentativa registrada para este aviso.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tentativa</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead>Registrada em</TableHead>
                <TableHead>Transmissão</TableHead>
                <TableHead>Código HTTP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {journal.attempts.map((attempt, index) => (
                <TableRow
                  key={`${attempt.attempt_no}-${attempt.created_at}-${index}`}
                >
                  <TableCell className="mono">{attempt.attempt_no}</TableCell>
                  <TableCell>{attemptStateLabel(attempt.state)}</TableCell>
                  <TableCell>{formatWhen(attempt.created_at)}</TableCell>
                  <TableCell>{formatWhen(attempt.wire_at)}</TableCell>
                  <TableCell>
                    {attempt.http_status === null
                      ? "Não registrado"
                      : String(attempt.http_status)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ProfileSection>
      <ProfileSection
        title="Status recebidos"
        caption="O texto é exibido como chegou, sem interpretação de entrega ou leitura."
      >
        <p>{truncationCopy("status", journal.statuses_truncated)}</p>
        {journal.statuses.length === 0 ? (
          <p>Nenhum status recebido para este aviso.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tentativa</TableHead>
                <TableHead>Texto recebido</TableHead>
                <TableHead>Recebido em</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {journal.statuses.map((status, index) => (
                <TableRow
                  key={`${status.attempt_no}-${status.created_at}-${index}`}
                >
                  <TableCell className="mono">{status.attempt_no}</TableCell>
                  <TableCell className="whitespace-normal break-all">
                    {status.raw_status}
                  </TableCell>
                  <TableCell>{formatWhen(status.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ProfileSection>
    </>
  );
}

function JournalRequest({ noticeLogID }: { noticeLogID: string }) {
  const noticeID = canonicalNoticeLogID(noticeLogID) ? noticeLogID : null;
  const result = useSWR(
    noticeID === null
      ? null
      : (["erp-notice-cloud-journal", noticeID] as const),
    ([, id]) => loadCloudJournal(id),
    {
      refreshInterval: 0,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    },
  );
  if (noticeID === null) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Identificador inválido</AlertTitle>
        <AlertDescription>
          <p>
            O aviso selecionado não tem um identificador válido para consulta.
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <QueryBoundary
      loading={result.isLoading}
      error={result.error}
      retry={() => result.mutate()}
    >
      {result.data ? <JournalView journal={result.data} /> : null}
    </QueryBoundary>
  );
}

export function CloudNoticeJournal({
  noticeLogID,
  onClose,
}: {
  noticeLogID: string | null;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={noticeLogID !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="ticket-sheet overflow-y-auto">
        <SheetHeader>
          <p className="eyebrow">AVISOS</p>
          <SheetTitle>Acompanhamento do aviso</SheetTitle>
          <SheetDescription>
            Consulta somente leitura das tentativas e dos status recebidos. Não
            envia mensagem nem altera conta.
          </SheetDescription>
        </SheetHeader>
        <div className="sheet-content-body erp-stack">
          {noticeLogID !== null && <JournalRequest noticeLogID={noticeLogID} />}
          <Button variant="outline" onClick={onClose}>
            Fechar
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

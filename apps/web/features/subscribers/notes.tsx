import useSWR from "swr";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { QueryBoundary } from "@/features/shared/feedback";
import { api } from "@/platform/erp-client";

export type SubscriberNote = {
  id: string;
  body: string;
  alert: boolean;
  type_name?: string;
  created_at: string;
  created_by_name?: string;
};

export function useSubscriberNotes(id: string) {
  return useSWR(["erp-notes", id], ([, subscriberId]) =>
    api<SubscriberNote[]>(`/subscribers/${subscriberId}/notes`),
  );
}

export function SubscriberAlerts({ id }: { id: string }) {
  const notes = useSubscriberNotes(id);
  if (!notes.error && !notes.data?.some((note) => note.alert)) return null;
  return (
    <QueryBoundary error={notes.error} retry={() => notes.mutate()}>
      <div
        className="sheet-content-body erp-stack"
        aria-label="Alertas do assinante"
      >
        {notes.data
          ?.filter((note) => note.alert)
          .map((note) => (
            <Alert key={note.id} role="alert">
              <AlertTitle>Atenção ao atendimento</AlertTitle>
              <AlertDescription>{note.body}</AlertDescription>
            </Alert>
          ))}
      </div>
    </QueryBoundary>
  );
}

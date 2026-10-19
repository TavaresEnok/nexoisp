import { toast } from "sonner";

/** O ACS distingue mudança aplicada agora de mudança enfileirada; o aviso preserva essa diferença. */
export function notifyAcs(response: { note?: string; result?: string }) {
  const note = response.note ?? "Solicitação registrada.";
  if (!response.result || response.result === "applied") toast.success(note);
  else toast.info(note);
}

import { Children, cloneElement, isValidElement, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
export function FormField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId();
  let linked = false;
  const connect = (nodes: ReactNode): ReactNode => Children.map(nodes, node => {
    if (linked || !isValidElement<{ children?: ReactNode }>(node)) return node;
    if ([Input, Textarea, "input", "select", "textarea"].includes(node.type as typeof Input)) {
      linked = true;
      return cloneElement(node as React.ReactElement<Record<string, unknown>>, { id, "aria-labelledby": `${id}-label`, ...(hint ? { "aria-describedby": `${id}-hint` } : {}) });
    }
    return node.props.children ? cloneElement(node, {}, connect(node.props.children)) : node;
  });
  return <div className="erp-field"><Label id={`${id}-label`} htmlFor={id}>{label}</Label>{connect(children)}{hint && <small id={`${id}-hint`} className="text-muted-foreground">{hint}</small>}</div>;
}
export function MutationForm({ children, onSubmit, onCancel, submit = "Salvar" }: { children: ReactNode; onSubmit: () => Promise<void>; onCancel?: () => void; submit?: string }) {
  const [busy, setBusy] = useState(false); const inFlight = useRef(false); const [error, setError] = useState<string | null>(null);
  const handle = async (event: FormEvent) => {
    event.preventDefault(); if (inFlight.current) return; inFlight.current = true; setBusy(true); setError(null);
    try { await onSubmit(); } catch (error) { setError(error instanceof Error ? error.message : "Não foi possível salvar."); } finally { inFlight.current = false; setBusy(false); }
  };
  return <form className="erp-form" onSubmit={handle}><fieldset disabled={busy}>{children}</fieldset>{error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}<footer>{onCancel && <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancelar</Button>}<Button type="submit" disabled={busy}>{busy ? "Salvando…" : submit}</Button></footer></form>;
}

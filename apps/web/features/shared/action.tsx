import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
export function ActionButton({ children, onClick, confirm, danger = false, disabled = false }: { children: ReactNode; onClick: () => Promise<unknown>; confirm?: string; danger?: boolean; disabled?: boolean }) {
 const [busy, setBusy] = useState(false); const locked = useRef(false); const [open, setOpen] = useState(false);
 const run = async () => { if (locked.current) return; locked.current = true; setBusy(true); try { await onClick(); setOpen(false); } catch (error) { toast.error((error as Error).message); } finally { locked.current = false; setBusy(false); } };
 return <><Button variant={danger ? "destructive" : "outline"} size="sm" disabled={disabled || busy} onClick={() => confirm ? setOpen(true) : void run()}>{busy ? "Processando…" : children}</Button>{confirm && <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent><DialogHeader><DialogTitle>Confirme a ação</DialogTitle><DialogDescription>{confirm}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancelar</Button><Button variant={danger ? "destructive" : "default"} disabled={busy} onClick={() => void run()}>Confirmar</Button></DialogFooter></DialogContent></Dialog>}</>;
}

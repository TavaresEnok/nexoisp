"use client";

import type { ReactNode } from "react";
import { Copy, Download, Info } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import styles from "@/components/technical.module.css";
import { copyText, downloadContent } from "@/platform/browser";

export const downloadText = downloadContent;
export function CodePreview({ title, code, filename }: { title: string; code: string; filename?: string }) {
  return <section className={styles.codePanel} aria-label={title}><div className={styles.codeHeading}><span>{title}</span><div><Button size="icon-sm" variant="ghost" disabled={!code} aria-label={`Copiar ${title.toLowerCase()}`} onClick={async () => { try { await copyText(code); toast.success("Conteúdo copiado."); } catch { toast.error("Não foi possível copiar. Selecione o texto ou baixe o arquivo."); } }}><Copy /></Button>{filename && <Button size="icon-sm" variant="ghost" disabled={!code} aria-label={`Baixar ${title.toLowerCase()}`} onClick={() => downloadText(filename, code)}><Download /></Button>}</div></div><pre tabIndex={0}><code>{code || "Nenhum comando definido."}</code></pre></section>;
}
export function TechnicalNotice({ children, title = "Referência técnica · ambiente demonstrativo" }: { children: ReactNode; title?: string }) {
  return <Alert><Info /><AlertTitle>{title}</AlertTitle><AlertDescription>{children}</AlertDescription></Alert>;
}
export function TechnicalDetails({ title, description, fields, children, onClose }: { title: string; description: string; fields: [string, ReactNode][]; children?: ReactNode; onClose: () => void }) {
  return <Sheet open onOpenChange={open => !open && onClose()}><SheetContent className="ticket-sheet overflow-y-auto"><SheetHeader><p className="eyebrow">FICHA TÉCNICA</p><SheetTitle>{title}</SheetTitle><SheetDescription>{description}</SheetDescription></SheetHeader><div className={styles.details}><dl className={styles.definitionGrid}>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? "Não informado"}</dd></div>)}</dl>{children}</div></SheetContent></Sheet>;
}

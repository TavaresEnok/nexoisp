"use client";

import { useTransition, type ReactNode } from "react";
import { useRouter } from "@/platform/navigation/react";
import Link from "@/platform/navigation/link";
import {
  ArrowUpRight,
  ArrowDownRight,
  ArrowRight,
  Info,
  RefreshCw,
  X,
} from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardAction,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { clock, initials } from "@/lib/format";
import { useWorkspace } from "@/components/workspace-provider";
import { toast } from "sonner";
import { isDemoMode } from "@/application/execution-mode";

export function Panel({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <Card className={cn("nexo-panel", className)}>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </header>
  );
}
export function Status({
  value,
  dot = true,
}: {
  value: string;
  dot?: boolean;
}) {
  const success = [
    "Ativo",
    "Online",
    "Paga",
    "Concluída",
    "Resolvido",
    "Operacional",
    "No prazo",
    "Vigente",
    "Conectado",
  ].includes(value);
  const danger = [
    "Suspenso",
    "Vencida",
    "Offline",
    "Alta",
    "Em risco",
    "Atrasada",
    "Bloqueado",
  ].includes(value);
  const warning = [
    "Atenção",
    "Aguardando",
    "Em conciliação",
    "Em instalação",
    "Média",
  ].includes(value);
  const info = ["Aberto", "Aberta", "Agendada", "Em andamento", "Em atendimento", "Em execução"].includes(value);
  return (
    <Badge
      variant={success ? "success" : danger ? "destructive" : warning ? "warning" : info ? "info" : "secondary"}
      className="status"
    >
      {dot && <span className="status-dot" aria-hidden="true" />}
      {value}
    </Badge>
  );
}
export function ActiveFilters({ filters, count, onClear }: { filters: { label: string; onRemove: () => void }[]; count: number; onClear: () => void }) {
  if (!filters.length) return null;
  return <div className="active-filters" role="region" aria-label="Filtros aplicados">
    {filters.map(filter => <Badge key={filter.label} variant="outline"><span>{filter.label}</span><Button variant="ghost" size="icon-xs" aria-label={`Remover filtro: ${filter.label}`} onClick={filter.onRemove}><X /></Button></Badge>)}
    <Button variant="ghost" size="sm" onClick={onClear}>Limpar filtros</Button>
    <span className="filter-result-count" role="status">{count} resultado(s)</span>
  </div>;
}
export function PersonAvatar({
  name,
  small = false,
}: {
  name: string;
  small?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "person-avatar",
        small && "person-avatar-small",
        `avatar-tone-${name.length % 4}`,
      )}
    >
      {initials(name)}
    </span>
  );
}
export function Trend({
  children,
  down = false,
  neutral = false,
}: {
  children: ReactNode;
  down?: boolean;
  neutral?: boolean;
}) {
  return (
    <span className={cn("trend", neutral && "trend-neutral")}>
  {!neutral && (down ? <ArrowDownRight /> : <ArrowUpRight />)}
  {children}
    </span>
  );
}
export function TextLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link className="text-link" href={href}>
      {children}
      <ArrowRight size={14} />
    </Link>
  );
}
export function SourceFooter({ sample, asOf }: { sample?: string; asOf?: string }) {
  return asOf ? <CatalogSourceFooter sample={sample} asOf={asOf} /> : <WorkspaceSourceFooter sample={sample} />;
}
function WorkspaceSourceFooter({ sample }: { sample?: string }) {
  const { refresh, data, error, isValidating } = useWorkspace();
  return <DataSourceFooter sample={sample} asOf={data.snapshot.asOf} failed={Boolean(error)} pending={isValidating} onRefresh={() => { toast.promise(refresh(), { loading: isDemoMode ? "Relendo cenário local…" : "Consultando o Neon…", success: isDemoMode ? "Cenário local relido. Nenhum dado remoto foi consultado." : "Consulta atualizada. O cenário demonstrativo tem data fixa.", error: "Não foi possível atualizar os dados." }); }} />;
}
function CatalogSourceFooter({ sample, asOf }: { sample?: string; asOf: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <DataSourceFooter sample={sample} asOf={asOf} pending={pending} onRefresh={() => startTransition(() => router.refresh())} />;
}
function DataSourceFooter({ sample, asOf, pending, failed = false, onRefresh }: { sample?: string; asOf: string; pending: boolean; failed?: boolean; onRefresh: () => void }) {
  const readAt = `${new Date(asOf).toLocaleDateString("pt-BR", { day: "numeric", month: "short", timeZone: "America/Sao_Paulo" })}, ${clock(asOf)}`;
  return <footer className="source-footer"><span>{!failed && !pending && <span className="live-dot" />}{failed ? "Falha na atualização · última consulta disponível" : pending ? (isDemoMode ? "Relendo cenário local…" : "Consultando Neon…") : (isDemoMode ? "Modo demonstrativo local · somente leitura" : "Consulta validada do Neon")}<span className="footer-divider">/</span>{sample || "Cenário demonstrativo"}<span className="footer-divider">/</span>Leitura de {readAt}</span><Button size="xs" variant="ghost" disabled={pending} onClick={onRefresh}><RefreshCw data-icon="inline-start" />Atualizar consulta</Button></footer>;
}
export function DemoNotice({ children }: { children?: ReactNode }) {
  return (
    <p className="demo-notice">
      <Info size={14} />
      {children ||
        "Ambiente de avaliação. Todos os nomes, valores e eventos são fictícios."}
    </p>
  );
}

"use client";

import Link from "@/platform/navigation/link";
import { Cable, FileCode2, HardDrive, Info, Server, Workflow } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const destinations = [
  { href: "/rede/ftth/fttx-olt", label: "FTTx - OLT", icon: Server, mode: "olt" },
  { href: "/rede/ftth/fttx-pon", label: "FTTx - PON", icon: Workflow, mode: "pon" },
  { href: "/rede/ftth/fttx-cto", label: "FTTx - CTO", icon: Cable, mode: "cto" },
  { href: "/rede/ftth/fttx-onu-tipo", label: "ONU · Modelos", icon: HardDrive, mode: "onu-type" },
  { href: "/rede/ftth/fttx-onu-template", label: "ONU · Templates", icon: FileCode2, mode: "onu-template" },
];

export function OpticalNavigation({ mode }: { mode: string }) {
  return <nav aria-label="Consultas de rede óptica" className="flex flex-wrap gap-2">{destinations.map(({ href, label, icon: Icon, mode: item }) => <Link key={href} href={href} aria-current={mode === item ? "page" : undefined} className={cn(buttonVariants({ variant: mode === item ? "secondary" : "ghost", size: "sm" }))}><Icon data-icon="inline-start" />{label}</Link>)}</nav>;
}

export function OpticalNotice({ children }: { children: React.ReactNode }) {
  return <Alert><Info /><AlertTitle>Consulta demonstrativa · somente leitura</AlertTitle><AlertDescription>{children}</AlertDescription></Alert>;
}

export function OpticalEmpty({ title, description }: { title: string; description: string }) {
  return <Empty><EmptyHeader><EmptyMedia variant="icon"><Cable /></EmptyMedia><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader></Empty>;
}

export function OpticalMetrics({ items }: { items: { label: string; value: string | number; detail: string; icon: typeof Cable }[] }) {
  return <div className="metrics-grid">{items.map(({ label, value, detail, icon: Icon }) => <div className="metric-card" key={label}><div className="metric-heading"><span>{label}</span><Icon size={17} /></div><div className="metric-main"><strong>{value}</strong></div><p>{detail}</p></div>)}</div>;
}

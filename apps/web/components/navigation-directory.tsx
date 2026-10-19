"use client";

import { useMemo, useState } from "react";
import Link from "@/platform/navigation/link";
import { ArrowUpRight, ChevronRight, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { PageHeading } from "@/components/workspace-ui";
import { navigationAreas, navigationModules, navigationCount, searchNavigation, type NavigationNode } from "@/lib/navigation";

function ScopeTree({ nodes, matches, searching }: { nodes: NavigationNode[]; matches: Set<string>; searching: boolean }) {
  return <ul className="directory-tree">{nodes.filter(node => matches.has(node.href)).map(node => <li key={node.href}>{node.children.length > 0 ? <details key={`${node.href}-${searching}`} open={searching || undefined}><summary><ChevronRight size={13} /><span>{node.label}</span></summary><Link className="directory-open-link" href={node.href} prefetch={false}>Abrir recurso<ArrowUpRight size={12} /></Link><ScopeTree nodes={node.children} matches={matches} searching={searching} /></details> : <Link className="directory-leaf" href={node.href} prefetch={false}>{node.label}<ArrowUpRight size={12} /></Link>}</li>)}</ul>;
}

export function NavigationDirectory({ initialQuery = "" }: { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const matches = useMemo(() => new Set(searchNavigation(query).map(page => page.href)), [query]);
  const sections = [
    { id: "inicio", label: "Início", description: "Panorama e busca unificada", pages: navigationModules.filter(page => page.area === "INÍCIO") },
    ...navigationAreas,
  ];
  function hasMatch(node: NavigationNode): boolean {
    return matches.has(node.href) || node.children.some(hasMatch);
  }
  const visible = new Set<string>();
  function visit(node: NavigationNode) {
    if (hasMatch(node)) visible.add(node.href);
    node.children.forEach(visit);
  }
  navigationModules.forEach(visit);
  return <div className="flex flex-col gap-6">
    <PageHeading eyebrow="TODA A OPERAÇÃO, NO SEU LUGAR" title="Mapa de páginas" description={`${navigationModules.length} módulos e ${navigationCount} entradas de navegação, incluindo todos os níveis da estrutura solicitada.`} />
    <Alert><Info /><AlertTitle>Navegação completa não significa implementação completa</AlertTitle><AlertDescription>Os marcadores identificam consultas parciais e recursos pendentes. A criação de um menu não comprova uma ação funcional. Operação do SaaS, portal e autenticação aparecem como escopos previstos, sem simular login ou permissões.</AlertDescription></Alert>
    <div className="directory-search"><label htmlFor="navigation-filter">Encontrar menu ou submenu</label><Input id="navigation-filter" type="search" placeholder="Busque por ONU, contrato, Wi-Fi, auditoria…" value={query} onChange={event => setQuery(event.target.value)} /><p role="status">{query.trim() ? `${matches.size} resultados encontrados` : `${navigationCount} entradas organizadas por área`}</p></div>
    <div className="directory-grid">{sections.filter(section => section.pages.some(hasMatch)).map(section => <Card key={section.id}><CardHeader><CardTitle><h2>{section.label}</h2></CardTitle><CardDescription>{section.description}</CardDescription></CardHeader><CardContent><div className="directory-modules">{section.pages.filter(hasMatch).map(page => <section key={page.href} className="directory-module"><div className="directory-module-heading"><Link href={page.href} prefetch={false}><h3>{page.label}</h3><ArrowUpRight size={14} /></Link><Badge variant={page.view ? "secondary" : "outline"}>{page.view ? "Consulta parcial" : "Pendente"}</Badge></div><ScopeTree nodes={page.children} matches={visible} searching={Boolean(query.trim())} /></section>)}</div></CardContent></Card>)}</div>
    {matches.size === 0 && <p className="directory-empty">Nenhum menu encontrado. Tente outro nome ou remova os filtros.</p>}
  </div>;
}

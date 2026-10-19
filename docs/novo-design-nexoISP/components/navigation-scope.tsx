import Link from "@/platform/navigation/link";
import { ArrowLeft, ArrowRight, ChevronRight, Construction, ListTree } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { findNavigationPage, type NavigationNode } from "@/lib/navigation";
import { PageHeading } from "@/components/workspace-ui";

function ChildLinks({ nodes }: { nodes: NavigationNode[] }) {
  return <ul className="scope-child-links">{nodes.map(child => <li key={child.href}><Link href={child.href} prefetch={false}><span><strong>{child.label}</strong><small>{child.children.length ? `${child.children.length} submenus` : child.view ? "Consulta parcial disponível" : "Implementação pendente"}</small></span><ChevronRight size={16} /></Link></li>)}</ul>;
}

export function NavigationScope({ node }: { node: NavigationNode }) {
  const parent = node.parentHref ? findNavigationPage(node.parentHref) : undefined;
  const module = findNavigationPage(node.moduleHref);
  if (node.view) return <details className="module-navigation"><summary><ListTree size={15} /><span>Escopo e limites desta consulta</span><Badge variant="outline">Consulta parcial</Badge><ChevronRight size={14} /></summary><div><p>Esta consulta não implementa todas as ações previstas. Explore os submenus para conferir o escopo de cada recurso.</p><ChildLinks nodes={node.children} /></div></details>;
  return <div className="flex flex-col gap-6">
    <nav aria-label="Caminho da página" className="scope-breadcrumb"><Link href="/estrutura">Mapa de páginas</Link>{module && module.href !== node.href && <><ChevronRight size={12} /><Link href={module.href}>{module.label}</Link></>}{parent && parent.href !== module?.href && <><ChevronRight size={12} /><Link href={parent.href}>{parent.label}</Link></>}</nav>
    <PageHeading eyebrow={node.area} title={node.label} description={`Escopo previsto para ${node.audience.toLowerCase()}. Este acesso organiza a navegação e não representa uma funcionalidade concluída.`} />
    <Alert><Construction /><AlertTitle>Implementação funcional pendente</AlertTitle><AlertDescription>Este recurso ainda não está disponível. Nenhum dado é alterado e nenhuma operação é enviada a equipamentos, gateways ou serviços externos. {node.audience !== "Equipe" && "Esta é uma prévia da estrutura, não uma sessão autenticada nem um acesso real ao portal."}</AlertDescription></Alert>
    {node.children.length > 0 && <Card><CardHeader><CardTitle>O que faz parte deste recurso</CardTitle><CardDescription>{node.children.length} submenus previstos na estrutura solicitada.</CardDescription></CardHeader><CardContent><ChildLinks nodes={node.children} /></CardContent></Card>}
    <div className="scope-actions">{module?.view && module.href !== node.href && <Link href={module.href} className={buttonVariants({ variant: "outline" })}><ArrowLeft data-icon="inline-start" />Abrir consulta de {module.label.toLowerCase()}</Link>}<Link href="/acompanhamento" className={buttonVariants({ variant: "ghost" })}>Ver cobertura e evidências<ArrowRight data-icon="inline-end" /></Link></div>
  </div>;
}

import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "@/components/app-shell";
import { OperationalWorkspaceProvider } from "./workspace-provider";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { readAppearance } from "@/platform/appearance";
import { Login } from "@/features/session/login";
import { Account } from "@/features/session/account";
import { useSession } from "@/features/session/provider";
import { QueryBoundary } from "@/features/shared/feedback";
import { SubscriberDirectory } from "@/features/subscribers/directory";
import { OperationalSubscriberSheet } from "@/features/subscribers/sheet";
import { canAccessPath, erpAliases, canonicalErpPath } from "./navigation";
import { ErpOverview } from "./overview";
import { navigationAreas, findNavigationPage } from "@/lib/navigation";
export function OperationalApplication() {
 const session = useSession(); const location = useLocation();
 useEffect(() => {
  const path = canonicalErpPath(location.pathname);
  const title = ({ "/": "Painel inicial", "/login": "Entrar", "/assinantes": "Assinantes", "/conta": "Minha conta" } as Record<string, string>)[path] ?? findNavigationPage(path)?.label ?? "NexoISP";
  document.title = `${title} · NexoISP`;
  document.querySelector('meta[name="description"]')?.setAttribute("content", "Seu provedor, em sintonia. Ambiente operacional NexoISP.");
 }, [location.pathname]);
 if (session.loading || session.error) return <main className="erp-login"><QueryBoundary loading={session.loading} error={session.error} retry={() => session.reload()}>{null}</QueryBoundary></main>;
 if (!session.me) return <Routes><Route path="/login" element={<Login />} /><Route path="*" element={<Navigate to="/login" replace />} /></Routes>;
 const me = session.me; const canonical = canonicalErpPath(location.pathname);
 const home = me.mfa_pending ? "/conta" : me.role === "subscriber" ? "/portal" : !me.tenant ? "/provedores" : "/";
 const allowed = canAccessPath(me, canonical);
 return <OperationalWorkspaceProvider><AppShell initialAppearance={readAppearance()}>
 {location.pathname === "/login" ? <Navigate to={home} replace /> : me.mfa_pending && !location.pathname.startsWith("/conta") ? <Navigate to="/conta" replace /> : !allowed ? <AccessDenied /> : <Routes>
 <Route path="/" element={me.role === "subscriber" || !me.tenant ? <Navigate to={home} replace /> : <ErpOverview />} />
 <Route path="/conta/*" element={<Account />} /><Route path="/assinantes" element={<SubscriberDirectory />} />
 <Route path="/assinantes/:id" element={<SubscriberLegacyLink />} />
 {Object.entries(erpAliases).map(([from, to]) => <Route key={from} path={from} element={<Navigate to={`${to}${location.search}`} replace />} />)}
 <Route path="/estrutura" element={<OperationalDirectory />} />
 <Route path="*" element={<PendingIntegration pathname={canonical} />} />
 </Routes>}
 {allowed && me.tenant && me.role !== "subscriber" && !me.mfa_pending && <OperationalSubscriberSheet />}
 </AppShell></OperationalWorkspaceProvider>;
}
function SubscriberLegacyLink() { const location = useLocation(); const id = location.pathname.split("/").at(-1)!; const query = new URLSearchParams(location.search); query.set("ficha", id); return <Navigate to={`/assinantes?${query}`} replace />; }
function AccessDenied() { return <><PageHeading title="Acesso não disponível" description="Esta página não está liberada para sua conta ou para os módulos do provedor." /><Panel title="Verifique seu contexto de acesso"><p>Consulte o administrador do provedor para verificar suas permissões.</p><a href="/conta">Minha conta</a></Panel></>; }
function PendingIntegration({ pathname }: { pathname: string }) { const node = findNavigationPage(pathname); return <><PageHeading title={node?.label ?? (pathname === "/provedores" ? "Provedores" : pathname === "/portal" ? "Portal do assinante" : "Página em integração")} description="Este recurso ainda não está conectado nesta interface." /><Panel title="Integração em andamento" description="As funcionalidades existentes estão sendo adaptadas ao frontend oficial."><Badge variant="outline">Ainda não integrado</Badge><p className="profile-footnote">A demonstração visual usa um cenário fictício em um contexto separado.</p><Button variant="outline" onClick={() => window.location.assign(`/demonstracao${pathname}`)}>Abrir demonstração visual</Button></Panel></>; }
function OperationalDirectory() { const { me } = useSession(); return <><PageHeading title="Mapa de páginas" description="Destinos disponíveis para seu contexto de acesso." /><div className="erp-stack">{navigationAreas.map(area => ({ ...area, pages: area.pages.filter(page => canAccessPath(me, page.href)) })).filter(area => area.pages.length).map(area => <Panel key={area.id} title={area.label} description={area.description}><div className="erp-inline-actions">{area.pages.map(page => <a className="profile-text-action" key={page.href} href={page.href}>{page.label}</a>)}</div></Panel>)}</div></>; }

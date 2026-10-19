import { findNavigationPage, resolveNavigationPathname, type NavigationNode, type NavigationView } from "./navigation";

const specialRoutes = new Map<string, { entry: "directory" | "reports" | "settings" | "consolidation" | "assistant"; title: string }>([
  ["/estrutura", { entry: "directory", title: "Mapa de páginas" }],
  ["/busca", { entry: "directory", title: "Busca global" }],
  ["/relatorios", { entry: "reports", title: "Relatórios" }],
  ["/configuracoes", { entry: "settings", title: "Configurações" }],
  ["/acompanhamento", { entry: "consolidation", title: "Consolidação e evidências" }],
  ["/assistente", { entry: "assistant", title: "Assistente" }],
  ["/s", { entry: "assistant", title: "Assistente" }],
]);

type RouteMetadata = { pathname: string; title: string; description?: string };
export type NavigationRoute = RouteMetadata & (
  | { kind: "view"; node: NavigationNode; view: NavigationView }
  | { kind: "scope"; node: NavigationNode }
  | { kind: "special"; entry: "directory" | "reports" | "settings" | "consolidation"; node?: NavigationNode }
  | { kind: "special"; entry: "assistant"; requiresSession: true; sessionId?: string }
  | { kind: "not-found" }
);

export function resolveNavigationRoute(pathname: string): NavigationRoute {
  const canonical = resolveNavigationPathname(pathname);
  const node = findNavigationPage(canonical);
  const special = specialRoutes.get(canonical);
  const session = /^\/s\/([^/]+)$/.exec(canonical);
  if (special?.entry === "assistant" || session) {
    return { kind: "special", entry: "assistant", pathname: canonical, title: "Assistente", requiresSession: true, ...(session ? { sessionId: session[1] } : {}) };
  }
  if (special) {
    return { kind: "special", entry: special.entry, pathname: canonical, title: special.title, ...(node ? { node } : {}) };
  }
  if (!node) return { kind: "not-found", pathname: canonical, title: "Página não encontrada" };
  const metadata = {
    pathname: canonical,
    title: node.label,
    description: `${node.trail.join(" / ")} no NexoISP. ${node.view ? "Consulta parcial em ambiente demonstrativo." : "Escopo previsto, com implementação funcional pendente."}`,
  };
  return node.view ? { ...metadata, kind: "view", node, view: node.view } : { ...metadata, kind: "scope", node };
}

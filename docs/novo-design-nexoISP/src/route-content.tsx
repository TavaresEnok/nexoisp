import { useLayoutEffect, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { resolveNavigationRoute } from "@/lib/navigation-route";
import { NavigationViewContent } from "@/components/navigation-views";
import { Reports } from "@/components/management";
import { ConsolidationProgress } from "@/components/consolidation-progress";
import { NavigationScope } from "@/components/navigation-scope";
import { NavigationDirectory } from "@/components/navigation-directory";
import { WorkspaceDataBoundary } from "@/components/workspace-data-boundary";
import { DemoAssistant } from "@/components/demo-assistant";
import sources from "@/lib/consolidation/sources.json";
import NotFound from "./not-found";

export function RouteContent() {
  const { pathname, search } = useLocation();
  const route = resolveNavigationRoute(pathname);
  const query = new URLSearchParams(search);
  useLayoutEffect(() => {
    document.title = `${route.title} · NexoISP`;
    document.querySelector('meta[name="description"]')?.setAttribute("content", route.description ?? "Seu provedor, em sintonia. Ambiente demonstrativo NexoISP.");
  }, [route.title, route.description]);
  useLayoutEffect(() => { window.scrollTo(0, 0); }, [pathname]);

  let content: ReactNode;
  switch (route.kind) {
    case "view":
      content = <>{pathname !== "/" && <NavigationScope node={route.node} />}<NavigationViewContent view={route.view} /></>;
      break;
    case "scope":
      content = <NavigationScope node={route.node} />;
      break;
    case "special":
      switch (route.entry) {
        case "directory":
          content = <NavigationDirectory initialQuery={query.get("q") ?? ""} />;
          break;
        case "reports":
          content = <WorkspaceDataBoundary><Reports /></WorkspaceDataBoundary>;
          break;
        case "settings":
          content = <NavigationViewContent view="settings" />;
          break;
        case "consolidation":
          content = <ConsolidationProgress sources={sources.projects.map(({ id, name, fileCount, treeSha256, evidence }) => ({ id, name, fileCount, treeSha256, evidenceCount: evidence.length }))} totalFiles={sources.totalFiles} archiveHash={sources.archiveSha256} />;
          break;
        case "assistant":
          content = <DemoAssistant />;
          break;
      }
      break;
    case "not-found":
      content = <NotFound />;
  }
  return <RoutePage key={pathname}>{content}</RoutePage>;
}

function RoutePage({ children }: { children: ReactNode }) { return children; }


import { Suspense } from "react";
import { WorkspaceProvider } from "@/components/workspace-provider";
import { AppShell } from "@/components/app-shell";
import { BrowserNavigationProvider } from "@/platform/navigation/browser-provider";
import { readAppearance } from "@/platform/appearance";
import { RouteContent } from "./route-content";
import { AppErrorBoundary } from "./error-boundary";

export function App() {
  return <AppErrorBoundary><BrowserNavigationProvider><WorkspaceProvider>
    <AppShell initialAppearance={readAppearance()}>
      <Suspense><RouteContent /></Suspense>
    </AppShell>
  </WorkspaceProvider></BrowserNavigationProvider></AppErrorBoundary>;
}

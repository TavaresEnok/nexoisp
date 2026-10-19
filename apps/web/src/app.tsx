import { Suspense, lazy } from "react";
import { BrowserNavigationProvider } from "@/platform/navigation/browser-provider";
import { AppErrorBoundary } from "./error-boundary";
import { SessionProvider } from "@/features/session/provider";
import { isOperational } from "@/platform/execution";
const DemoApplication = lazy(() => import("./demo-application"));
const OperationalApplication = lazy(() => import("@/features/operations/application").then(module => ({ default: module.OperationalApplication })));
export function App() {
 return <AppErrorBoundary><BrowserNavigationProvider><SessionProvider><Suspense fallback={<main className="erp-login" aria-busy="true" aria-label="Carregando NexoISP">Carregando…</main>}>{isOperational ? <OperationalApplication /> : <DemoApplication />}</Suspense></SessionProvider></BrowserNavigationProvider></AppErrorBoundary>;
}

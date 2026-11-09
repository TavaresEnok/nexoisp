import { Suspense, lazy } from "react";
import { Route, Routes } from "react-router-dom";
import { BrowserNavigationProvider } from "@/platform/navigation/browser-provider";
import { AppErrorBoundary } from "./error-boundary";
import { SessionProvider } from "@/features/session/provider";
import { isOperational } from "@/platform/execution";
const DemoApplication = lazy(() => import("./demo-application"));
const OperationalApplication = lazy(() => import("@/features/operations/application").then(module => ({ default: module.OperationalApplication })));
const PublicViability = lazy(() => import("@/features/viability/public-page").then(module => ({ default: module.PublicViability })));
// Página pública por provedor: sem sessão, sem shell e sem chamadas autenticadas.
const publicViability = isOperational && /^\/viabilidade\/[^/]+\/?$/.test(window.location.pathname);
export function App() {
 if (publicViability) return <AppErrorBoundary><Suspense fallback={<main className="erp-login" aria-busy="true" aria-label="Carregando consulta de viabilidade">Carregando…</main>}><Routes><Route path="/viabilidade/:slug" element={<PublicViability />} /></Routes></Suspense></AppErrorBoundary>;
 return <AppErrorBoundary><BrowserNavigationProvider><SessionProvider><Suspense fallback={<main className="erp-login" aria-busy="true" aria-label="Carregando NexoISP">Carregando…</main>}>{isOperational ? <OperationalApplication /> : <DemoApplication />}</Suspense></SessionProvider></BrowserNavigationProvider></AppErrorBoundary>;
}

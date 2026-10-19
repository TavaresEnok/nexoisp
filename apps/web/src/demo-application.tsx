import { Suspense } from "react";
import { WorkspaceProvider } from "@/components/workspace-provider";
import { AppShell } from "@/components/app-shell";
import { readAppearance } from "@/platform/appearance";
import { RouteContent } from "./route-content";
export default function DemoApplication() {
 return <WorkspaceProvider><AppShell initialAppearance={readAppearance()}><Suspense><RouteContent /></Suspense></AppShell></WorkspaceProvider>;
}

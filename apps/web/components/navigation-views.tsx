import type { ReactElement } from "react";
import type { NavigationView } from "@/lib/navigation";
import { Overview } from "@/components/overview";
import { Subscribers } from "@/components/subscribers";
import { Financial } from "@/components/financial";
import { Support } from "@/components/support";
import { FieldOperations } from "@/components/field-operations";
import { NetworkCenter } from "@/components/network-center";
import { NetworkExplorer } from "@/components/network-explorer";
import { OpticalNetwork } from "@/components/optical-network";
import { IpTraceability } from "@/components/ip-traceability";
import { TechnicalWorkspace } from "@/components/technical-workspace";
import { Settings } from "@/components/management";
import { Plans } from "@/components/plans";
import { Contracts } from "@/components/contracts";
import { WorkspaceDataBoundary } from "@/components/workspace-data-boundary";

const navigationViews = {
  overview: <WorkspaceDataBoundary><Overview /></WorkspaceDataBoundary>,
  subscribers: <WorkspaceDataBoundary><Subscribers /></WorkspaceDataBoundary>,
  plans: <WorkspaceDataBoundary><Plans /></WorkspaceDataBoundary>,
  contracts: <WorkspaceDataBoundary><Contracts /></WorkspaceDataBoundary>,
  financial: <WorkspaceDataBoundary><Financial /></WorkspaceDataBoundary>,
  support: <WorkspaceDataBoundary><Support /></WorkspaceDataBoundary>,
  field: <WorkspaceDataBoundary><FieldOperations /></WorkspaceDataBoundary>,
  network: <WorkspaceDataBoundary><NetworkCenter /></WorkspaceDataBoundary>,
  "network-online": <WorkspaceDataBoundary><NetworkExplorer mode="online" /></WorkspaceDataBoundary>,
  "network-map": <WorkspaceDataBoundary><NetworkExplorer mode="map" /></WorkspaceDataBoundary>,
  "network-olt": <WorkspaceDataBoundary><OpticalNetwork mode="olt" /></WorkspaceDataBoundary>,
  "network-pon": <WorkspaceDataBoundary><OpticalNetwork mode="pon" /></WorkspaceDataBoundary>,
  "network-cto": <WorkspaceDataBoundary><OpticalNetwork mode="cto" /></WorkspaceDataBoundary>,
  "network-ip": <WorkspaceDataBoundary><IpTraceability /></WorkspaceDataBoundary>,
  "network-onu-models": <TechnicalWorkspace mode="models" />,
  "network-onu-templates": <TechnicalWorkspace mode="templates" />,
  "network-pools": <TechnicalWorkspace mode="pools" />,
  "network-nas": <TechnicalWorkspace mode="nas" />,
  "network-cgnat": <TechnicalWorkspace mode="cgnat" />,
  settings: <WorkspaceDataBoundary><Settings /></WorkspaceDataBoundary>,
} satisfies Record<NavigationView, ReactElement>;

export function NavigationViewContent({ view }: { view: NavigationView }) {
  if (!Object.hasOwn(navigationViews, view)) throw new Error(`Consulta sem componente associado: ${view}`);
  return navigationViews[view];
}

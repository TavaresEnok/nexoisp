import { lazy, Suspense, type ReactNode } from "react";
import useSWR from "swr";
import { useLocation } from "react-router-dom";
import NotFound from "@/src/not-found";
import { PageHeading } from "@/components/workspace-ui";
import { QueryBoundary, ConnectedNotice } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { hasModule } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { overview } from "./models";
import { portalSectionKeys, type PortalSectionKey } from "./section-keys";
import { PortalAcceptances } from "./requests";
import {
  PortalInvoices,
  PortalNotices,
  PortalPlans,
  PortalProfile,
  PortalTrustRelease,
  PortalUsage,
  type PortalOverview,
} from "./sections";
const PortalSurveys = lazy(() =>
  import("./requests").then((m) => ({ default: m.PortalSurveys })),
);
const PortalTickets = lazy(() =>
  import("./requests").then((m) => ({ default: m.PortalTickets })),
);
const PortalWifi = lazy(() =>
  import("./wifi").then((m) => ({ default: m.PortalWifi })),
);
type Section = {
  module?: string;
  render: (data: PortalOverview, refresh: () => Promise<unknown>) => ReactNode;
};
const portalSections: Record<PortalSectionKey, Section> = {
  planos: { render: (data, refresh) => <PortalPlans {...{ data, refresh }} /> },
  consumo: {
    render: (data) => (
      <PortalUsage contracts={data.contracts} usage={data.usage} />
    ),
  },
  faturas: {
    render: (data, refresh) => <PortalInvoices {...{ data, refresh }} />,
  },
  dados: {
    render: (data, refresh) => <PortalProfile {...{ data, refresh }} />,
  },
  wifi: { render: () => <PortalWifi standalone /> },
  religar: {
    render: (data, refresh) => (
      <PortalTrustRelease {...{ data, refresh }} standalone />
    ),
  },
  atendimento: { module: "crm", render: () => <PortalTickets /> },
  documentos: { render: () => <PortalAcceptances standalone /> },
  satisfacao: { module: "field", render: () => <PortalSurveys standalone /> },
};
export function PortalHome() {
  const { me } = useSession();
  const location = useLocation();
  const result = useSWR(
    "portal-overview",
    async () => overview.parse(await api("/portal/overview")),
    { refreshInterval: 15000 },
  );
  const key = location.pathname.split("/")[2] ?? "";
  const section = portalSectionKeys.includes(key as PortalSectionKey)
    ? portalSections[key as PortalSectionKey]
    : undefined;
  if (key && (!section || (section.module && !hasModule(me, section.module))))
    return <NotFound />;
  const data = result.data;
  const refresh = () => result.mutate();
  return (
    <>
      <ConnectedNotice demo={me?.demo} />
      <PageHeading
        title={`Olá, ${(data?.subscriber.name ?? me?.name ?? "assinante").split(" ")[0]}`}
        description={`Seu atendimento e seus serviços com ${me?.tenant?.name ?? "o provedor"}.`}
      />
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {data && (
          <div className="erp-stack">
            {section ? (
              <Suspense
                fallback={<QueryBoundary loading>{null}</QueryBoundary>}
              >
                {section.render(data, refresh)}
              </Suspense>
            ) : (
              <>
                <PortalNotices {...{ data, refresh }} />
                <PortalAcceptances />
                <PortalPlans {...{ data, refresh }} />
                <PortalTrustRelease {...{ data, refresh }} />
                <PortalInvoices {...{ data, refresh }} />
                <PortalUsage contracts={data.contracts} usage={data.usage} />
                <Suspense
                  fallback={<QueryBoundary loading>{null}</QueryBoundary>}
                >
                  <PortalWifi />
                  {hasModule(me, "crm") && <PortalTickets />}
                  {hasModule(me, "field") && <PortalSurveys />}
                </Suspense>
                <PortalProfile {...{ data, refresh }} />
              </>
            )}
          </div>
        )}
      </QueryBoundary>
    </>
  );
}

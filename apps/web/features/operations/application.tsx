import {
  isRecordId,
  operationalNavigationAreas,
  resolveCatalogueNode,
  searchOperationalNavigation,
} from "./catalogue";
import { useEffect, lazy, Suspense } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import NotFound from "@/src/not-found";
import { AppShell } from "@/components/app-shell";
import { ShellProvider } from "@/components/shell-context";
import { useOperationalShell } from "./shell";
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
import { returnPath } from "./return-path";
import { operationalTitle } from "./status";
import { ErpOverview } from "./overview";
import { OperationalContracts } from "@/features/contracts/directory";
import { AddonCatalog } from "@/features/contracts/addons";
import { OperationalPlans } from "@/features/plans/catalog";
import {
  navigationAreas,
  findNavigationPage,
  searchNavigation,
} from "@/lib/navigation";
const ReferralReport = lazy(() =>
  import("@/features/finance/referrals").then((module) => ({
    default: module.ReferralReport,
  })),
);
const CollectionReports = lazy(() =>
  import("@/features/finance/reports").then((module) => ({
    default: module.CollectionReports,
  })),
);
const FinancePolicy = lazy(() =>
  import("@/features/finance/policy").then((module) => ({
    default: module.FinancePolicy,
  })),
);
const FinanceReconciliation = lazy(() =>
  import("@/features/finance/reconciliation").then((module) => ({
    default: module.FinanceReconciliation,
  })),
);
const OperationalInvoices = lazy(() =>
  import("@/features/finance/directory").then((module) => ({
    default: module.OperationalInvoices,
  })),
);
const OperationalLeads = lazy(() =>
  import("@/features/crm/leads").then((module) => ({
    default: module.OperationalLeads,
  })),
);
const OperationalTickets = lazy(() =>
  import("@/features/crm/tickets").then((module) => ({
    default: module.OperationalTickets,
  })),
);
const OperationalTicketOverlay = lazy(() =>
  import("@/features/crm/tickets").then((module) => ({
    default: module.OperationalTicketOverlay,
  })),
);
const CrmReport = lazy(() =>
  import("@/features/crm/report").then((module) => ({
    default: module.CrmReport,
  })),
);
const OperationalSearch = lazy(() =>
  import("@/features/search/directory").then((module) => ({
    default: module.OperationalSearch,
  })),
);
const OperationalSettings = lazy(() =>
  import("./settings").then((module) => ({
    default: module.OperationalSettings,
  })),
);
const DataImport = lazy(() =>
  import("@/features/admin/import").then((module) => ({
    default: module.DataImport,
  })),
);
const Integrations = lazy(() =>
  import("@/features/admin/integrations").then((module) => ({
    default: module.Integrations,
  })),
);
const TeamNotices = lazy(() =>
  import("@/features/admin/team-notices").then((module) => ({
    default: module.TeamNotices,
  })),
);
const SubscriberMessages = lazy(() =>
  import("@/features/admin/messages").then((module) => ({
    default: module.SubscriberMessages,
  })),
);
const PortalSignOut = lazy(() =>
  import("@/features/portal/navigation").then((module) => ({
    default: module.PortalSignOut,
  })),
);
const PortalHome = lazy(() =>
  import("@/features/portal/home").then((module) => ({
    default: module.PortalHome,
  })),
);
const TenantDirectory = lazy(() =>
  import("@/features/admin/tenants").then((module) => ({
    default: module.TenantDirectory,
  })),
);
const AnatelCollection = lazy(() =>
  import("@/features/admin/anatel").then((module) => ({
    default: module.AnatelCollection,
  })),
);
const AuditDirectory = lazy(() =>
  import("@/features/admin/audit").then((module) => ({
    default: module.AuditDirectory,
  })),
);
const QualityAdministration = lazy(() =>
  import("@/features/admin/quality").then((module) => ({
    default: module.QualityAdministration,
  })),
);
const TeamDirectory = lazy(() =>
  import("@/features/admin/users").then((module) => ({
    default: module.TeamDirectory,
  })),
);
const CompanyDirectory = lazy(() =>
  import("@/features/admin/companies").then((module) => ({
    default: module.CompanyDirectory,
  })),
);
const NetworkMap = lazy(() =>
  import("@/features/network/map").then((module) => ({
    default: module.NetworkMap,
  })),
);
const LegalIpLookup = lazy(() =>
  import("@/features/network/legal").then((module) => ({
    default: module.LegalIpLookup,
  })),
);
const CgnatDirectory = lazy(() =>
  import("@/features/network/cgnat").then((module) => ({
    default: module.CgnatDirectory,
  })),
);
const AddressDirectory = lazy(() =>
  import("@/features/network/ipam").then((module) => ({
    default: module.AddressDirectory,
  })),
);
const FiberDirectory = lazy(() =>
  import("@/features/network/ftth").then((module) => ({
    default: module.FiberDirectory,
  })),
);
const NetworkPops = lazy(() =>
  import("@/features/network/pops").then((module) => ({
    default: module.NetworkPops,
  })),
);
const NetworkMaintenance = lazy(() =>
  import("@/features/network/maintenance").then((module) => ({
    default: module.NetworkMaintenance,
  })),
);
const NetworkOnus = lazy(() =>
  import("@/features/network/onus").then((module) => ({
    default: module.NetworkOnus,
  })),
);
const NetworkNoc = lazy(() =>
  import("@/features/network/noc").then((module) => ({
    default: module.NetworkNoc,
  })),
);
const OnlineConnections = lazy(() =>
  import("@/features/network/online").then((module) => ({
    default: module.OnlineConnections,
  })),
);
const NetworkOperations = lazy(() =>
  import("@/features/network/operations").then((module) => ({
    default: module.NetworkOperations,
  })),
);
const OperationalOperationOverlay = lazy(() =>
  import("@/features/network/operations").then((module) => ({
    default: module.OperationalOperationOverlay,
  })),
);
const NetworkDirectory = lazy(() =>
  import("@/features/network/directory").then((module) => ({
    default: module.NetworkDirectory,
  })),
);
const StockCatalog = lazy(() =>
  import("@/features/stock/catalog").then((module) => ({
    default: module.StockCatalog,
  })),
);
const OperationalAgenda = lazy(() =>
  import("@/features/field/agenda").then((module) => ({
    default: module.OperationalAgenda,
  })),
);
const MyWork = lazy(() =>
  import("@/features/field/my-work").then((module) => ({
    default: module.MyWork,
  })),
);
const OperationalOrders = lazy(() =>
  import("@/features/field/directory").then((module) => ({
    default: module.OperationalOrders,
  })),
);
const OperationalOrderOverlay = lazy(() =>
  import("@/features/field/sheet").then((module) => ({
    default: module.OperationalOrderOverlay,
  })),
);
export function OperationalApplication() {
  const session = useSession();
  const shell = useOperationalShell();
  const location = useLocation();
  useEffect(() => {
    const path = canonicalErpPath(location.pathname);
    const title =
      (
        {
          "/": "Painel inicial",
          "/login": "Entrar",
          "/assinantes": "Assinantes",
          "/conta": "Minha conta",
        } as Record<string, string>
      )[path] ??
      operationalTitle(path) ??
      findNavigationPage(path)?.label ??
      "NexoISP";
    document.title = `${title} · NexoISP`;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute(
        "content",
        "Seu provedor, em sintonia. Ambiente operacional NexoISP.",
      );
  }, [location.pathname]);
  if (session.loading || session.error)
    return (
      <main className="erp-login">
        <QueryBoundary
          loading={session.loading}
          error={session.error}
          retry={() => session.reload()}
        >
          {null}
        </QueryBoundary>
      </main>
    );
  if (!session.me)
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="*"
          element={
            <Navigate
              to="/login"
              replace
              state={{ from: `${location.pathname}${location.search}` }}
            />
          }
        />
      </Routes>
    );
  const me = session.me;
  const home = me.mfa_pending
    ? "/conta"
    : me.role === "subscriber"
      ? "/portal"
      : !me.tenant
        ? "/provedores"
        : "/";
  const allowed = canAccessPath(me, location.pathname);
  return (
    <OperationalWorkspaceProvider>
      <ShellProvider value={shell}>
        <AppShell initialAppearance={readAppearance()}>
          {location.pathname === "/login" ? (
            <Navigate to={returnPath(me, location.state) ?? home} replace />
          ) : me.mfa_pending && !location.pathname.startsWith("/conta") ? (
            <Navigate to="/conta" replace />
          ) : !allowed ? (
            <AccessDenied />
          ) : (
            <Suspense fallback={<QueryBoundary loading>{null}</QueryBoundary>}>
              <Routes>
                <Route
                  path="/"
                  element={
                    me.role === "subscriber" || !me.tenant ? (
                      <Navigate to={home} replace />
                    ) : (
                      <ErpOverview />
                    )
                  }
                />
                <Route
                  path="/relatorios/indicacoes"
                  element={<ReferralReport />}
                />
                <Route
                  path="/configuracoes"
                  element={<OperationalSettings />}
                />
                <Route
                  path="/administracao/importacao"
                  element={<DataImport />}
                />
                <Route
                  path="/administracao/integracoes"
                  element={<Integrations />}
                />
                <Route path="/administracao/avisos" element={<TeamNotices />} />
                <Route
                  path="/administracao/avisos-assinante"
                  element={<SubscriberMessages />}
                />
                <Route path="/portal/sair" element={<PortalSignOut />} />
                <Route path="/portal/*" element={<PortalHome />} />
                <Route path="/provedores" element={<TenantDirectory />} />
                <Route
                  path="/administracao/anatel"
                  element={<AnatelCollection />}
                />
                <Route path="/auditoria" element={<AuditDirectory />} />
                <Route
                  path="/administracao/catalogos-sla"
                  element={<QualityAdministration />}
                />
                <Route path="/busca" element={<OperationalSearch />} />
                <Route
                  path="/administracao/usuarios"
                  element={<TeamDirectory />}
                />
                <Route
                  path="/administracao/empresas"
                  element={<CompanyDirectory />}
                />
                <Route path="/rede/mapa" element={<NetworkMap />} />
                <Route path="/rede/consulta-ip" element={<LegalIpLookup />} />
                <Route
                  path="/rede/enderecos-ip/planos-de-cgnat"
                  element={<CgnatDirectory />}
                />
                <Route
                  path="/rede/enderecos-ip"
                  element={<AddressDirectory />}
                />
                <Route
                  path="/rede/enderecos-ip/blocos-de-enderecos"
                  element={<AddressDirectory />}
                />
                <Route path="/rede/ftth" element={<FiberDirectory />} />
                <Route
                  path="/rede/ftth/fttx-cto"
                  element={<FiberDirectory />}
                />
                <Route path="/pops" element={<NetworkPops />} />
                <Route
                  path="/rede/manutencoes"
                  element={<NetworkMaintenance />}
                />
                <Route path="/rede/onus" element={<NetworkOnus />} />
                <Route path="/rede/ftth/fttx-onu" element={<NetworkOnus />} />
                <Route path="/noc" element={<NetworkNoc />} />
                <Route path="/rede/online" element={<OnlineConnections />} />
                <Route path="/rede/operacoes" element={<NetworkOperations />} />
                <Route
                  path="/rede/equipamentos"
                  element={<NetworkDirectory />}
                />
                <Route path="/estoque" element={<StockCatalog />} />
                <Route path="/agenda" element={<OperationalAgenda />} />
                <Route path="/meu-trabalho" element={<MyWork />} />
                <Route
                  path="/ordens-de-servico"
                  element={<OperationalOrders />}
                />
                <Route path="/prospectos" element={<OperationalLeads />} />
                <Route path="/atendimentos" element={<OperationalTickets />} />
                <Route path="/relatorios/atendimento" element={<CrmReport />} />
                <Route
                  path="/relatorios/cobranca"
                  element={<CollectionReports />}
                />
                <Route
                  path="/financeiro/politica-de-cobranca"
                  element={<FinancePolicy />}
                />
                <Route
                  path="/financeiro/conciliacao"
                  element={<FinanceReconciliation />}
                />
                <Route
                  path="/financeiro/faturas"
                  element={<OperationalInvoices />}
                />
                <Route path="/contratos" element={<OperationalContracts />} />
                <Route
                  path="/contratos/:id"
                  element={<RecordLink base="/contratos" param="contrato" />}
                />
                <Route path="/produtos-adicionais" element={<AddonCatalog />} />
                <Route path="/planos" element={<OperationalPlans />} />
                <Route path="/conta/*" element={<Account />} />
                <Route path="/assinantes" element={<SubscriberDirectory />} />
                <Route
                  path="/assinantes/:id"
                  element={<RecordLink base="/assinantes" param="ficha" />}
                />
                {Object.entries(erpAliases).map(([from, to]) => (
                  <Route
                    key={from}
                    path={from}
                    element={
                      <Navigate to={`${to}${location.search}`} replace />
                    }
                  />
                ))}
                <Route path="/estrutura" element={<OperationalDirectory />} />
                <Route path="*" element={<CatalogueDestination />} />
              </Routes>
            </Suspense>
          )}
          {allowed &&
            me.tenant &&
            me.role !== "subscriber" &&
            !me.mfa_pending && <OperationalSubscriberSheet />}
          {allowed &&
            me.tenant &&
            me.role !== "subscriber" &&
            !me.mfa_pending &&
            new URLSearchParams(location.search).has("protocolo") && (
              <Suspense
                fallback={<QueryBoundary loading>{null}</QueryBoundary>}
              >
                <OperationalTicketOverlay />
              </Suspense>
            )}
          {allowed &&
            me.tenant &&
            me.role !== "subscriber" &&
            !me.mfa_pending &&
            new URLSearchParams(location.search).has("ordem") && (
              <Suspense
                fallback={<QueryBoundary loading>{null}</QueryBoundary>}
              >
                <OperationalOrderOverlay />
              </Suspense>
            )}
          {allowed &&
            me.tenant &&
            me.role !== "subscriber" &&
            !me.mfa_pending &&
            new URLSearchParams(location.search).has("operacao") && (
              <Suspense
                fallback={<QueryBoundary loading>{null}</QueryBoundary>}
              >
                <OperationalOperationOverlay />
              </Suspense>
            )}
        </AppShell>
      </ShellProvider>
    </OperationalWorkspaceProvider>
  );
}
// Links antigos de ficha aceitam somente identificadores do Go.
function RecordLink({ base, param }: { base: string; param: string }) {
  const location = useLocation();
  const { id = "" } = useParams();
  if (!isRecordId(id)) return <CatalogueDestination />;
  const query = new URLSearchParams(location.search);
  query.set(param, id);
  return <Navigate to={`${base}?${query}`} replace />;
}
function CatalogueDestination() {
  const location = useLocation();
  const resolution = resolveCatalogueNode(location.pathname);
  if (!resolution) return <NotFound />;
  if (resolution.kind === "planned")
    return <PlannedFeature pathname={location.pathname} />;
  const [pathname, target = ""] = resolution.destination.split("?");
  if (pathname === location.pathname) return <NotFound />;
  const query = new URLSearchParams(location.search);
  new URLSearchParams(target).forEach((value, key) => query.set(key, value));
  return (
    <Navigate to={`${pathname}${query.size ? `?${query}` : ""}`} replace />
  );
}
function AccessDenied() {
  return (
    <>
      <PageHeading
        title="Acesso não disponível"
        description="Esta página não está liberada para sua conta ou para os módulos do provedor."
      />
      <Panel title="Verifique seu contexto de acesso">
        <p>
          Consulte o administrador do provedor para verificar suas permissões.
        </p>
        <a href="/conta">Minha conta</a>
      </Panel>
    </>
  );
}
function PlannedFeature({ pathname }: { pathname: string }) {
  const node = findNavigationPage(pathname);
  return (
    <>
      <PageHeading
        title={
          node?.label ??
          (pathname === "/provedores"
            ? "Provedores"
            : pathname === "/portal"
              ? "Portal do assinante"
              : "Recurso planejado")
        }
        description="Recurso previsto no desenho de evolução do NexoISP."
      />
      <Panel
        title="Recurso planejado"
        description="Este destino ainda não possui uma apresentação operacional nesta página. Consulte os recursos conectados no menu ou explore a demonstração visual."
      >
        <Badge variant="outline">Planejado</Badge>
        <p className="profile-footnote">
          A demonstração visual usa um cenário fictício em um contexto separado.
        </p>
        <Button
          variant="outline"
          onClick={() => window.location.assign(`/demonstracao${pathname}`)}
        >
          Abrir demonstração visual
        </Button>
      </Panel>
    </>
  );
}
function OperationalDirectory() {
  const { me } = useSession();
  const [params] = useSearchParams();
  const query = params.get("busca") ?? "";
  const matches = query
    ? new Set(searchOperationalNavigation(query).map((page) => page.href))
    : null;
  return (
    <>
      <PageHeading
        title="Mapa de páginas"
        description="Destinos disponíveis para seu contexto de acesso."
      />
      <div className="erp-stack">
        {operationalNavigationAreas()
          .map((area) => ({
            ...area,
            pages: area.pages.filter(
              (page) =>
                canAccessPath(me, page.href) &&
                (!matches || matches.has(page.href)),
            ),
          }))
          .filter((area) => area.pages.length)
          .map((area) => (
            <Panel
              key={area.id}
              title={area.label}
              description={area.description}
            >
              <div className="erp-inline-actions">
                {area.pages.map((page) => (
                  <a
                    className="profile-text-action"
                    key={page.href}
                    href={page.href}
                  >
                    {page.label}
                  </a>
                ))}
              </div>
            </Panel>
          ))}
      </div>
    </>
  );
}

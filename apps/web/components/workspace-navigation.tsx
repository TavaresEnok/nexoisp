"use client";

import React, { useId, useState, useSyncExternalStore } from "react";
import Link from "@/platform/navigation/link";
import { usePathname } from "@/platform/navigation/react";
import { Accordion } from "@base-ui/react/accordion";
import {
  Bot,
  ArrowUpRight,
  Building2,
  ChartNoAxesCombined,
  ChevronRight,
  ChevronsUpDown,
  CircleHelp,
  Headphones,
  Infinity as InfinityIcon,
  LayoutDashboard,
  ListTree,
  LogIn,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings2,
  ShieldCheck,
  Users,
  Wallet,
} from "lucide-react";
import {
  navigationAreas,
  findNavigationPage,
  isNavigationCurrent,
  type NavigationNode,
} from "@/lib/navigation";
import { resolveNavigationRoute } from "@/lib/navigation-route";
import { cn } from "@/lib/utils";

import { initials } from "@/lib/format";
import { useShell } from "@/components/shell-context";
import { isValidFavoriteCandidate } from "@/lib/navigation-favorites";
import {
  FavoriteToggleButton,
  NavigationFavoritesSection,
  useNavigationFavorites,
} from "@/components/navigation-favorites";

const areaIcons = [
  Users,
  ChartNoAxesCombined,
  Wallet,
  Network,
  Headphones,
  Settings2,
  Building2,
  Users,
  LogIn,
];

function NavigationBranch({
  node,
  pathname,
  onNavigate,
  icon: Icon,
  compact = false,
  isEligible = false,
  isFavorite,
  onToggleFavorite,
}: {
  node: NavigationNode;
  pathname: string;
  onNavigate: () => void;
  icon?: typeof Users;
  compact?: boolean;
  isEligible?: boolean;
  isFavorite?: (href: string) => boolean;
  onToggleFavorite?: (href: string) => void;
}) {
  const shell = useShell();
  const operational = Boolean(shell);
  const availability = shell
    ? shell.connected(node.href)
      ? "conectado ao ERP"
      : "recurso planejado"
    : node.view
      ? "consulta parcial disponível"
      : "implementação pendente";
  const current = findNavigationPage(pathname) ?? shell?.findPage(pathname);
  const [selection, setSelection] = useState<{
    path: string;
    open: boolean;
  } | null>(null);
  const open =
    selection?.path === pathname
      ? selection.open
      : Boolean(
          current &&
            current.href !== node.href &&
            (node.href === "/"
              ? current.moduleHref === "/"
              : current.href.startsWith(`${node.href}/`)),
        );
  const panelId = useId();
  const canFavorite =
    isEligible &&
    !compact &&
    onToggleFavorite &&
    isValidFavoriteCandidate(node.href, shell);
  return (
    <li>
      <div className="navigation-branch-row">
        <Link
          href={node.href}
          prefetch={false}
          className={cn(
            "context-link",
            (isNavigationCurrent(node, pathname) ||
              (operational && node.href === pathname)) &&
              "active",
          )}
          onClick={onNavigate}
          aria-label={compact ? node.label : undefined}
          aria-current={
            isNavigationCurrent(node, pathname) ||
            (operational && node.href === pathname)
              ? "page"
              : undefined
          }
          title={`${node.label} · ${availability}`}
        >
          {Icon && <Icon size={17} />}
          <span>{node.label}</span>
          {!Icon && (
            <i
              className={cn(
                "page-marker",
                (shell ? shell.connected(node.href) : node.view) && "available",
              )}
              aria-hidden="true"
            />
          )}
          <span className="sr-only">{`(${availability})`}</span>
        </Link>
        {canFavorite && (
          <FavoriteToggleButton
            href={node.href}
            label={node.label}
            isFavorite={Boolean(isFavorite?.(node.href))}
            onToggle={onToggleFavorite}
          />
        )}
        {!compact && node.children.length > 0 && (
          <button
            className="branch-toggle"
            aria-label={`${open ? "Recolher" : "Expandir"} submenus de ${node.label}`}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setSelection({ path: pathname, open: !open })}
          >
            <ChevronRight size={12} className={cn(open && "rotated")} />
          </button>
        )}
      </div>
      {!compact && node.children.length > 0 && (
        <ul id={panelId} className="sidebar-nested-links" hidden={!open}>
          {open &&
            node.children
              .filter((child) => !shell || shell.canAccess(child.href))
              .map((child) => (
                <NavigationBranch
                  key={child.href}
                  node={child}
                  pathname={pathname}
                  onNavigate={onNavigate}
                  isEligible={isEligible}
                  isFavorite={isFavorite}
                  onToggleFavorite={onToggleFavorite}
                />
              ))}
        </ul>
      )}
    </li>
  );
}

const subscribeMobile = (callback: () => void) => {
  const media = window.matchMedia("(max-width: 700px)");
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
};

export function WorkspaceNavigation({
  collapsed: desktopCollapsed,
  onNavigate,
  onSearch,
  onHelp,
  onProvider,
  onToggle,
}: {
  collapsed: boolean;
  onNavigate: () => void;
  onSearch: () => void;
  onHelp: () => void;
  onProvider: () => void;
  onToggle: () => void;
}) {
  const shell = useShell();
  const operational = Boolean(shell);
  const favoritesManager = useNavigationFavorites(shell);
  const areas = (shell ? shell.areas() : navigationAreas)
    .map((area, index) => ({
      ...area,
      icon: areaIcons[index],
      pages: area.pages.filter((page) => !shell || shell.canAccess(page.href)),
    }))
    .filter((area) => area.pages.length);
  const personalDestination = shell?.personal ?? null;
  const personalNode: NavigationNode | null = personalDestination
    ? {
        ...personalDestination,
        sourceLabel: personalDestination.label,
        area: "Conta",
        audience: personalDestination.audience,
        trail: [personalDestination.label],
        parentHref: null,
        moduleHref: personalDestination.href,
        children: [],
      }
    : null;
  const route = resolveNavigationRoute(usePathname());
  const pathname = route.pathname;
  const current = findNavigationPage(pathname) ?? shell?.findPage(pathname);
  const mobile = useSyncExternalStore(
    subscribeMobile,
    () => window.matchMedia("(max-width: 700px)").matches,
    () => false,
  );
  const collapsed = desktopCollapsed && !mobile;
  const activeArea = (shell ? shell.areas() : navigationAreas).find((area) =>
    area.pages.some((page) => page.href === current?.moduleHref),
  );
  const [selection, setSelection] = useState<{
    path: string;
    areas: string[];
  } | null>(null);
  const openAreas =
    selection?.path === pathname
      ? selection.areas
      : [activeArea?.id ?? "assinantes"];
  return (
    <div className={cn("premium-navigation", collapsed && "is-collapsed")}>
      <div className="workspace-wordmark">
        <Link href="/" aria-label="NexoISP · início" onClick={onNavigate}>
          <InfinityIcon className="compact-wordmark" size={27} />
          <span className="full-wordmark">
            nexo<span>isp</span>
            <i />
          </span>
        </Link>
        <span className="wordmark-caption">WORKSPACE</span>
      </div>
      <button
        className="organization-switch"
        onClick={onProvider}
        aria-label={
          operational
            ? `Consultar provedor ${shell?.account?.tenant ?? "NexoISP"}`
            : "Consultar provedor Conecta Fibra"
        }
      >
        <span className="organization-monogram" aria-hidden="true">
          {operational
            ? initials(shell?.account?.tenant ?? "NexoISP").toLowerCase()
            : "cf"}
          <i />
        </span>
        <span className="organization-details">
          <strong>
            {operational
              ? (shell?.account?.tenant ?? "Operação do SaaS")
              : "Conecta Fibra"}
          </strong>
          <small>
            {shell?.account ? shell.account.role : "Ambiente de demonstração"}
          </small>
        </span>
        <ChevronsUpDown size={13} />
      </button>
      <button
        className="sidebar-search"
        onClick={onSearch}
        aria-label="Buscar qualquer coisa"
        title="Buscar · Ctrl ou ⌘ K"
      >
        <Search size={16} />
        <span>Buscar qualquer coisa</span>
        <kbd>⌘ K</kbd>
      </button>
      <nav className="context-navigation" aria-label="Áreas do provedor">
        <ul className="sidebar-start-links">
          {personalNode && (
            <NavigationBranch
              node={personalNode}
              pathname={pathname}
              onNavigate={onNavigate}
              icon={LayoutDashboard}
              compact={collapsed}
              isEligible={favoritesManager.isEligible}
              isFavorite={favoritesManager.isFavorite}
              onToggleFavorite={favoritesManager.toggleFavorite}
            />
          )}
          {(!shell || shell.canAccess("/")) && (
            <NavigationBranch
              node={
                shell
                  ? shell.branch(findNavigationPage("/")!)
                  : findNavigationPage("/")!
              }
              pathname={pathname}
              onNavigate={onNavigate}
              icon={LayoutDashboard}
              compact={collapsed}
              isEligible={favoritesManager.isEligible}
              isFavorite={favoritesManager.isFavorite}
              onToggleFavorite={favoritesManager.toggleFavorite}
            />
          )}
        </ul>
        {favoritesManager.isEligible && (
          <NavigationFavoritesSection
            favorites={favoritesManager.favorites}
            pathname={pathname}
            collapsed={collapsed}
            isPersisted={favoritesManager.isPersisted}
            onNavigate={onNavigate}
            onToggle={favoritesManager.toggleFavorite}
          />
        )}
        <p className="context-label">ÁREAS DO PROVEDOR</p>
        <Accordion.Root
          multiple
          className="sidebar-areas"
          value={collapsed ? [] : openAreas}
          onValueChange={(value) => {
            setSelection({ path: pathname, areas: value });
            if (collapsed) onToggle();
          }}
        >
          {areas.map((area) => {
            const Icon = area.icon;
            return (
              <Accordion.Item key={area.id} value={area.id}>
                <Accordion.Header>
                  <Accordion.Trigger
                    className={cn(
                      "sidebar-area-trigger",
                      activeArea?.id === area.id && "has-active-page",
                    )}
                    title={area.description}
                    aria-label={`Área de ${area.label}`}
                  >
                    <Icon size={17} strokeWidth={1.6} />
                    <span>{area.label}</span>
                    <ChevronRight className="area-chevron" size={14} />
                  </Accordion.Trigger>
                </Accordion.Header>
                {!collapsed && (
                  <Accordion.Panel className="sidebar-area-panel">
                    <ul className="sidebar-area-links">
                      {area.pages.map((page) => (
                        <NavigationBranch
                          key={page.href}
                          node={page}
                          pathname={pathname}
                          onNavigate={onNavigate}
                          isEligible={favoritesManager.isEligible}
                          isFavorite={favoritesManager.isFavorite}
                          onToggleFavorite={favoritesManager.toggleFavorite}
                        />
                      ))}
                    </ul>
                  </Accordion.Panel>
                )}
              </Accordion.Item>
            );
          })}
        </Accordion.Root>
        <p className="context-label">GESTÃO DO WORKSPACE</p>
        <div className="sidebar-scroll-utilities">
          {(!shell ||
            (shell.canAccess("/assistente") &&
              shell.connected("/assistente"))) && (
            <Link
              href="/assistente"
              className={cn(
                "context-link",
                route.kind === "special" &&
                  route.entry === "assistant" &&
                  "active",
              )}
              onClick={onNavigate}
              aria-label="Assistente"
              aria-current={
                route.kind === "special" && route.entry === "assistant"
                  ? "page"
                  : undefined
              }
              title="Assistente NexoISP"
            >
              <Bot size={17} />
              <span>Assistente</span>
            </Link>
          )}
          {(!shell || shell.canAccess("/configuracoes")) && (
            <Link
              href="/configuracoes"
              className={cn(
                "context-link",
                pathname === "/configuracoes" && "active",
              )}
              onClick={onNavigate}
              aria-label="Configurações"
              title="Configurações"
            >
              <Settings2 size={17} />
              <span>Configurações</span>
            </Link>
          )}
          {(!shell || shell.canAccess("/estrutura")) && (
            <Link
              href="/estrutura"
              className={cn(
                "context-link",
                pathname === "/estrutura" && "active",
              )}
              onClick={onNavigate}
              aria-current={pathname === "/estrutura" ? "page" : undefined}
              title="Mapa de páginas"
              aria-label="Mapa de páginas"
            >
              <ListTree size={17} />
              <span>Mapa de páginas</span>
            </Link>
          )}
          {(!shell ||
            (shell.canAccess("/acompanhamento") &&
              shell.connected("/acompanhamento"))) && (
            <Link
              href="/acompanhamento"
              className={cn(
                "context-link",
                pathname === "/acompanhamento" && "active",
              )}
              onClick={onNavigate}
              aria-current={pathname === "/acompanhamento" ? "page" : undefined}
              title="Consolidação e evidências"
              aria-label="Consolidação e evidências"
            >
              <ShieldCheck size={17} />
              <span>Consolidação e evidências</span>
            </Link>
          )}
        </div>
        <div className="context-profile">
          <Link
            href="/conta"
            onClick={onNavigate}
            aria-label={
              shell?.account
                ? `Minha conta · ${shell.account.name}`
                : "Minha conta · Gabriel Almeida"
            }
            title="Minha conta"
          >
            <span className="profile-avatar">
              {shell?.account ? shell.account.initials : "GA"}
            </span>
            <span>
              <strong>{shell ? shell.account?.name : "Gabriel Almeida"}</strong>
              <small>
                {shell?.account ? shell.account.role : "Perfil demonstrativo"}
              </small>
            </span>
          </Link>
          <button
            className="sidebar-toggle"
            onClick={onToggle}
            aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
            title={collapsed ? "Expandir menu" : "Recolher menu"}
          >
            {collapsed ? (
              <PanelLeftOpen size={16} />
            ) : (
              <PanelLeftClose size={16} />
            )}
          </button>
        </div>
      </nav>
      <div className="unified-sidebar-footer">
        <button
          className="context-link sidebar-help"
          onClick={onHelp}
          title="Central de ajuda"
          aria-label="Central de ajuda"
        >
          <CircleHelp size={17} />
          <span>Central de ajuda</span>
          <ArrowUpRight size={13} />
        </button>
      </div>
    </div>
  );
}

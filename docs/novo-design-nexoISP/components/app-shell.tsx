"use client";

import {
  useState,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Link from "@/platform/navigation/link";
import { usePathname, useRouter } from "@/platform/navigation/react";
import {
  ListTree,
  Users,
  Headphones,
  Wrench,
  Network,
  Settings2,
  HelpCircle,
  Search,
  Bell,
  ChevronDown,
  ArrowUpRight,
  ArrowRight,
  Menu,
  Sun,
  Moon,
  Command,
  Check,
  Radio,
  ShieldCheck,
  Building2,
  Database,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { useWorkspaceStatus } from "@/components/workspace-provider";
import { matchesSubscriber } from "@/lib/subscriber-search";
import { normalize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ResponsiveSidebar } from '@/components/responsive-sidebar';
import { WorkspaceNavigation } from '@/components/workspace-navigation';
import { searchNavigation } from '@/lib/navigation';
import { resolveNavigationRoute } from '@/lib/navigation-route';
import { saveAppearance, subscribeSystemAppearance, systemIsDark } from "@/platform/appearance";
import { isDemoMode } from "@/application/execution-mode";

export function AppShell({ children, initialAppearance }: { children: ReactNode; initialAppearance: "light" | "dark" | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data, error, requestData, openSubscriber } = useWorkspaceStatus();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [appearance, setAppearance] = useState<"light" | "dark" | null>(initialAppearance);
  const changeAppearance = (value: "light" | "dark") => {
    setAppearance(value);
    saveAppearance(value);
  };
  const openSearch = () => { requestData(); setQuery(""); setSearchOpen(true); };
  const systemDark = useSyncExternalStore(
    subscribeSystemAppearance,
    systemIsDark,
    () => false,
  );
  const dark = appearance ? appearance === "dark" : systemDark;
  const label = resolveNavigationRoute(pathname).title;
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        requestData();
        setSearchOpen((value) => !value);
      }
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const go = (href: string) => {
    setSearchOpen(false);
    setMobileOpen(false);
    router.push(href);
  };
  const results = query.trim()
    ? (data?.subscribers ?? [])
        .filter((s) => matchesSubscriber(s, query))
        .slice(0, 5)
    : [];
  const ticketResults = query.trim()
    ? (data?.tickets ?? [])
        .filter((t) =>
          normalize(`${t.code} ${t.subject} ${t.name}`).includes(
            normalize(query),
          ),
        )
        .slice(0, 3)
    : [];
  const allPageResults = searchNavigation(query);
  const pageResults = allPageResults.slice(0, query.trim() ? 18 : 8);
  return (
    <div className={cn("app-frame", collapsed && "sidebar-collapsed")}>
      <a href="#main-content" className="skip-link">
        Pular para o conteúdo
      </a>
      <ResponsiveSidebar open={mobileOpen} onOpenChange={setMobileOpen}>
        <WorkspaceNavigation
          collapsed={collapsed}
          onNavigate={() => setMobileOpen(false)}
          onSearch={() => { setMobileOpen(false); openSearch(); }}
          onProvider={() => { setMobileOpen(false); setProviderOpen(true); }}
          onHelp={() => { setMobileOpen(false); setHelpOpen(true); }}
          onToggle={() => setCollapsed(value => !value)}
        />
      </ResponsiveSidebar>
      <div className="app-body">
        <header className="topbar">
          <div className="breadcrumb">
            <Button
              size="icon"
              variant="ghost"
              className="mobile-menu"
              onClick={() => setMobileOpen(true)}
              aria-label="Abrir navegação"
            >
              <Menu />
            </Button>
            <span className="breadcrumb-workspace">Workspace</span>
            <span className="breadcrumb-divider">/</span>
            <strong>{label}</strong>
          </div>
          <div className="topbar-actions">
            <button
              className="global-search"
              aria-label="Buscar no workspace"
              onClick={openSearch}
            >
              <Search size={15} />
              <span>Buscar em todo o workspace</span>
              <kbd>⌘ K</kbd>
            </button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => changeAppearance(dark ? "light" : "dark")}
                    aria-label={
                      dark ? "Ativar tema claro" : "Ativar tema escuro"
                    }
                  />
                }
              >
                {dark ? <Sun /> : <Moon />}
              </TooltipTrigger>
              <TooltipContent>Alternar aparência</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="notification-button"
                    aria-label="Notificações"
                  />
                }
              >
                <Bell />
                <i />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="notifications-menu">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Seu centro de atenção</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => go("/rede/equipamentos?filtro=atencao")}>
                    <Radio />
                    12 ONUs com sinal degradado
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => go("/atendimentos?filtro=aguardando")}
                  >
                    <Headphones />8 aguardando no cenário operacional
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => go("/operacoes?filtro=atrasadas")}
                  >
                    <Wrench />2 ordens de serviço atrasadas
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <p className="menu-footnote">
                  Cenário fictício · 17 out., 09:42
                </p>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="topbar-separator" />
            <DropdownMenu>
              <DropdownMenuTrigger className="profile-trigger" aria-label="Perfil de demonstração">
                <span className="profile-avatar">GA</span>
                <ChevronDown size={13} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    Gabriel Almeida · perfil demonstrativo
                  </DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => go("/configuracoes")}>
                    <Settings2 />
                    Configurações do workspace
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setMobileOpen(false); setHelpOpen(true) }}>
                    <HelpCircle />
                    Sobre esta demonstração
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main id="main-content" className="page-content" tabIndex={-1}>
          {children}
        </main>
      </div>
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="command-dialog">
          <DialogHeader>
            <DialogTitle className="sr-only">Busca global</DialogTitle>
            <DialogDescription className="sr-only">
              Encontre assinantes, chamados e páginas do workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="command-search">
            <Search size={20} />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Nome, documento, telefone, PPPoE, IP, MAC ou serial…"
              aria-label="Busca global"
            />
          </div>
          <div className="command-results">
            {!data && <p className="command-empty" role="status">{error ? "Dados operacionais indisponíveis. A busca de páginas continua disponível." : "Carregando assinantes e atendimentos…"}</p>}
            {results.length > 0 && (
              <>
                <p className="nav-label">ASSINANTES</p>
                {results.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      setSearchOpen(false);
                      openSubscriber(s.id);
                    }}
                  >
                    <Users size={17} />
                    <span>
                      {s.name}
                      <small>
                        #{s.code} · {s.plan}
                      </small>
                    </span>
                    <ArrowUpRight size={15} />
                  </button>
                ))}
              </>
            )}
            {ticketResults.length > 0 && (
              <>
                <p className="nav-label">ATENDIMENTOS</p>
                {ticketResults.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => go(`/atendimentos?busca=${t.code}`)}
                  >
                    <Headphones size={17} />
                    <span>
                      #{t.code} · {t.subject}
                      <small>{t.name}</small>
                    </span>
                    <ArrowRight size={15} />
                  </button>
                ))}
              </>
            )}
            {pageResults.length > 0 && (
              <>
                <p className="nav-label">NAVEGAR PARA</p>
                {pageResults.map((page) => (
                  <button key={page.href} onClick={() => go(page.href)}>
                    <ListTree size={17} />
                    <span>{page.label}<small>{page.trail.slice(0, -1).join(" / ")} · {page.view ? "Consulta parcial" : "Pendente"}</small></span>
                    <ArrowRight size={15} />
                  </button>
                ))}
                {allPageResults.length > pageResults.length && <button onClick={() => go(`/busca?q=${encodeURIComponent(query)}`)}><Search size={17} /><span>Ver os {allPageResults.length} resultados de navegação</span><ArrowRight size={15} /></button>}
              </>
            )}
            {results.length === 0 &&
              ticketResults.length === 0 &&
              pageResults.length === 0 && (
                <p className="command-empty">
                  Nenhum resultado. Tente um nome, como Mariana.
                </p>
              )}
          </div>
          <div className="command-footer">
            <span>
              <Command size={12} /> Busca unificada
            </span>
            <span>Esc para fechar</span>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={providerOpen} onOpenChange={setProviderOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Seu workspace</DialogTitle>
            <DialogDescription>
              Um ambiente para conhecer os fluxos do NexoISP.
            </DialogDescription>
          </DialogHeader>
          <div className="workspace-choice">
            <span className="provider-avatar">
              <Building2 size={20} />
            </span>
            <div>
              <strong>Conecta Fibra</strong>
              <p>Workspace demonstrativo</p>
            </div>
            <Check size={18} />
          </div>
          <p className="muted-copy">
            {isDemoMode ? "Os registros são fictícios e lidos do cenário local, sem consulta a banco ou API operacional." : "Os registros são fictícios e armazenados no Neon. A consulta é pública e somente leitura."} Não insira informações reais de clientes.
          </p>
          <Link
            href="/configuracoes"
            className={buttonVariants({ variant: "outline" })}
            onClick={() => setProviderOpen(false)}
          >
            Ver estrutura do ambiente <ArrowRight data-icon="inline-end" />
          </Link>
        </DialogContent>
      </Dialog>
      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="help-dialog">
          <DialogHeader>
            <div className="help-icon">
              <Network size={26} />
            </div>
            <DialogTitle>Seu provedor, em sintonia.</DialogTitle>
            <DialogDescription>
              O NexoISP conecta os contextos, não apenas as telas.
            </DialogDescription>
          </DialogHeader>
          <div className="help-feature">
            <Users />
            <div>
              <strong>Comece pelo assinante</strong>
              <p>
                Abra uma ficha para consultar contrato, faturas, conexão e
                histórico no mesmo lugar.
              </p>
            </div>
          </div>
          <div className="help-feature">
            <ShieldCheck />
            <div>
              <strong>De um alerta à próxima ação</strong>
              <p>
                Os itens de atenção levam diretamente às filas filtradas de
                atendimento, financeiro e rede.
              </p>
            </div>
          </div>
          <div className="help-feature">
            <Database />
            <div>
              <strong>Transparência por padrão</strong>
              <p>
                {isDemoMode ? "Base fictícia local. Nenhum banco ou API operacional é consultado neste modo." : "Base fictícia no Neon."} Não há conexão com WhatsApp ou equipamentos reais. Acesso de demonstração, somente leitura.
              </p>
            </div>
          </div>
          <Button
            onClick={() => {
              setHelpOpen(false);
              go("/assinantes");
              openSubscriber("sub-1");
            }}
          >
            Explorar uma ficha de assinante{" "}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

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
import { useWorkspaceStatus } from "@/features/workspace/context";
import { matchesSubscriber } from "@/lib/subscriber-search";
import { normalize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ResponsiveSidebar } from '@/components/responsive-sidebar';
import { WorkspaceNavigation } from '@/components/workspace-navigation';
import { searchNavigation } from '@/lib/navigation';
import { resolveNavigationRoute } from '@/lib/navigation-route';
import { saveAppearance, subscribeSystemAppearance, systemIsDark } from "@/platform/appearance";
import { isDemoMode } from "@/application/execution-mode";
import { useShell, useNoRecordSearch, useNoAttention } from "@/components/shell-context";
import { toast } from "sonner";
import { LogOut } from "lucide-react";

export function AppShell({ children, initialAppearance }: { children: ReactNode; initialAppearance: "light" | "dark" | null }) {
  const pathname = usePathname();
  const shell = useShell();
  const operational = Boolean(shell);
  const account = shell?.account ?? null;
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
  const label = shell?.title(pathname) ?? resolveNavigationRoute(pathname).title;
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
  const search = (shell?.useRecordSearch ?? useNoRecordSearch)(query);
  const attention = (shell?.useAttention ?? useNoAttention)();
  const allPageResults = (shell ? shell.searchPages(query).filter(page => shell.canAccess(page.href)) : searchNavigation(query));
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
                {(!operational || attention.items.length > 0) && <i />}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="notifications-menu">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Seu centro de atenção</DropdownMenuLabel>
                  {operational ? <>{attention.items.map(item => <DropdownMenuItem key={item.id} onClick={() => go(item.href)}>{item.area === "network" ? <Radio /> : item.area === "field" ? <Wrench /> : <Headphones />}{item.title}</DropdownMenuItem>)}{!attention.items.length && <p className="menu-footnote">{attention.loading ? "Consultando pendências…" : attention.error ? attention.error.message : "Nenhuma pendência para você agora."}</p>}</> : <><DropdownMenuItem onClick={() => go("/rede/equipamentos?filtro=atencao")}>
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
                  </DropdownMenuItem></>}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <p className="menu-footnote">
                  {operational ? "Pendências do seu perfil · atualizadas a cada 30 s" : "Cenário fictício · 17 out., 09:42"}
                </p>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="topbar-separator" />
            <DropdownMenu>
              <DropdownMenuTrigger className="profile-trigger" aria-label={operational ? "Minha conta" : "Perfil de demonstração"}>
                <span className="profile-avatar">{account ? account.initials : "GA"}</span>
                <ChevronDown size={13} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    {account ? `${account.name} · ${account.role}` : "Gabriel Almeida · perfil demonstrativo"}
                  </DropdownMenuLabel>
                  {(!shell || shell.canAccess("/configuracoes")) && <DropdownMenuItem onClick={() => go("/configuracoes")}>
                    <Settings2 />
                    Configurações do workspace
                  </DropdownMenuItem>}
                  <DropdownMenuItem onClick={() => { setMobileOpen(false); setHelpOpen(true) }}>
                    <HelpCircle />
                    {operational ? "Sobre o NexoISP" : "Sobre esta demonstração"}
                  </DropdownMenuItem>
                  {operational && <><DropdownMenuItem onClick={() => go("/conta")}><ShieldCheck />Minha conta</DropdownMenuItem><DropdownMenuItem onClick={async () => { try { await shell?.logout(); go("/login"); } catch (error) { toast.error((error as Error).message); } }}><LogOut />Sair</DropdownMenuItem></>}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        {account?.support && <div className="erp-banner"><span>Acesso de suporte a <strong>{account.tenant}</strong> · ações auditadas</span><Button variant="outline" size="sm" onClick={async () => { try { await shell?.exitSupport(); go("/provedores"); } catch (error) { toast.error((error as Error).message); } }}>Encerrar suporte</Button></div>}
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
              maxLength={operational?80:undefined}
            />
          </div>
          <div className="command-results">
            {!operational && !data && <p className="command-empty" role="status">{error ? "Dados operacionais indisponíveis. A busca de páginas continua disponível." : "Carregando assinantes e atendimentos…"}</p>}
            {search.error && <p role="alert" className="command-empty">{search.error.message}</p>}
            {search.loading && <p role="status" className="command-empty">Consultando o provedor…</p>}
            {search.results?.map(result => <button key={result.id} onClick={() => { setSearchOpen(false); go(result.href); }}><Users size={17} /><span>{result.title}<small>{result.detail}</small></span><ArrowUpRight size={15} /></button>)}
            {shell && query.trim().length>=2 && shell.canAccess("/busca") && <button onClick={()=>{setSearchOpen(false);go(`/busca?q=${encodeURIComponent(query.trim())}`);}}><Search size={17} /><span>Ver resultados completos<small>Assinantes, contratos e correspondências da rede</small></span><ArrowUpRight size={15} /></button>}
            {!operational && results.length > 0 && (
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
            {!operational && ticketResults.length > 0 && (
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
                    <span>{page.label}<small>{page.trail.slice(0, -1).join(" / ")} · {shell ? shell.connected(page.href)?"Conectado ao ERP":"Integração pendente" : page.view ? "Consulta parcial" : "Pendente"}</small></span>
                    <ArrowRight size={15} />
                  </button>
                ))}
                {allPageResults.length > pageResults.length && <button onClick={() => go(operational?`/estrutura?busca=${encodeURIComponent(query)}`:`/busca?q=${encodeURIComponent(query)}`)}><Search size={17} /><span>Ver os {allPageResults.length} resultados de navegação</span><ArrowRight size={15} /></button>}
              </>
            )}
            {results.length === 0 &&
              ticketResults.length === 0 &&
              pageResults.length === 0 && (!operational || (!search.loading && !search.error && !search.results?.length)) && (
                <p className="command-empty">
                  {operational ? "Nenhum destino encontrado. Busque por nome ou documento." : "Nenhum resultado. Tente um nome, como Mariana."}
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
              {operational ? "Seu contexto de acesso no NexoISP." : "Um ambiente para conhecer os fluxos do NexoISP."}
            </DialogDescription>
          </DialogHeader>
          <div className="workspace-choice">
            <span className="provider-avatar">
              <Building2 size={20} />
            </span>
            <div>
<strong>{operational ? account?.tenant ?? "Operação do SaaS" : "Conecta Fibra"}</strong>
              <p>{account ? account.role : "Workspace demonstrativo"}</p>
            </div>
            <Check size={18} />
          </div>
          <p className="muted-copy">
            {operational ? "Os dados e ações são limitados ao seu contexto de acesso e às permissões do servidor." : isDemoMode ? "Os registros são fictícios e lidos do cenário local, sem consulta a banco ou API operacional." : "Os registros são fictícios e armazenados no Neon. A consulta é pública e somente leitura."} {!operational && "Não insira informações reais de clientes."}
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
                {operational ? "Os módulos conectados consultam o ERP. Pré-visualizações demonstrativas usam um contexto separado." : isDemoMode ? "Base fictícia local. Nenhum banco ou API operacional é consultado neste modo." : "Base fictícia no Neon."} {!operational && "Não há conexão com WhatsApp ou equipamentos reais. Acesso de demonstração, somente leitura."}
              </p>
            </div>
          </div>
          <Button
            onClick={() => {
              setHelpOpen(false);
              go("/assinantes");
              if (!operational) openSubscriber("sub-1");
            }}
          >
            {operational ? "Consultar assinantes" : "Explorar uma ficha de assinante"}{" "}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

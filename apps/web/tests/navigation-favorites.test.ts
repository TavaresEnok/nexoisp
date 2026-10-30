import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

// Garante disponibilidade do React para componentes que utilizam runtime clássico de JSX em testes
(globalThis as unknown as { React: typeof React }).React = React;

const nestedButtonInAnchor = /<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<button/i;
import type { ShellAdapter } from "../components/shell-context";
import { ShellProvider } from "../components/shell-context";
import {
  NavigationProvider,
  type NavigationAdapter,
} from "../platform/navigation/react";
import { WorkspaceNavigation } from "../components/workspace-navigation";
import {
  NavigationFavoritesSection,
  FavoriteToggleButton,
  useNavigationFavorites,
} from "../components/navigation-favorites";
import { operationalNavigationAreas } from "../features/operations/catalogue";
import {
  getFavoritesStorageKey,
  isValidFavoriteCandidate,
  readStoredFavorites,
  resolveValidFavorites,
  writeStoredFavorites,
  MAX_FAVORITES,
  MAX_STORAGE_BYTES,
  type FavoritePage,
} from "../lib/navigation-favorites";

function createMockStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
  };
}

function mockNavigationAdapter(pathname = "/"): NavigationAdapter {
  return {
    pathname,
    search: "",
    getSearch: () => "",
    push: () => {},
    replace: () => {},
    refresh: () => {},
    replaceQuery: () => {},
  };
}

function mockShell(overrides?: Partial<ShellAdapter>): ShellAdapter {
  return {
    account: {
      name: "Técnico Silva",
      initials: "TS",
      role: "Técnico/NOC",
      tenant: "Fibra Teste",
      demo: false,
      support: false,
    },
    preferenceScope: "u1:tenant-1:noc:false:network:read:network",
    canAccess: (path: string) => {
      // Bloqueia financeiro de exemplo para testar permissão
      if (path.startsWith("/financeiro")) return false;
      return true;
    },
    connected: (path: string) => path !== "/rede/ftth/acs-template",
    title: () => undefined,
    areas: () => operationalNavigationAreas(),
    findPage: () => undefined,
    branch: (node) => node,
    searchPages: () => [],
    personal: null,
    useRecordSearch: () => ({ loading: false }),
    useAttention: () => ({ items: [], loading: false }),
    logout: async () => {},
    exitSupport: async () => {},
    ...overrides,
  };
}

test("validação estrita de candidatos a favoritos de equipe", () => {
  const shell = mockShell();

  // Candidatos válidos de equipe existentes
  assert.equal(isValidFavoriteCandidate("/assinantes", shell), true);
  assert.equal(isValidFavoriteCandidate("/contratos", shell), true);
  assert.equal(isValidFavoriteCandidate("/", shell), true);

  // Invalidação de URLs externas, // e javascript
  assert.equal(isValidFavoriteCandidate("https://externo.com", shell), false);
  assert.equal(isValidFavoriteCandidate("http://externo.com", shell), false);
  assert.equal(isValidFavoriteCandidate("//malicioso.com", shell), false);
  assert.equal(isValidFavoriteCandidate("javascript:alert(1)", shell), false);

  // Invalidação de query e hash
  assert.equal(isValidFavoriteCandidate("/assinantes?ficha=123", shell), false);
  assert.equal(isValidFavoriteCandidate("/assinantes#aba", shell), false);
  assert.equal(isValidFavoriteCandidate("/contratos?novo=1", shell), false);

  // Invalidação de IDs de registro
  assert.equal(
    isValidFavoriteCandidate(
      "/assinantes/12345678-1234-1234-1234-123456789abc",
      shell,
    ),
    false,
  );
  assert.equal(isValidFavoriteCandidate("/assinantes/99999", shell), false);

  // Invalidação de rotas de login/sair/portal/operador
  assert.equal(isValidFavoriteCandidate("/login", shell), false);
  assert.equal(isValidFavoriteCandidate("/sair", shell), false);
  assert.equal(isValidFavoriteCandidate("/portal", shell), false);
  assert.equal(isValidFavoriteCandidate("/portal/planos", shell), false);
  assert.equal(isValidFavoriteCandidate("/provedores", shell), false);
  assert.equal(isValidFavoriteCandidate("/conta", shell), false);

  // Invalidação de páginas planejadas
  assert.equal(
    isValidFavoriteCandidate("/rede/ftth/acs-template", shell),
    false,
  );
  assert.equal(isValidFavoriteCandidate("/assistente", shell), false);
  assert.equal(isValidFavoriteCandidate("/acompanhamento", shell), false);

  // Invalidação de caminhos desconhecidos (não aceita prefixo livre)
  assert.equal(
    isValidFavoriteCandidate("/assinantes/caminho-inexistente", shell),
    false,
  );
  assert.equal(
    isValidFavoriteCandidate("/financeiro/faturas/desconhecido", shell),
    false,
  );

  // Invalidação por falta de permissão na sessão corrente
  assert.equal(isValidFavoriteCandidate("/financeiro/faturas", shell), false);
});

test("armazenamento versionado, isolado por escopo e com fail-safe", () => {
  const storage = createMockStorage();
  const scopeA = "user-1:tenant-a:noc:false:perms:modules";
  const scopeB = "user-2:tenant-b:admin:false:perms:modules";

  // Chaves de storage são isoladas por escopo
  assert.notEqual(
    getFavoritesStorageKey(scopeA),
    getFavoritesStorageKey(scopeB),
  );

  // Sem escopo não persiste
  assert.equal(writeStoredFavorites(null, ["/assinantes"], storage), false);
  assert.deepEqual(readStoredFavorites(null, storage), {
    items: [],
    isPersisted: false,
  });

  // Salvar e ler com dedup e limite 12
  const items = [
    "/assinantes",
    "/contratos",
    "/assinantes", // duplicado
    "/planos",
    "/produtos-adicionais",
    "/rede/mapa",
    "/relatorios/consultar-onu",
    "/rede/online",
    "/rede/consulta-ip",
    "/rede/equipamentos",
    "/rede/ftth",
    "/ordens-de-servico",
    "/agenda",
    "/estoque", // 13º item (deve cortar em 12)
  ];
  assert.equal(writeStoredFavorites(scopeA, items, storage), true);

  const readA = readStoredFavorites(scopeA, storage);
  assert.equal(readA.isPersisted, true);
  assert.equal(readA.items.length, 12);
  assert.equal(readA.items[0], "/assinantes");
  assert.equal(readA.items[1], "/contratos");
  assert.equal(readA.items[2], "/planos");
  assert.equal(new Set(readA.items).size, 12);

  // O escopo B não enxerga dados do escopo A
  const readB = readStoredFavorites(scopeB, storage);
  assert.deepEqual(readB.items, []);

  // Proteção contra payload malformado ou campos desconhecidos
  const keyA = getFavoritesStorageKey(scopeA);
  storage.setItem(
    keyA,
    JSON.stringify({ version: 1, items: ["/assinantes"], malicious: true }),
  );
  assert.deepEqual(readStoredFavorites(scopeA, storage).items, []);

  storage.setItem(keyA, JSON.stringify({ version: 2, items: ["/assinantes"] }));
  assert.deepEqual(readStoredFavorites(scopeA, storage).items, []);

  storage.setItem(keyA, "corrupted-json-content{");
  assert.deepEqual(readStoredFavorites(scopeA, storage).items, []);

  // Proteção contra payload maior que 8 KiB
  const hugePayload = JSON.stringify({
    version: 1,
    items: ["/assinantes"],
    pad: "x".repeat(MAX_STORAGE_BYTES + 10),
  });
  storage.setItem(keyA, hugePayload);
  assert.deepEqual(readStoredFavorites(scopeA, storage).items, []);
});

test("armazenamento que lança erro opera em memória e não afirma persistência", () => {
  const brokenStorage = createMockStorage();
  brokenStorage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  brokenStorage.getItem = () => {
    throw new Error("SecurityError");
  };

  const scope = "u:t:role:false:p:m";
  assert.equal(
    writeStoredFavorites(scope, ["/assinantes"], brokenStorage),
    false,
  );
  const read = readStoredFavorites(scope, brokenStorage);
  assert.equal(read.isPersisted, false);
  assert.deepEqual(read.items, []);
});

test("getter de window.localStorage que lança SecurityError opera em memória e não quebra a lateral", () => {
  const originalWindow = (globalThis as unknown as { window?: unknown }).window;
  try {
    const fakeWindow = {};
    Object.defineProperty(fakeWindow, "localStorage", {
      get() {
        const error = new Error(
          "SecurityError: Access to Storage is denied for this document",
        );
        error.name = "SecurityError";
        throw error;
      },
      configurable: true,
    });
    (globalThis as unknown as { window: unknown }).window = fakeWindow;

    const scope = "u:tenant:noc:false:network:read";
    // Leitura não lança exceção e opera em memória
    const read = readStoredFavorites(scope);
    assert.equal(read.isPersisted, false);
    assert.deepEqual(read.items, []);

    // Gravação não lança exceção e reporta falha de persistência
    const written = writeStoredFavorites(scope, ["/assinantes"]);
    assert.equal(written, false);

    // useNavigationFavorites inicializa com segurança e opera em memória
    const shell = mockShell({ preferenceScope: scope });
    let hookResult: ReturnType<typeof useNavigationFavorites> | null = null;
    function Probe() {
      hookResult = useNavigationFavorites(shell);
      return null;
    }
    renderToStaticMarkup(React.createElement(Probe));
    assert.ok(hookResult);
    const nonNullHookResult = hookResult as ReturnType<
      typeof useNavigationFavorites
    >;
    assert.equal(nonNullHookResult.isPersisted, false);
    assert.deepEqual(nonNullHookResult.favorites, []);
  } finally {
    if (originalWindow !== undefined) {
      (globalThis as unknown as { window: unknown }).window = originalWindow;
    } else {
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  }
});

test("sanitização estrita contra strings inválidas: não consome limite nem regrava payload inválido", () => {
  const storage = createMockStorage();
  const scope = "u:tenant:noc:false:network:read";
  const shell = mockShell({ preferenceScope: scope });
  const storageKey = getFavoritesStorageKey(scope);

  const invalidEntries = [
    "/assinantes?ficha=123",
    "/assinantes#aba",
    "https://externo.com",
    "//malicioso.com",
    "javascript:alert(1)",
    "/assinantes/12345678-1234-1234-1234-123456789abc",
    "/assinantes/99999",
    "/login",
    "/sair",
    "/portal",
    "/desconhecido/1",
    "/desconhecido/2",
  ];

  // 1. Storage contendo 12 entradas inválidas seguidas de 1 entrada válida.
  // A sanitização ocorre antes do limite, então a página válida não é descartada.
  storage.setItem(
    storageKey,
    JSON.stringify({
      version: 1,
      items: [...invalidEntries, "/assinantes"],
    }),
  );

  const readWithValid = readStoredFavorites(scope, storage, shell);
  assert.deepEqual(readWithValid.items, ["/assinantes"]);

  // 2. Storage com apenas 12 entradas inválidas.
  // useNavigationFavorites descarta o lixo e permite adicionar um favorito legítimo.
  storage.setItem(
    storageKey,
    JSON.stringify({
      version: 1,
      items: invalidEntries,
    }),
  );

  let capturedFavorites: ReturnType<typeof useNavigationFavorites> | null =
    null;
  function HookHarness() {
    capturedFavorites = useNavigationFavorites(shell, storage);
    return null;
  }

  renderToStaticMarkup(React.createElement(HookHarness));
  assert.ok(capturedFavorites);
  assert.deepEqual(
    (capturedFavorites as ReturnType<typeof useNavigationFavorites>).favorites,
    [],
  );

  // Adiciona favorito legítimo via toggleFavorite
  (
    capturedFavorites as ReturnType<typeof useNavigationFavorites>
  ).toggleFavorite("/assinantes");

  // Verifica que o storage agora contém APENAS o favorito legítimo
  const rawUpdated = storage.getItem(storageKey);
  assert.ok(rawUpdated);
  const parsedUpdated = JSON.parse(rawUpdated);
  assert.deepEqual(parsedUpdated, {
    version: 1,
    items: ["/assinantes"],
  });

  // 3. writeStoredFavorites rejeita entradas inválidas e páginas não autorizadas
  const mixedList = [
    "/assinantes?ficha=999",
    "https://malicioso.com",
    "/contratos",
    "/financeiro/faturas", // Não autorizado para técnico NOC no mockShell
    "/planos",
  ];
  const writeResult = writeStoredFavorites(scope, mixedList, storage, shell);
  assert.equal(writeResult, true);

  const rawMixed = storage.getItem(storageKey);
  assert.ok(rawMixed);
  const parsedMixed = JSON.parse(rawMixed);
  assert.deepEqual(parsedMixed, {
    version: 1,
    items: ["/contratos", "/planos"],
  });
});

test("derivação de rótulos do catálogo e filtro quando permissões mudam", () => {
  const shellA = mockShell();
  const rawList = ["/assinantes", "/contratos", "/financeiro/faturas"];

  // Com shellA, financeiro não é acessível
  const resolvedA = resolveValidFavorites(rawList, shellA);
  assert.equal(resolvedA.length, 2);
  assert.equal(resolvedA[0].href, "/assinantes");
  assert.equal(resolvedA[0].label, "Consultar");
  assert.equal(resolvedA[1].href, "/contratos");
  assert.equal(resolvedA[1].label, "Contratos");

  // Se o usuário ganha permissão financeira, deriva dinamicamente a cada render
  const shellB = mockShell({
    canAccess: () => true,
  });
  const resolvedB = resolveValidFavorites(rawList, shellB);
  assert.equal(resolvedB.length, 3);
  assert.equal(resolvedB[2].href, "/financeiro/faturas");
  assert.equal(resolvedB[2].label, "Faturas");
});

test("componentes: nunca aninham botão dentro de link e explicitam preferência local", () => {
  const favorites = [
    { href: "/assinantes", label: "Consultar" },
    { href: "/contratos", label: "Contratos" },
  ];

  // Renderiza seção de favoritos com persistência
  const markupPersisted = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(NavigationFavoritesSection, {
        favorites,
        pathname: "/assinantes",
        collapsed: false,
        isPersisted: true,
        onNavigate: () => {},
        onToggle: () => {},
      }),
    ),
  );

  // Explicita preferência local neste navegador
  assert.match(markupPersisted, /Neste navegador/i);
  assert.match(markupPersisted, /FAVORITOS/);
  // Não aninha botão dentro de <a>
  assert.doesNotMatch(markupPersisted, nestedButtonInAnchor);

  // Renderiza seção sem persistência (em memória)
  const markupMemory = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(NavigationFavoritesSection, {
        favorites,
        pathname: "/",
        collapsed: false,
        isPersisted: false,
        onNavigate: () => {},
        onToggle: () => {},
      }),
    ),
  );
  assert.match(markupMemory, /Em memória/i);
  assert.doesNotMatch(markupMemory, nestedButtonInAnchor);

  // Botão de alternar favorito com acessibilidade (aria-pressed e label)
  const markupToggle = renderToStaticMarkup(
    React.createElement(FavoriteToggleButton, {
      href: "/assinantes",
      label: "Consultar",
      isFavorite: true,
      onToggle: () => {},
    }),
  );
  assert.match(markupToggle, /aria-pressed="true"/);
  assert.match(markupToggle, /Remover Consultar dos favoritos/);
});

test("WorkspaceNavigation: shell demonstrativo sem SessionProvider permanece intacto", () => {
  const navAdapter = mockNavigationAdapter("/");

  // Sem shell (modo de demonstração original)
  const markupDemo = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(NavigationProvider, {
        adapter: navAdapter,
        children: React.createElement(WorkspaceNavigation, {
          collapsed: false,
          onNavigate: () => {},
          onSearch: () => {},
          onHelp: () => {},
          onProvider: () => {},
          onToggle: () => {},
        }),
      }),
    ),
  );

  // Não renderiza controles de favoritos de equipe na demonstração original
  assert.doesNotMatch(markupDemo, />FAVORITOS</);
  assert.doesNotMatch(markupDemo, /favorite-toggle/);
  assert.doesNotMatch(markupDemo, nestedButtonInAnchor);
});

test("WorkspaceNavigation: equipe autorizada exibe favoritos e ações de estrela", () => {
  const navAdapter = mockNavigationAdapter("/assinantes");
  const shell = mockShell();

  const markupTeam = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(NavigationProvider, {
        adapter: navAdapter,
        children: React.createElement(ShellProvider, {
          value: shell,
          children: React.createElement(WorkspaceNavigation, {
            collapsed: false,
            onNavigate: () => {},
            onSearch: () => {},
            onHelp: () => {},
            onProvider: () => {},
            onToggle: () => {},
          }),
        }),
      }),
    ),
  );

  // Exibe a seção de favoritos e o aviso local
  assert.match(markupTeam, />FAVORITOS</);
  assert.match(markupTeam, /favorite-toggle/);
  // Garante que nenhum botão foi aninhado dentro de link
  assert.doesNotMatch(markupTeam, nestedButtonInAnchor);
});

test("useNavigationFavorites: inicialização por escopo e isolamento instantâneo de identidade", () => {
  const storage = createMockStorage();
  let currentFavs: FavoritePage[] = [];

  function HookProbe({ shell }: { shell: ShellAdapter }) {
    const { favorites } = useNavigationFavorites(shell, storage);
    currentFavs = favorites;
    return React.createElement(
      "div",
      null,
      favorites.map((f) => f.href).join(","),
    );
  }

  // Prepara favoritos para Usuário A no armazenamento local
  writeStoredFavorites("scope-user-A", ["/assinantes", "/contratos"], storage);

  const shellA = mockShell({ preferenceScope: "scope-user-A" });
  renderToStaticMarkup(React.createElement(HookProbe, { shell: shellA }));
  assert.equal(currentFavs.length, 2);
  assert.equal(
    (currentFavs[0] as FavoritePage | undefined)?.href,
    "/assinantes",
  );
  assert.equal(
    (currentFavs[1] as FavoritePage | undefined)?.href,
    "/contratos",
  );

  // Muda de escopo para Usuário B: escopo B começa vazio e não vaza nenhum dado do escopo A
  const shellB = mockShell({ preferenceScope: "scope-user-B" });
  renderToStaticMarkup(React.createElement(HookProbe, { shell: shellB }));
  assert.deepEqual(currentFavs, []);

  // Prepara favoritos para Usuário B
  writeStoredFavorites("scope-user-B", ["/planos"], storage);
  renderToStaticMarkup(React.createElement(HookProbe, { shell: shellB }));
  assert.equal(currentFavs.length, 1);
  assert.equal((currentFavs[0] as FavoritePage | undefined)?.href, "/planos");

  // Sessão encerrada (logout) -> favoritos ficam imediatamente vazios
  const shellLoggedOut = mockShell({ preferenceScope: null });
  renderToStaticMarkup(
    React.createElement(HookProbe, { shell: shellLoggedOut }),
  );
  assert.deepEqual(currentFavs, []);
});

test("NavigationFavoritesSection: preserva modo colapsado (rail compacto)", () => {
  // Quando colapsado e vazio, não renderiza nada
  const emptyCollapsed = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(NavigationFavoritesSection, {
        favorites: [],
        pathname: "/",
        collapsed: true,
        isPersisted: true,
        onNavigate: () => {},
        onToggle: () => {},
      }),
    ),
  );
  assert.equal(emptyCollapsed, "");

  // Quando colapsado com favoritos, renderiza links com aria-label e sem botão aninhado
  const withFavoritesCollapsed = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(NavigationFavoritesSection, {
        favorites: [{ href: "/assinantes", label: "Consultar" }],
        pathname: "/assinantes",
        collapsed: true,
        isPersisted: true,
        onNavigate: () => {},
        onToggle: () => {},
      }),
    ),
  );
  assert.match(withFavoritesCollapsed, /aria-label="Consultar"/);
  assert.doesNotMatch(withFavoritesCollapsed, nestedButtonInAnchor);
});

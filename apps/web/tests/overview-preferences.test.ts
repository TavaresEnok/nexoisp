import test from "node:test";
import assert from "node:assert/strict";
import React, { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Garante disponibilidade do React no escopo global para componentes transpilados
(globalThis as unknown as Record<string, unknown>).React = React;
import {
  DEFAULT_OVERVIEW_WIDGETS,
  MAX_PREFERENCES_STORAGE_BYTES,
  OVERVIEW_OPTIONAL_WIDGETS,
  OVERVIEW_STORAGE_KEY_PREFIX,
  getEffectiveVisibleWidgets,
  getOverviewStorageKey,
  getUtf8ByteLength,
  isTeamSession,
  isWidgetAuthorized,
  parseOverviewPreferences,
  readPreferences,
  resetPreferences,
  savePreferences,
  useOverviewPreferences,
  OverviewPreferencesControl,
  OverviewPreferencesForm,
  type OverviewOptionalWidgetId,
  type StoredOverviewPreferences,
} from "../features/operations/overview-preferences";
import { Dialog } from "../components/ui/dialog";
import { sessionScope, type Session } from "../features/session/model";

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "user-1",
    name: "Operador Teste",
    email: "operador@provedor.invalid",
    role: "admin",
    perms: ["finance:read", "network:read", "os:read", "subscribers:read"],
    modules: ["field", "crm"],
    tenant: { id: "tenant-alfa", name: "Alfa Net", slug: "alfa" },
    support: false,
    demo: false,
    mfa_enabled: true,
    mfa_pending: false,
    ...overrides,
  };
}

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

class FaultyStorage implements Storage {
  get length(): number {
    throw new Error("QuotaExceededError");
  }
  clear(): void {
    throw new Error("SecurityError: Access is denied");
  }
  getItem(): string | null {
    throw new Error("SecurityError: Access is denied");
  }
  key(): string | null {
    throw new Error("SecurityError: Access is denied");
  }
  removeItem(): void {
    throw new Error("SecurityError: Access is denied");
  }
  setItem(): void {
    throw new Error("QuotaExceededError");
  }
}

test("parsing hostil: rejeita excesso de 8KiB UTF-8 multibyte, campos desconhecidos, JSON corrompido e duplicatas", () => {
  // 1. Limite estrito em bytes UTF-8 antes do JSON.parse:
  // Excesso com caracteres ASCII
  const hugeAscii = "a".repeat(MAX_PREFERENCES_STORAGE_BYTES + 1);
  assert.equal(parseOverviewPreferences(hugeAscii), null);

  // Excesso com UTF-8 multibyte: 5039 caracteres onde cada caractere consome 2 bytes,
  // totalizando 10039 bytes UTF-8 (acima de 8192 bytes)
  const multibytePayload = JSON.stringify({
    version: 1,
    widgets: [],
    unknown: "é".repeat(5000),
  });
  assert.ok(multibytePayload.length <= MAX_PREFERENCES_STORAGE_BYTES); // comprimento em chars < 8192
  assert.ok(getUtf8ByteLength(multibytePayload) > MAX_PREFERENCES_STORAGE_BYTES); // bytes UTF-8 > 8192
  assert.equal(parseOverviewPreferences(multibytePayload), null);

  // 2. Rejeição de campos desconhecidos (propriedades extras além de version e widgets)
  const payloadWithUnknownField = JSON.stringify({
    version: 1,
    widgets: [],
    unknown: "unexpected",
  });
  assert.equal(parseOverviewPreferences(payloadWithUnknownField), null);

  // Injeção de credenciais, queries ou dados externos
  const hostileExtras = JSON.stringify({
    version: 1,
    widgets: ["revenue"],
    secret_token: "leaked_token",
    query: "id=123",
  });
  assert.equal(parseOverviewPreferences(hostileExtras), null);

  // 3. Rejeição de widgets desconhecidos no array
  const hostileWidgets = JSON.stringify({
    version: 1,
    widgets: [
      "revenue",
      "<script>alert(1)</script>",
      "arbitrary-id",
      "https://malicious.invalid/token",
    ],
  });
  assert.equal(parseOverviewPreferences(hostileWidgets), null);

  // 4. Rejeição de duplicatas no array de widgets
  const duplicateWidgets = JSON.stringify({
    version: 1,
    widgets: ["revenue", "revenue"],
  });
  assert.equal(parseOverviewPreferences(duplicateWidgets), null);

  // 5. JSON malformado e tipos incompatíveis
  assert.equal(parseOverviewPreferences("{malformed json"), null);
  assert.equal(parseOverviewPreferences(null), null);
  assert.equal(parseOverviewPreferences(""), null);
  assert.equal(parseOverviewPreferences("[]"), null);
  assert.equal(parseOverviewPreferences('{"widgets":["revenue"]}'), null);
  assert.equal(
    parseOverviewPreferences('{"version":2,"widgets":["revenue"]}'),
    null,
  );
  assert.equal(
    parseOverviewPreferences('{"version":1,"widgets":"revenue"}'),
    null,
  );
  assert.equal(
    parseOverviewPreferences('{"version":1,"widgets":[123]}'),
    null,
  );

  // 6. Payloads válidos e legítimos
  const validEmpty = JSON.stringify({ version: 1, widgets: [] });
  assert.deepEqual(parseOverviewPreferences(validEmpty), {
    version: 1,
    widgets: [],
  });

  const validSubset = JSON.stringify({
    version: 1,
    widgets: ["revenue", "agenda"],
  });
  assert.deepEqual(parseOverviewPreferences(validSubset), {
    version: 1,
    widgets: ["revenue", "agenda"],
  });

  const validAll = JSON.stringify({
    version: 1,
    widgets: ["revenue", "contract-trends", "agenda"],
  });
  assert.deepEqual(parseOverviewPreferences(validAll), {
    version: 1,
    widgets: ["revenue", "contract-trends", "agenda"],
  });
});

test("isolamento por sessionScope e feature: namespace versionado e persistência isolada", () => {
  const userA = createMockSession({ id: "user-a" });
  const userB = createMockSession({ id: "user-b" });
  const userASupport = createMockSession({ id: "user-a", support: true });
  const userATenantBeta = createMockSession({
    id: "user-a",
    tenant: { id: "tenant-beta", name: "Beta Net", slug: "beta" },
  });

  const scopeA = sessionScope(userA);
  const scopeB = sessionScope(userB);
  const scopeSupport = sessionScope(userASupport);
  const scopeTenantBeta = sessionScope(userATenantBeta);

  // Escopos devem ser estritamente distintos
  assert.notEqual(scopeA, scopeB);
  assert.notEqual(scopeA, scopeSupport);
  assert.notEqual(scopeA, scopeTenantBeta);

  const keyA = getOverviewStorageKey(scopeA);
  const keyB = getOverviewStorageKey(scopeB);

  // Namespace inicia com o prefixo da feature e versão
  assert.ok(keyA.startsWith(OVERVIEW_STORAGE_KEY_PREFIX));
  assert.ok(keyA.includes("overview-widgets:v1:"));
  assert.notEqual(keyA, keyB);

  const storage = new MemoryStorage();
  const prefsA: StoredOverviewPreferences = {
    version: 1,
    widgets: ["revenue"],
  };
  savePreferences(scopeA, prefsA, storage);

  // Leitura do userA retorna personalizado; userB continua no padrão default
  const readA = readPreferences(scopeA, storage);
  const readB = readPreferences(scopeB, storage);
  assert.equal(readA.isCustomized, true);
  assert.deepEqual(readA.preferences.widgets, ["revenue"]);
  assert.equal(readB.isCustomized, false);
  assert.deepEqual(readB.preferences.widgets, [...DEFAULT_OVERVIEW_WIDGETS]);

  // Payload gravado nunca contém nomes, tokens ou rotas, apenas version e widgets
  const storedJson = JSON.parse(storage.getItem(keyA)!);
  assert.deepEqual(Object.keys(storedJson).sort(), ["version", "widgets"]);

  // Payload corrompido ou com campos desconhecidos no storage retorna default seguro
  storage.setItem(
    keyA,
    JSON.stringify({ version: 1, widgets: [], unknown: "unexpected" }),
  );
  const readCorrupted = readPreferences(scopeA, storage);
  assert.equal(readCorrupted.isCustomized, false);
  assert.deepEqual(readCorrupted.preferences.widgets, [
    ...DEFAULT_OVERVIEW_WIDGETS,
  ]);

  // Restaurar padrão de A só apaga a chave de A
  savePreferences(scopeA, prefsA, storage);
  resetPreferences(scopeA, storage);
  assert.equal(readPreferences(scopeA, storage).isCustomized, false);
  assert.equal(storage.getItem(keyA), null);
});

test("filtro de permissão: preferência restringe visibilidade mas jamais concede permissão", () => {
  const admin = createMockSession();
  const financeOnly = createMockSession({
    perms: ["finance:read"],
    modules: [],
  });
  const techNoField = createMockSession({
    perms: ["network:read", "os:read"],
    modules: [], // Sem módulo field
  });
  const techWithField = createMockSession({
    perms: ["network:read", "os:read"],
    modules: ["field"],
  });

  // Validação individual de permissões
  assert.equal(isWidgetAuthorized("revenue", financeOnly), true);
  assert.equal(isWidgetAuthorized("contract-trends", financeOnly), false);
  assert.equal(isWidgetAuthorized("agenda", financeOnly), false);

  assert.equal(isWidgetAuthorized("agenda", techNoField), false);
  assert.equal(isWidgetAuthorized("agenda", techWithField), true);

  // Mesmo que o storage contenha todos os widgets selecionados:
  const allSelected: StoredOverviewPreferences = {
    version: 1,
    widgets: ["revenue", "contract-trends", "agenda"],
  };

  // Usuário financeOnly só pode ver revenue
  const visibleFinance = getEffectiveVisibleWidgets(allSelected, financeOnly);
  assert.deepEqual(Array.from(visibleFinance), ["revenue"]);

  // Usuário tech com field vê network e agenda, mas não revenue
  const visibleTech = getEffectiveVisibleWidgets(allSelected, techWithField);
  assert.deepEqual(Array.from(visibleTech).sort(), [
    "agenda",
    "contract-trends",
  ]);

  // Admin com tudo selecionado vê os 3
  const visibleAdmin = getEffectiveVisibleWidgets(allSelected, admin);
  assert.deepEqual(
    Array.from(visibleAdmin).sort(),
    [...OVERVIEW_OPTIONAL_WIDGETS].sort(),
  );

  // Se o admin desselecionar agenda, ela não aparece mesmo tendo permissão
  const customAdmin: StoredOverviewPreferences = {
    version: 1,
    widgets: ["revenue", "contract-trends"],
  };
  const visibleCustomAdmin = getEffectiveVisibleWidgets(customAdmin, admin);
  assert.equal(visibleCustomAdmin.has("agenda"), false);
  assert.equal(visibleCustomAdmin.has("revenue"), true);
  assert.equal(visibleCustomAdmin.has("contract-trends"), true);
});

test("regras de ativação de equipe: sem sessão, MFA pendente, subscriber ou saas sem tenant", () => {
  assert.equal(isTeamSession(null), false);

  const teamUser = createMockSession();
  assert.equal(isTeamSession(teamUser), true);

  // MFA pendente
  assert.equal(isTeamSession({ ...teamUser, mfa_pending: true }), false);

  // Assinante do portal
  assert.equal(
    isTeamSession({
      ...teamUser,
      role: "subscriber",
      perms: ["portal:self"],
    }),
    false,
  );

  // Operador do SaaS sem tenant associado
  assert.equal(
    isTeamSession({
      ...teamUser,
      role: "saas_operator",
      tenant: null,
      perms: ["tenants:manage"],
    }),
    false,
  );

  // Operador do SaaS em contexto de tenant (ex.: suporte ativo em provedor)
  assert.equal(
    isTeamSession({
      ...teamUser,
      role: "saas_operator",
      tenant: { id: "tenant-alfa", name: "Alfa", slug: "alfa" },
      support: true,
    }),
    true,
  );
});

test("riscos de estado e transição de escopo no hook useOverviewPreferences e observação de renders", () => {
  const storage = new MemoryStorage();
  const userA = createMockSession({ id: "user-a" });
  const userB = createMockSession({ id: "user-b" });
  const userASupport = createMockSession({ id: "user-a", support: true });
  const userANoFinance = createMockSession({
    id: "user-a",
    perms: ["network:read", "os:read"],
  });
  const userANoField = createMockSession({
    id: "user-a",
    modules: ["crm"], // sem módulo field
  });

  type RenderSnapshot = {
    step: number;
    scope: string | null;
    isTeam: boolean;
    isCustomized: boolean;
    storageStatus: string;
    visibleWidgets: OverviewOptionalWidgetId[];
    preferencesWidgets: OverviewOptionalWidgetId[];
  };

  const snapshots: RenderSnapshot[] = [];

  type StepConfig = {
    session: Session | null;
    action?: (hook: ReturnType<typeof useOverviewPreferences>) => void;
  };

  const steps: StepConfig[] = [
    // Passo 0: Render inicial com User A
    {
      session: userA,
      action: (h) => {
        // Desmarca agenda
        h.toggleWidget("agenda", false);
      },
    },
    // Passo 1: Observa render com User A após desmarcar agenda
    {
      session: userA,
      action: (h) => {
        // Desmarca revenue
        h.toggleWidget("revenue", false);
      },
    },
    // Passo 2: Observa render com User A tendo apenas contract-trends
    {
      session: userA,
    },
    // Passo 3: Transição imediata de escopo para User B (outro usuário)
    // O primeiro render de User B NÃO pode ter as preferências de User A
    {
      session: userB,
    },
    // Passo 4: Transição imediata para logout (session = null)
    {
      session: null,
    },
    // Passo 5: Transição imediata para suporte (userA com support = true)
    {
      session: userASupport,
      action: (h) => {
        // Na sessão de suporte, esconde contract-trends
        h.toggleWidget("contract-trends", false);
      },
    },
    // Passo 6: Observa suporte com contract-trends desmarcado
    {
      session: userASupport,
    },
    // Passo 7: Saída imediata de suporte (volta para userA normal com support = false)
    // O render de userA normal deve manter a preferência de userA (apenas contract-trends),
    // e NÃO o estado da sessão de suporte
    {
      session: userA,
    },
    // Passo 8: Mudança de permissões (userA perde finance:read)
    // Escopo muda imediatamente sincronamente, revenue não pode ser visível
    {
      session: userANoFinance,
    },
    // Passo 9: Mudança de módulos (userA perde módulo field)
    // Escopo muda imediatamente sincronamente, agenda não pode ser visível
    {
      session: userANoField,
    },
    // Passo 10: Restaurar padrão para userA
    {
      session: userA,
      action: (h) => {
        h.resetPreferences();
      },
    },
    // Passo 11: Observa render final restaurado
    {
      session: userA,
    },
  ];

  function HarnessProbe() {
    const [stepIndex, setStepIndex] = useState(0);
    const stepConfig = steps[stepIndex];
    const hook = useOverviewPreferences(stepConfig.session, storage);

    snapshots.push({
      step: stepIndex,
      scope: hook.scope,
      isTeam: hook.isTeam,
      isCustomized: hook.isCustomized,
      storageStatus: hook.storageStatus,
      visibleWidgets: Array.from(hook.visibleWidgets).sort(),
      preferencesWidgets: [...hook.preferences.widgets].sort(),
    });

    if (stepConfig.action) {
      stepConfig.action(hook);
    }

    if (stepIndex + 1 < steps.length) {
      setStepIndex(stepIndex + 1);
    }

    return React.createElement(
      "div",
      { "data-step": stepIndex },
      `step=${stepIndex}`,
    );
  }

  // Executa toda a sequência de renders e ações
  renderToStaticMarkup(React.createElement(HarnessProbe));

  assert.equal(snapshots.length, steps.length);

  // Passo 0: User A inicial (default)
  assert.equal(snapshots[0].isTeam, true);
  assert.equal(snapshots[0].isCustomized, false);
  assert.deepEqual(snapshots[0].visibleWidgets, [
    "agenda",
    "contract-trends",
    "revenue",
  ]);

  // Passo 1: User A após desmarcar agenda
  assert.equal(snapshots[1].isCustomized, true);
  assert.deepEqual(snapshots[1].visibleWidgets, [
    "contract-trends",
    "revenue",
  ]);

  // Passo 2: User A após desmarcar revenue -> resta apenas contract-trends
  assert.equal(snapshots[2].isCustomized, true);
  assert.deepEqual(snapshots[2].visibleWidgets, ["contract-trends"]);

  // Passo 3: User B entra -> imediatamente padrão seguro, NENHUM resquício de User A
  assert.equal(snapshots[3].isTeam, true);
  assert.equal(snapshots[3].isCustomized, false);
  assert.deepEqual(snapshots[3].visibleWidgets, [
    "agenda",
    "contract-trends",
    "revenue",
  ]);

  // Passo 4: Logout -> isTeam false, scope null, default seguro
  assert.equal(snapshots[4].isTeam, false);
  assert.equal(snapshots[4].scope, null);
  assert.equal(snapshots[4].isCustomized, false);

  // Passo 5: Suporte entra -> escopo isolado de suporte
  assert.equal(snapshots[5].isTeam, true);
  assert.notEqual(snapshots[5].scope, snapshots[2].scope);

  // Passo 6: Suporte com contract-trends desmarcado
  assert.equal(snapshots[6].isCustomized, true);
  assert.deepEqual(snapshots[6].visibleWidgets, ["agenda", "revenue"]);

  // Passo 7: Saída imediata de suporte -> volta para User A original com contract-trends
  assert.equal(snapshots[7].scope, snapshots[2].scope);
  assert.deepEqual(snapshots[7].visibleWidgets, ["contract-trends"]);

  // Passo 8: Perda de finance:read -> revenue bloqueado
  assert.ok(!snapshots[8].visibleWidgets.includes("revenue"));

  // Passo 9: Perda de módulo field -> agenda bloqueada
  assert.ok(!snapshots[9].visibleWidgets.includes("agenda"));

  // Passo 11: Após resetPreferences, volta a exibir todos os blocos no padrão
  assert.equal(snapshots[11].isCustomized, false);
  assert.deepEqual(snapshots[11].visibleWidgets, [
    "agenda",
    "contract-trends",
    "revenue",
  ]);
});

test("comportamento resiliente e controles em memória quando Storage falha", () => {
  const faulty = new FaultyStorage();
  const user = createMockSession();

  type Snapshot = {
    step: number;
    isCustomized: boolean;
    storageStatus: string;
    visibleWidgets: OverviewOptionalWidgetId[];
  };

  const snapshots: Snapshot[] = [];

  const steps = [
    // 0: Montagem inicial com Storage defeituoso
    {
      action: (h: ReturnType<typeof useOverviewPreferences>) => {
        // Desmarca revenue
        h.toggleWidget("revenue", false);
      },
    },
    // 1: Observa render com revenue desmarcado em memória
    {
      action: (h: ReturnType<typeof useOverviewPreferences>) => {
        // Desmarca contract-trends
        h.toggleWidget("contract-trends", false);
      },
    },
    // 2: Observa render com apenas agenda
    {
      action: (h: ReturnType<typeof useOverviewPreferences>) => {
        // Restaura padrão em memória
        h.resetPreferences();
      },
    },
    // 3: Observa render final restaurado
    {},
  ];

  let latestHook: ReturnType<typeof useOverviewPreferences> | null = null;

  function FaultyProbe() {
    const [stepIndex, setStepIndex] = useState(0);
    const hook = useOverviewPreferences(user, faulty);
    latestHook = hook;

    snapshots.push({
      step: stepIndex,
      isCustomized: hook.isCustomized,
      storageStatus: hook.storageStatus,
      visibleWidgets: Array.from(hook.visibleWidgets).sort(),
    });

    const step = steps[stepIndex];
    if (step.action) {
      step.action(hook);
    }

    if (stepIndex + 1 < steps.length) {
      setStepIndex(stepIndex + 1);
    }

    return React.createElement(
      "div",
      { "data-step": stepIndex },
      `step=${stepIndex}`,
    );
  }

  // Renderiza toda a sequência de fallback em memória sem lançar exceção
  assert.doesNotThrow(() => {
    renderToStaticMarkup(React.createElement(FaultyProbe));
  });

  // Passo 0: detectou storage indisponível -> fallback seguro para in-memory
  assert.equal(snapshots[0].storageStatus, "in-memory");
  assert.equal(snapshots[0].isCustomized, false);

  // Passo 1: alterou controle sem persistência real -> continua in-memory, altera visualização
  assert.equal(snapshots[1].storageStatus, "in-memory");
  assert.equal(snapshots[1].isCustomized, true);
  assert.deepEqual(snapshots[1].visibleWidgets, [
    "agenda",
    "contract-trends",
  ]);

  // Passo 2: removeu contract-trends -> apenas agenda visível
  assert.equal(snapshots[2].storageStatus, "in-memory");
  assert.deepEqual(snapshots[2].visibleWidgets, ["agenda"]);

  // Passo 3: restaurou padrão em memória
  assert.equal(snapshots[3].storageStatus, "in-memory");
  assert.equal(snapshots[3].isCustomized, false);
  assert.deepEqual(snapshots[3].visibleWidgets, [
    "agenda",
    "contract-trends",
    "revenue",
  ]);

  if (!latestHook) {
    throw new Error("latestHook was not assigned");
  }
  const hookInstance = latestHook as ReturnType<typeof useOverviewPreferences>;
  const controlBtnHtml = renderToStaticMarkup(
    React.createElement(OverviewPreferencesControl, {
      me: user,
      preferences: hookInstance.preferences,
      storageStatus: "in-memory",
      onToggleWidget: () => {},
      onReset: () => {},
    }),
  );
  assert.match(controlBtnHtml, /Personalizar painel/);
  assert.match(controlBtnHtml, /aria-label="Personalizar painel da visão geral"/);

  // Verifica que o formulário OverviewPreferencesForm renderiza os controles acessíveis e mensagem de fallback
  const formHtml = renderToStaticMarkup(
    React.createElement(
      Dialog,
      { open: true },
      React.createElement(OverviewPreferencesForm, {
        me: user,
        preferences: hookInstance.preferences,
        storageStatus: "in-memory",
        onToggleWidget: () => {},
        onReset: () => {},
        onClose: () => {},
      }),
    ),
  );

  // Modal com acessibilidade e mensagem de status em memória
  assert.match(
    formHtml,
    /Armazenamento local indisponível; preferências mantidas apenas em memória nesta sessão\./,
  );
  assert.match(formHtml, /role="status"/);
  assert.match(formHtml, /role="group"/);
  assert.match(formHtml, /id="overview-pref-revenue"/);
  assert.match(formHtml, /id="overview-pref-contract-trends"/);
  assert.match(formHtml, /id="overview-pref-agenda"/);
  assert.match(formHtml, /Restaurar padrão/);
  assert.match(formHtml, /Fechar/);
});

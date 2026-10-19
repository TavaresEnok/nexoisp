import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Componentes de página do v0 que continuam exclusivos da demonstração.
// Cada exceção precisa de um motivo verificável; a lista só deve encolher.
const demoOnly: Record<string, string> = {
  "consolidation-progress.tsx": "evidências da consolidação do cenário fictício",
  "demo-assistant.tsx": "assistente demonstrativo sem modelo ou ferramenta conectados",
  "ip-traceability.tsx": "rastreio sobre o cenário local; a consulta legal real usa contrato e regras próprias do Go",
  "management.tsx": "relatório agregado calculado sobre a amostra fictícia",
  "navigation-directory.tsx": "diretório do catálogo demonstrativo; a operação usa o mapa filtrado por permissão",
  "navigation-scope.tsx": "escopo pendente do catálogo demonstrativo",
  "navigation-views.tsx": "views do roteador demonstrativo",
  "onu-catalog.tsx": "catálogo de modelos e templates de ONU; o Go não possui esse cadastro (recurso planejado)",
  "provisioning-playground.tsx": "simulador explícito de provisionamento, sem equipamento",
  "subscriber-connection.tsx": "análise de evidência manual temporária; a operação usa provisionamento e telemetria reais",
  "subscriber-diagnostic-tools.tsx": "coleta manual simulada da ficha demonstrativa",
  "subscriber-sheet.tsx": "orquestra as abas demonstrativas; cabeçalho, abas e visão geral da ficha vivem em subscriber-sheet-parts.tsx, usado pela operação",
  "subscriber-service.tsx": "registros de atendimento do seed; a operação usa filas paginadas reais",
  "subscriber-technical-panels.tsx": "painéis da análise manual demonstrativa",
  "technical-workspace.tsx": "catálogo técnico lido somente do seed demonstrativo",
  "workspace-data-boundary.tsx": "fronteira do contrato demonstrativo WorkspaceData",
  "workspace-provider.tsx": "provedor do contrato demonstrativo WorkspaceData",
};

const specifier = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
function resolve(from: string, target: string) {
  const base = target.startsWith("@/")
    ? path.resolve(target.slice(2))
    : target.startsWith(".")
      ? path.resolve(path.dirname(from), target)
      : null;
  if (!base) return null;
  return (
    [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`].find(
      (candidate) => existsSync(candidate) && /\.(?:tsx?|json)$/.test(candidate),
    ) ?? null
  );
}
function reachable(entry: string) {
  const seen = new Set<string>();
  const pending = [path.resolve(entry)];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith(".json")) continue;
    for (const match of readFileSync(file, "utf8").matchAll(specifier)) {
      const next = resolve(file, match[1]);
      if (next) pending.push(next);
    }
  }
  return new Set([...seen].map((file) => path.relative(process.cwd(), file)));
}
const operational = reachable("features/operations/application.tsx");
const original = readdirSync("../../docs/novo-design-nexoISP/components").filter(
  (name) => name.endsWith(".tsx"),
);

test("componentes de página do v0 são usados pela aplicação operacional ou têm exceção justificada", () => {
  const missing = original.filter(
    (name) => !operational.has(`components/${name}`) && !demoOnly[name],
  );
  assert.deepEqual(
    missing,
    [],
    "Adapte o componente original do v0 com props em vez de reescrevê-lo em features/.",
  );
});

test("peças extraídas de componentes do v0 continuam em uso pela operação", () => {
  assert.ok(operational.has("components/subscriber-sheet-parts.tsx"));
});

test("exceções demonstrativas não escondem componentes já reaproveitados", () => {
  for (const name of Object.keys(demoOnly)) {
    assert.ok(original.includes(name), `${name} não existe na referência v0`);
    assert.ok(
      !operational.has(`components/${name}`),
      `${name} já é usado na operação: remova-o da lista de exceções`,
    );
  }
});

test("componentes do v0 não dependem dos módulos operacionais", () => {
  // features/workspace e features/technical fazem parte da estrutura original do v0.
  const allowed = /^@\/features\/(?:workspace|technical)\//;
  const files = readdirSync("components", { recursive: true })
    .map(String)
    .filter((name) => /\.tsx?$/.test(name));
  for (const name of files) {
    for (const match of readFileSync(path.join("components", name), "utf8").matchAll(specifier)) {
      const target = match[1];
      if (target.startsWith("@/features/"))
        assert.match(target, allowed, `components/${name} importa ${target}`);
    }
  }
});

test("aplicação operacional não carrega dados nem provedores demonstrativos", () => {
  const demo = [...operational].filter((file) =>
    /^(?:data\/demo\/|lib\/db\/|components\/workspace-provider\.tsx$|features\/workspace\/data-provider\.tsx$)/.test(file),
  );
  assert.deepEqual(demo, []);
});

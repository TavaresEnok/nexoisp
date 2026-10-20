import { readFile, readdir, writeFile } from "node:fs/promises";

// Evidência por unidade da matriz (achado D5 da auditoria independente).
// Cruza os endpoints declarados de cada unidade validada com as chamadas que a
// interface fez durante as verificações dos cenários (rastreio/*.json) e grava
// docs/integracao-v0/evidencias/por-unidade.json. Uso: node e2e/unit-evidence.mjs
const docs = new URL("../docs/integracao-v0/", import.meta.url);
const units = JSON.parse(await readFile(new URL("matriz-funcional.json", docs), "utf8"));
const traceDir = new URL("evidencias/rastreio/", docs);
const traces = [];
for (const file of (await readdir(traceDir)).filter((name) => name.endsWith(".json")).sort())
  traces.push(JSON.parse(await readFile(new URL(file, traceDir), "utf8")));

const endpointPattern = /\b(GET|POST|PUT|PATCH|DELETE) (\/api\/[^\s;,]+)/g;
function matcher(method, path) {
  const source = path
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:\w+/g, "[^/]+");
  const pattern = new RegExp(`^${method} ${source}$`);
  return (request) => pattern.test(request);
}

const result = units
  .filter((unit) => unit.integrationState === "validated")
  .map((unit) => {
    const endpoints = [...(unit.endpoints ?? "").matchAll(endpointPattern)].map(
      ([, method, path]) => ({ endpoint: `${method} ${path}`, test: matcher(method, path) }),
    );
    const checks = [];
    for (const trace of traces)
      for (const step of trace.steps) {
        const matched = endpoints
          .filter(({ test }) => step.requests.some(test))
          .map(({ endpoint }) => endpoint);
        if (matched.length) checks.push({ scenario: trace.scenario, check: step.check, endpoints: matched });
      }
    const exercised = new Set(checks.flatMap((check) => check.endpoints));
    return {
      id: unit.id,
      functionality: unit.functionality,
      declared_endpoints: endpoints.map(({ endpoint }) => endpoint),
      exercised_by_interface: [...exercised].sort(),
      not_exercised_by_interface: endpoints.map(({ endpoint }) => endpoint).filter((endpoint) => !exercised.has(endpoint)),
      checks,
    };
  });

const covered = result.filter((unit) => unit.checks.length).length;
await writeFile(
  new URL("evidencias/por-unidade.json", docs),
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      method: "Chamadas à API feitas pelas páginas entre uma verificação e a anterior, gravadas por e2e/request-trace.mjs durante a fumaça; preparação via context.request não conta.",
      scenarios: traces.map((trace) => ({ scenario: trace.scenario, recorded_at: trace.recorded_at, checks: trace.steps.length })),
      validated_units: result.length,
      units_with_interface_check: covered,
      units: result,
    },
    null,
    2,
  ) + "\n",
);
console.log(`${covered} de ${result.length} unidades validadas têm verificação de interface que chamou um endpoint declarado.`);
for (const unit of result.filter((unit) => !unit.checks.length))
  console.log(`sem verificação: ${unit.id} ${unit.functionality} · ${unit.declared_endpoints.join("; ") || "sem endpoint declarado"}`);

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Evidência por unidade (D5): gerada por e2e/unit-evidence.mjs a partir dos
// rastros da fumaça. Cada unidade validada precisa de ao menos uma verificação
// de interface que chamou um endpoint declarado por ela.
type Unit = { id: string; integrationState: string };
type Evidence = {
  units: { id: string; checks: { scenario: string; check: string }[] }[];
};
const matrix: Unit[] = JSON.parse(
  readFileSync("../../docs/integracao-v0/matriz-funcional.json", "utf8"),
);
const evidence: Evidence = JSON.parse(
  readFileSync("../../docs/integracao-v0/evidencias/por-unidade.json", "utf8"),
);

test("toda unidade validada tem verificação de interface própria", () => {
  const validated = matrix
    .filter((unit) => unit.integrationState === "validated")
    .map((unit) => unit.id)
    .sort();
  assert.deepEqual(evidence.units.map((unit) => unit.id).sort(), validated);
  const missing = evidence.units
    .filter((unit) => !unit.checks.length)
    .map((unit) => unit.id);
  assert.deepEqual(missing, []);
});

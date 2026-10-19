import test from "node:test";
import assert from "node:assert/strict";
import { serializeCsv } from "../domain/csv";
import { copyText, printDocument } from "../platform/browser";

test("CSV usa BOM, escaping, quebras e bloqueio de fórmulas inclusive com espaços", () => {
  const csv = serializeCsv(["Nome", "Valor"], [['José; "A"\nB', 0], ["=1+1", "  @SUM(A1)"], ["+42", "-42"], ["\t=cmd", "normal"]]);
  assert.ok(csv.startsWith('\uFEFF"Nome";"Valor"\r\n'));
  assert.ok(csv.includes('"José; ""A""\nB";"0"'));
  assert.ok(csv.includes('"\'=1+1";"\'  @SUM(A1)"'));
  assert.ok(csv.includes('"\'+42";"\'-42"'));
  assert.equal(serializeCsv(["Cabeçalho"], []), '\uFEFF"Cabeçalho"');
});

test("clipboard só confirma sucesso após resolver e propaga recusa", async () => {
  let copied = "";
  await copyText("conteúdo", { writeText: async value => { copied = value; } });
  assert.equal(copied, "conteúdo");
  await assert.rejects(() => copyText("conteúdo", { writeText: async () => { throw new Error("negado"); } }), /negado/);
});

test("impressão foca o documento e propaga indisponibilidade", () => {
  const calls: string[] = [];
  printDocument({ focus: () => calls.push("focus"), print: () => calls.push("print") });
  assert.deepEqual(calls, ["focus", "print"]);
  assert.throws(() => printDocument(null), /indisponível/);
});

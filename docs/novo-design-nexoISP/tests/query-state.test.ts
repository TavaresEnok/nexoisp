import test from "node:test";
import assert from "node:assert/strict";
import { readQueryValue, updateQueryHref, linkedHref } from "../platform/navigation/query";

test("queries preservam contexto independente, hash, alias e escaping", () => {
  const href = updateQueryHref("https://demo.test/operacoes/?ficha=s1&abaFicha=conexao#lista", { busca: "José & Ana", situacao: "Todas" });
  assert.equal(href, "/operacoes/?ficha=s1&abaFicha=conexao&busca=Jos%C3%A9+%26+Ana&situacao=Todas#lista");
  assert.equal(updateQueryHref(href, { busca: null, situacao: null }), "/operacoes/?ficha=s1&abaFicha=conexao#lista");
  assert.equal(linkedHref("/contratos", { plano: "p/1", assinante: null }), "/contratos?plano=p%2F1");
});

test("enum inválido usa fallback sem deixar painel sem correspondência", () => {
  assert.equal(readQueryValue("invalido", "board", ["board", "list"]), "board");
  assert.equal(readQueryValue("list", "board", ["board", "list"]), "list");
  assert.equal(readQueryValue(null, "board", ["board", "list"]), "board");
  assert.equal(readQueryValue("busca livre", ""), "busca livre");
});

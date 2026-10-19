import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DemoAssistant } from "../components/demo-assistant";
import { isDemoMode } from "../application/execution-mode";

test("entradas do assistente demo apresentam título semântico sem iniciar o agente", { skip: !isDemoMode }, () => {
  const html = renderToStaticMarkup(DemoAssistant());
  assert.match(html, /<h1>Assistente indisponível no modo demonstrativo local<\/h1>/);
  assert.match(html, /não envia mensagens/);
  assert.doesNotMatch(html, /<form|<textarea/);
});

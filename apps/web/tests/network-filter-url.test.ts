import test from "node:test";
import assert from "node:assert/strict";
import { readNetworkFilters, networkFilterKeys } from "../domain/network-filters";
import { updateQueryHref } from "../platform/navigation/query";

test("visibilidade do mapa é serializada e recuperável após reload", () => {
  assert.ok(networkFilterKeys.includes("visibility"));
  const href = updateQueryHref("/rede/mapa?ficha=sub-1", { rede_visibility: "offline", rede_pop: "POP Norte" });
  const filters = readNetworkFilters(new URL(href, "https://demo.test").searchParams, { visibility: "all" });
  assert.deepEqual(filters, { visibility: "offline", pop: "POP Norte" });
});

test("booleanos inválidos não se tornam false e enum inválido mantém padrão", () => {
  const filters = readNetworkFilters(new URLSearchParams("rede_visibility=inválido&rede_ipv6=foo&rede_onu=yes&rede_fixedIp=no&rede_login=" + "a".repeat(600)), { visibility: "online" });
  assert.equal(filters.visibility, "online");
  assert.equal(filters.ipv6, undefined);
  assert.equal(filters.onu, "yes");
  assert.equal(filters.fixedIp, "no");
  assert.equal(filters.login?.length, 500);
});

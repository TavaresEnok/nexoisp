import test from "node:test";
import assert from "node:assert/strict";
import {
  endpointFields,
  endpointValue,
  formatPathText,
  parseEventsText,
  parsePathText,
  pathLength,
} from "../features/network/ftth-design-models";

test("traçado aceita uma coordenada por linha e recusa limites inválidos", () => {
  const path = parsePathText("-3.0, -38.0\n\n -3.001;-38.0 \n-3.002 -38.0");
  assert.deepEqual(path, [
    { lat: -3, lng: -38 },
    { lat: -3.001, lng: -38 },
    { lat: -3.002, lng: -38 },
  ]);
  assert.deepEqual(parsePathText(formatPathText(path)), path);
  for (const text of [
    "-3, -38",
    "91, 0\n0, 0",
    "0, 181\n0, 0",
    "0, 0, 5\n1, 1",
    "a, b\n0, 0",
    Array.from({ length: 501 }, (_, i) => `0, ${i / 1000}`).join("\n"),
  ])
    assert.throws(() => parsePathText(text));
});

test("comprimento usa haversine com duas casas, como o servidor", () => {
  assert.equal(
    pathLength([
      { lat: 0, lng: 0 },
      { lat: 0.001, lng: 0 },
    ]),
    111.2,
  );
  assert.equal(pathLength([{ lat: 0, lng: 0 }]), 0);
});

test("pontas do cabo: caixa ou local, nunca os dois", () => {
  assert.equal(endpointValue("b1", null), "box:b1");
  assert.equal(endpointValue(null, "s1"), "site:s1");
  assert.equal(endpointValue(null, null), "");
  assert.deepEqual(endpointFields("a", "box:b1"), {
    a_box_id: "b1",
    a_site_id: null,
  });
  assert.deepEqual(endpointFields("b", ""), {
    b_box_id: null,
    b_site_id: null,
  });
});

test("eventos OTDR aceitam rótulo ou código e recusam tipo desconhecido", () => {
  assert.deepEqual(parseEventsText("100; 0,3; Conector\n600;0.05;splice"), [
    { distance_m: 100, loss_db: 0.3, type: "connector" },
    { distance_m: 600, loss_db: 0.05, type: "splice" },
  ]);
  assert.deepEqual(parseEventsText(""), []);
  assert.throws(() => parseEventsText("100; 0,3; emenda"));
  assert.throws(() => parseEventsText("-1; 0,3; Fusão"));
});

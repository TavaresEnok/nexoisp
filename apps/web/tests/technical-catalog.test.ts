import test from "node:test";
import assert from "node:assert/strict";
import { rangeSize, cgnatCapacity, compileProvisioning, type CliVariables } from "../lib/technical-catalog";
import { findNavigationPage } from "../lib/navigation";

const variables: CliVariables = { vlan: "901", slot: "0", pon: "1", sn: "HWTC00000001", login: "assinante.lab" };
test("faixas IPv4 contam total bruto sem perda de precisão", () => {
  assert.equal(rangeSize("100.64.0.0/24"), 256);
  assert.equal(rangeSize("100.64.0.0/20\n100.64.24.0/22"), 5120);
  assert.equal(rangeSize("192.0.2.10-192.0.2.13"), 4);
  assert.equal(rangeSize("0.0.0.0/0"), 4294967296);
  assert.equal(rangeSize("255.255.255.255/32"), 1);
  assert.equal(rangeSize("192.0.2.0/31"), 2);
});
test("faixas inválidas, sobrepostas ou invertidas são rejeitadas", () => {
  for (const value of ["", "300.0.0.1", "10.0.0.0/33", "10.0.0.0/24\n10.0.0.1", "192.0.2.20-192.0.2.10", "10.0.0.0/24/4", "192.0.2.1-"]) assert.throws(() => rangeSize(value));
});
test("CGNAT usa blocos inteiros e identifica déficit sem duplicar TCP/UDP", () => {
  const plan = { publicRange: "192.0.2.10-192.0.2.13", privateRange: "100.64.0.0/24", firstPort: 1024, lastPort: 65535, portsPerIp: 1024 };
  assert.deepEqual(cgnatCapacity(plan), { publicIps: 4, privateIps: 256, blocksPerIp: 63, capacity: 252, remainder: 0, deficit: 4 });
  assert.equal(cgnatCapacity({ ...plan, portsPerIp: 512 }).capacity, 504);
  assert.equal(cgnatCapacity({ ...plan, portsPerIp: 512 }).deficit, 0);
  for (const ports of [{ firstPort: 65536 }, { lastPort: 0 }, { portsPerIp: 0 }, { portsPerIp: 99999 }]) assert.throws(() => cgnatCapacity({ ...plan, ...ports }));
});
test("testador substitui apenas variáveis reconhecidas e todas as ocorrências", () => {
  const result = compileProvisioning("vlan %vlan% serial %sn% slot %slot% pon %pon% login %login% vlan %vlan%", variables);
  assert.equal(result.errors.length, 0);
  assert.equal(result.output, "vlan 901 serial HWTC00000001 slot 0 pon 1 login assinante.lab vlan 901");
  assert.equal(result.used.length, 5);
});
test("testador bloqueia variáveis desconhecidas, parâmetros ausentes e injeção", () => {
  for (const [source, values] of [["%senha%", variables], ["%vlan%", { ...variables, vlan: "4095" }], ["%vlan%", { ...variables, vlan: "1.5" }], ["%sn%", { ...variables, sn: "" }], ["%login%", { ...variables, login: "teste\nreboot" }], ["%pon%", { ...variables, pon: "256" }], ["%slot%", { ...variables, slot: "32" }], ["", variables]] as const) {
    const result = compileProvisioning(source, values);
    assert.equal(result.output, "");
    assert.ok(result.errors.length > 0);
  }
});
test("rotas técnicas apontam para consultas sem habilitar ações remotas", () => {
  for (const [href, view] of [["/rede/ftth/fttx-onu-tipo", "network-onu-models"], ["/rede/ftth/fttx-onu-template", "network-onu-templates"], ["/rede/enderecos-ip", "network-pools"], ["/rede/enderecos-ip/blocos-de-enderecos", "network-pools"], ["/rede/enderecos-ip/planos-de-cgnat", "network-cgnat"], ["/rede/equipamentos/concentradores", "network-nas"]]) assert.equal(findNavigationPage(href)?.view, view);
  assert.equal(findNavigationPage("/rede/equipamentos/concentradores/trocar-segredo")?.view, undefined);
});

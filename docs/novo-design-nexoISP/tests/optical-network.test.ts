import test from "node:test";
import assert from "node:assert/strict";
import { groupOpticalPorts, averageOpticalSignal } from "../lib/optical-network";
import { parseIpTargets, findCurrentIpAssignments } from "../lib/ip-traceability";
import type { Subscriber } from "../lib/types";

const subscriber: Subscriber = { id: "sub-1", code: "1", name: "Assinante teste", email: "", phone: "", document: "", plan: "", speed: 100, price: 0, status: "Ativo", connection: "Online", neighborhood: "", address: "", pop: "POP Centro", signal: -20, since: "", dueDay: 10, contract: "CT-1", onu: "ONU-1", nas: "NAS-1", access: { olt: "OLT-1", oltSlot: "1", pon: "2", ip: "100.64.20.10" } };
test("PONs exigem caminho completo e não presumem slot ou OLT pelo POP", () => {
  const rows = groupOpticalPorts([subscriber, { ...subscriber, id: "sub-2" }, { ...subscriber, id: "sub-3", access: { olt: "OLT-1", pon: "2" } }, { ...subscriber, id: "sub-4", access: undefined }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subscribers.length, 2);
  assert.equal(rows[0].slot, "1");
  assert.equal(groupOpticalPorts([]).length, 0);
});
test("caminhos diferentes não compartilham portas", () => {
  assert.equal(groupOpticalPorts([subscriber, { ...subscriber, access: { olt: "OLT-2", oltSlot: "1", pon: "2" } }, { ...subscriber, access: { olt: "OLT-1", oltSlot: "2", pon: "2" } }]).length, 3);
});
test("RX médio usa apenas ONUs online com leitura negativa válida", () => {
  assert.equal(averageOpticalSignal([subscriber, { ...subscriber, signal: -24 }]), -22);
  assert.equal(averageOpticalSignal([{ ...subscriber, connection: "Offline" }, { ...subscriber, signal: 0 }, { ...subscriber, signal: NaN }, { ...subscriber, onu: "" }]), null);
});
test("IP valida entradas, limite, duplicatas e CIDR antes de pesquisar", () => {
  assert.deepEqual(parseIpTargets("100.64.20.10\n100.64.20.10, 100.64.0.0/16").targets, ["100.64.20.10", "100.64.0.0/16"]);
  for (const value of ["", "999.1.1.1", "100.64.0.0/33", Array.from({ length: 101 }, (_, i) => `10.0.0.${i}`).join("\n")]) assert.ok(parseIpTargets(value).error);
});
test("vínculos atuais não inventam IPs nem ignoram filtro online", () => {
  const rows = [subscriber, { ...subscriber, id: "off", connection: "Offline" }, { ...subscriber, id: "missing", access: undefined }];
  assert.equal(findCurrentIpAssignments(rows, ["100.64.0.0/16"], false).length, 2);
  assert.equal(findCurrentIpAssignments(rows, ["100.64.0.0/16"], true).length, 1);
  assert.equal(findCurrentIpAssignments(rows, ["100.64.20.11"], false).length, 0);
  assert.equal(findCurrentIpAssignments(rows, [], false).length, 0);
});

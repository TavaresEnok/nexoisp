import assert from "node:assert/strict";
import test from "node:test";
import { buildHuaweiDiagnosticScript, parseHuaweiEvidence, parseRadiusEvidence, durationLabel, byteLabel, MAX_EVIDENCE_LENGTH } from "../lib/subscriber-diagnostics";

const serial = "ALCLFCBEAB3C";
const raw = `SN : 414C434CFCBEAB3C (ALCL-FCBEAB3C)
F/S/P : 0/1/10
ONT-ID : 3
Run state : online
Rx optical power(dBm) : -28.24
Tx optical power(dBm) : 2.68
OLT Rx ONT optical power(dBm) : -27.45
Temperature(C) : 55
Voltage(V) : 3.280
Laser bias current(mA) : 18
ONT distance(m) : 4217
Last down cause : dying-gasp
Last up time : 2026-06-08 21:34:38+08:00`;

test("Huawei interpreta óptica, estado e serial hexadecimal equivalente", () => {
  const result = parseHuaweiEvidence(raw, serial);
  assert.equal(result.rx, -28.24);
  assert.equal(result.tx, 2.68);
  assert.equal(result.oltRx, -27.45);
  assert.equal(result.voltage, 3.28);
  assert.equal(result.distance, 4217);
  assert.equal(result.fields["last down cause"], "dying-gasp");
});
test("Huawei recusa outra ONU, identidade ausente e coletas conflitantes", () => {
  assert.throws(() => parseHuaweiEvidence(raw, "ALCL12345678"), /serial/);
  assert.throws(() => parseHuaweiEvidence("Run state : online", serial), /SN/);
  assert.throws(() => parseHuaweiEvidence(raw + "\nRun state : offline", serial), /valores diferentes/);
  assert.throws(() => parseHuaweiEvidence("x".repeat(MAX_EVIDENCE_LENGTH + 1), serial));
});
test("Huawei não transforma campos ausentes em zero nem limiares em métricas", () => {
  const result = parseHuaweiEvidence(`SN : ${serial}\nRx optical power(dBm) : -\nRx power current alarm threshold(dBm) : [-30,-8]`, serial);
  assert.equal(result.rx, undefined);
  assert.equal(result.temperature, undefined);
});
test("bloco Huawei contém somente navegação e consultas com números validados", () => {
  const script = buildHuaweiDiagnosticScript(serial, { frame: "0", slot: "01", pon: "10", ontId: "3" });
  assert.match(script, /interface gpon 0\/1\ndisplay ont info 10 3/);
  assert.match(script, /display ont optical-info 10 3/);
  assert.match(script, /display ont version 10 3/);
  assert.doesNotMatch(script, /reset|delete|shutdown/);
  for (const value of ["1\nreset", "-1", "32", ""]) assert.throws(() => buildHuaweiDiagnosticScript(serial, { frame: "0", slot: "1", pon: value, ontId: "3" }));
});
const session = { username: "cliente", acctsessionid: "sessao-1", acctstarttime: "2026-10-17T13:00:00-03:00", acctstoptime: null, acctsessiontime: 3660, nasipaddress: "192.0.2.10", framedipaddress: "100.64.0.1", acctinputoctets: 1024, acctoutputoctets: 2048 };
test("RADIUS valida, ordena e preserva a perspectiva dos contadores", () => {
  const records = parseRadiusEvidence(JSON.stringify([session, { ...session, acctsessionid: "sessao-2", acctstarttime: "2026-10-17T14:00:00-03:00" }]), "cliente");
  assert.equal(records[0].acctsessionid, "sessao-2");
  assert.equal(records[0].acctinputoctets, 1024);
  assert.equal(records[0].acctstoptime, null);
});
test("RADIUS recusa outro login, duplicidade, IP, tempo, contadores e identificadores inválidos", () => {
  assert.throws(() => parseRadiusEvidence(JSON.stringify([session]), "outro"));
  assert.throws(() => parseRadiusEvidence(JSON.stringify([session, session]), "cliente"));
  for (const change of [{ nasipaddress: "inválido" }, { acctstoptime: "2026-10-16T00:00:00Z" }, { acctinputoctets: -1 }, { acctsessionid: "" }, { acctstarttime: "2026-10-17 13:00" }]) assert.throws(() => parseRadiusEvidence(JSON.stringify([{ ...session, ...change }]), "cliente"));
  assert.throws(() => parseRadiusEvidence("[]", "cliente"));
  assert.throws(() => parseRadiusEvidence("inválido", "cliente"));
});
test("formatadores distinguem ausência de zero", () => {
  assert.equal(durationLabel(undefined), "—");
  assert.equal(durationLabel(90060), "1d 1h 1min");
  assert.equal(byteLabel(undefined), "—");
  assert.equal(byteLabel(0), "0 B");
  assert.equal(byteLabel(1024), "1 KiB");
});

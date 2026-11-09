import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFieldAction,
  discardFieldAction,
  enqueueFieldAction,
  fieldQueueKey,
  flushFieldQueue,
  pendingPresence,
  readFieldQueue,
  transientFailure,
  type FieldAction,
} from "../features/field/field-queue";
import {
  fitWithin,
  photoMaxBytes,
  photoName,
  reducePhoto,
  type DecodedImage,
} from "../features/field/image-reduce";
import {
  describeLocation,
  formatDistance,
  formatDuration,
  safePngDataUrl,
} from "../features/field/field-model";
import { ApiError } from "../data/erp/http";
import { buildWorkOrderPrintDocument } from "../lib/work-order-print";

const order = { id: "11111111-1111-4111-8111-111111111111", number: 42 };
const other = { id: "22222222-2222-4222-8222-222222222222", number: 43 };
const keys = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
];
const now = new Date("2026-11-09T10:00:00.000Z");

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    } as Storage,
  };
}
function serialLocks() {
  let queue = Promise.resolve();
  return {
    request: (_key: string, callback: () => unknown) => {
      const result = queue.then(callback);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  } as unknown as LockManager;
}

test("ações de campo levam chave, horário do aparelho e corpo exato do servidor", () => {
  const checkIn = buildFieldAction(
    order,
    { kind: "check_in", location: { latitude: -3.73, longitude: -38.52, accuracy_m: 12.34 } },
    keys[0],
    now,
  );
  assert.equal(checkIn.path, `/work-orders/${order.id}/check-in`);
  assert.deepEqual(checkIn.body, {
    idempotency_key: keys[0],
    device_at: now.toISOString(),
    latitude: -3.73,
    longitude: -38.52,
    accuracy_m: 12.3,
  });
  assert.equal(checkIn.state, "pending");
  const out = buildFieldAction(order, { kind: "check_out", location: null }, keys[1], now);
  assert.deepEqual(Object.keys(out.body).sort(), ["device_at", "idempotency_key"]);
  assert.deepEqual(
    buildFieldAction(order, { kind: "note", note: "  Cliente ausente  " }, keys[2], now).body,
    { note: "Cliente ausente", idempotency_key: keys[2], device_at: now.toISOString() },
  );
  const item = buildFieldAction(order, { kind: "checklist_done", item_id: "17", done: true }, keys[3], now);
  assert.equal(item.path, `/work-orders/${order.id}/checklist/17`);
  assert.equal(
    buildFieldAction(order, { kind: "checklist_add", label: "Medir potência" }, keys[3], now).path,
    `/work-orders/${order.id}/checklist`,
  );
  assert.throws(() => buildFieldAction(order, { kind: "note", note: " " }, keys[0], now));
  assert.throws(() => buildFieldAction(order, { kind: "checklist_add", label: "x" }, keys[0], now));
  assert.throws(() => buildFieldAction(order, { kind: "check_in", location: { latitude: 91, longitude: 0 } }, keys[0], now));
  assert.throws(() => buildFieldAction({ id: "../x", number: 1 }, { kind: "check_out" }, keys[0], now));
  assert.throws(() => buildFieldAction(order, { kind: "check_out" }, "chave", now));
});

test("fila isolada por sessão, sem duplicar chave e com leitura defensiva", async () => {
  const { storage, values } = memoryStorage();
  const locks = serialLocks();
  const key = fieldQueueKey("user:tenant");
  const first = buildFieldAction(order, { kind: "note", note: "A" }, keys[0], now);
  await enqueueFieldAction(storage, locks, key, first);
  await enqueueFieldAction(storage, locks, key, first);
  assert.equal(readFieldQueue(storage, key).length, 1);
  assert.deepEqual(readFieldQueue(storage, fieldQueueKey("other:tenant")), []);
  await assert.rejects(enqueueFieldAction(storage, undefined, key, first), /Coordenação/);
  values.set(key, JSON.stringify([{ ...first, path: "/subscribers/x" }]));
  assert.throws(() => readFieldQueue(storage, key), /inválida/);
  values.set(key, JSON.stringify([{ ...first, body: { ...first.body, idempotency_key: keys[1] } }]));
  assert.throws(() => readFieldQueue(storage, key), /inválida/);
  values.set(key, "{");
  assert.throws(() => readFieldQueue(storage, key));
});

test("envio em ordem: confirmados saem da fila, recusa guarda motivo, falha de rede interrompe", async () => {
  const { storage, values } = memoryStorage();
  const locks = serialLocks();
  const key = fieldQueueKey("user:tenant");
  const actions = [
    buildFieldAction(order, { kind: "check_in" }, keys[0], now),
    buildFieldAction(order, { kind: "note", note: "Recusada" }, keys[1], now),
    buildFieldAction(other, { kind: "note", note: "Rede" }, keys[2], now),
    buildFieldAction(other, { kind: "check_out" }, keys[3], now),
  ];
  for (const action of actions) await enqueueFieldAction(storage, locks, key, action);
  const calls: string[] = [];
  const states: string[][] = [];
  const result = await flushFieldQueue({
    storage,
    locks,
    key,
    onChange: (items) => states.push(items.map((item) => item.state)),
    send: async (path, body) => {
      calls.push(`${path}:${String(body.idempotency_key)}`);
      if (body.idempotency_key === keys[1]) throw new ApiError(409, "ordem de serviço encerrada não aceita check-in");
      if (body.idempotency_key === keys[2]) throw new ApiError(0, "Não foi possível conectar ao servidor. Tente novamente.");
      return { ok: true };
    },
  });
  assert.deepEqual(calls.map((call) => call.split(":")[1]), [keys[0], keys[1], keys[2]]);
  assert.deepEqual(result.sent.map((action) => action.key), [keys[0]]);
  assert.deepEqual(result.refused.map((action) => action.reason), ["ordem de serviço encerrada não aceita check-in"]);
  assert.equal(result.interrupted, true);
  assert.equal(result.pending, 2);
  assert.ok(states.some((items) => items.includes("sending")));
  const stored = readFieldQueue(storage, key);
  assert.deepEqual(stored.map((item) => [item.key, item.state]), [
    [keys[1], "refused"],
    [keys[2], "pending"],
    [keys[3], "pending"],
  ]);
  // Reenvio manual: a recusa não é reenviada; o restante segue com as mesmas chaves.
  const again: string[] = [];
  const second = await flushFieldQueue({ storage, locks, key, send: async (_path, body) => { again.push(String(body.idempotency_key)); } });
  assert.deepEqual(again, [keys[2], keys[3]]);
  assert.equal(second.pending, 0);
  await discardFieldAction(storage, locks, key, keys[1]);
  assert.equal(values.has(key), false, "fila vazia é removida do armazenamento");
});

test("envio interrompido no meio é reenviado com a mesma chave e duas abas não enviam em dobro", async () => {
  const { storage, values } = memoryStorage();
  const locks = serialLocks();
  const key = fieldQueueKey("user:tenant");
  const action = buildFieldAction(order, { kind: "note", note: "Nota" }, keys[0], now);
  values.set(key, JSON.stringify([{ ...action, state: "sending" } satisfies FieldAction]));
  const seen: string[] = [];
  const send = async (_path: string, body: Record<string, unknown>) => {
    seen.push(String(body.idempotency_key));
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const [a, b] = await Promise.all([
    flushFieldQueue({ storage, locks, key, send }),
    flushFieldQueue({ storage, locks, key, send }),
  ]);
  assert.deepEqual(seen, [keys[0]]);
  assert.equal(a.sent.length + b.sent.length, 1);
  assert.equal(values.has(key), false);
});

test("falhas transitórias não viram recusa", () => {
  assert.equal(transientFailure(new ApiError(0, "rede")), true);
  assert.equal(transientFailure(new ApiError(503, "indisponível")), true);
  assert.equal(transientFailure(new ApiError(429, "limite")), true);
  assert.equal(transientFailure(new ApiError(409, "A sessão mudou. Entre novamente e refaça a operação.")), true);
  assert.equal(transientFailure(new TypeError("Failed to fetch")), true);
  assert.equal(transientFailure(new ApiError(409, "você já tem check-in aberto nesta OS")), false);
  assert.equal(transientFailure(new ApiError(403, "apenas o técnico atribuído")), false);
  assert.equal(transientFailure(new ApiError(400, "latitude entre -90 e 90")), false);
});

test("presença pendente considera a ordem das ações e ignora recusas", () => {
  const checkIn = buildFieldAction(order, { kind: "check_in" }, keys[0], now);
  const checkOut = buildFieldAction(order, { kind: "check_out" }, keys[1], now);
  assert.deepEqual(pendingPresence([checkIn], order.id), { checkIn: true, checkOut: false });
  assert.deepEqual(pendingPresence([checkIn, checkOut], order.id), { checkIn: true, checkOut: true });
  assert.deepEqual(pendingPresence([checkOut, { ...checkIn, key: keys[2] }], order.id), { checkIn: true, checkOut: false });
  assert.deepEqual(pendingPresence([{ ...checkIn, state: "refused" }], order.id), { checkIn: false, checkOut: false });
  assert.deepEqual(pendingPresence([checkIn], other.id), { checkIn: false, checkOut: false });
});

test("redução de foto limita o lado maior a 1920 px, gera JPEG e libera a imagem", async () => {
  assert.deepEqual(fitWithin(4000, 3000), { width: 1920, height: 1440 });
  assert.deepEqual(fitWithin(3000, 4000), { width: 1440, height: 1920 });
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
  assert.throws(() => fitWithin(0, 10));
  assert.equal(photoName(new Date(2026, 10, 9, 8, 5, 3)), "foto-20261109-080503.jpg");
  let closed = 0;
  const encoded: { width: number; height: number; quality: number }[] = [];
  const image: DecodedImage = { width: 4032, height: 3024, close: () => closed++ };
  const sizes = [photoMaxBytes + 1, 3 * 1024 * 1024];
  const result = await reducePhoto(new Blob(["x"], { type: "image/heic" }), {
    decode: async () => image,
    encode: async (_image, width, height, quality) => {
      encoded.push({ width, height, quality });
      return new Blob([new Uint8Array(sizes.shift()!)], { type: "image/jpeg" });
    },
  });
  assert.equal(result.blob.type, "image/jpeg");
  assert.deepEqual([result.width, result.height], [1920, 1440]);
  assert.deepEqual(encoded.map((call) => call.quality), [0.85, 0.72]);
  assert.equal(closed, 1);
  await assert.rejects(
    reducePhoto(new Blob(["%PDF"], { type: "application/pdf" }), { decode: async () => image, encode: async () => new Blob() }),
    /foto da câmera/,
  );
  await assert.rejects(
    reducePhoto(new Blob(["x"], { type: "image/jpeg" }), { decode: async () => { throw new Error("corrompida"); }, encode: async () => new Blob() }),
    /Não foi possível ler a foto/,
  );
  await assert.rejects(
    reducePhoto(new Blob(["x"], { type: "image/jpeg" }), { decode: async () => ({ ...image, close: () => closed++ }), encode: async () => new Blob(["x"], { type: "image/png" }) }),
    /JPEG/,
  );
  assert.equal(closed, 2);
});

test("formatação da presença e validação da imagem da assinatura", () => {
  assert.equal(formatDuration(30), "menos de 1 min");
  assert.equal(formatDuration(25 * 60), "25 min");
  assert.equal(formatDuration(65 * 60), "1 h 05 min");
  assert.equal(formatDistance(35.4), "35 m");
  assert.equal(formatDistance(1250), "1,3 km");
  assert.equal(describeLocation(false, null, null, true), "Localização não enviada");
  assert.equal(describeLocation(true, 120, 10, true), "A 120 m da instalação (precisão de 10 m)");
  assert.match(describeLocation(true, null, null, false), /instalação sem coordenada/);
  assert.equal(safePngDataUrl("data:image/png;base64,iVBORw0KGgo="), "data:image/png;base64,iVBORw0KGgo=");
  assert.equal(safePngDataUrl('data:image/png;base64,AAA" onerror="x'), undefined);
  assert.equal(safePngDataUrl("data:image/svg+xml;base64,PHN2Zz4="), undefined);
});

test("ficha impressa traz presença e assinatura eletrônica apenas em PNG válido", () => {
  const workOrder = { id: "os", code: 77, subscriberId: "s1", name: "Titular", type: "Instalação", technician: "Técnico Campo", time: "09/11, 10:00", status: "Concluída", neighborhood: "Centro", duration: 60, notes: "nota interna", late: false } as Parameters<typeof buildWorkOrderPrintDocument>[0];
  const subscriber = { id: "s1", name: "Titular", code: "s1", address: "Rua A", phone: "" };
  const base = { operational: true, contractId: "c1", serviceAddress: "Rua A, 1" };
  const plain = buildWorkOrderPrintDocument(workOrder, subscriber, "Provedor", now.toISOString(), base);
  assert.match(plain, /Cliente · assinatura manual/);
  assert.match(plain, /nem assinatura eletrônica/);
  assert.doesNotMatch(plain, /<img/);
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const signed = buildWorkOrderPrintDocument(workOrder, subscriber, "Provedor", now.toISOString(), {
    ...base,
    visits: { attendanceSeconds: 3900, items: [{ technician: "Técnico <b>", checkIn: now.toISOString(), checkOut: null }] },
    signature: { signerName: "Maria <Cliente>", signerDocument: "123.456.789-09", signedAt: now.toISOString(), sha256: "a".repeat(64), image: png },
  });
  assert.match(signed, /assinatura eletrônica de Maria &lt;Cliente&gt;/);
  assert.match(signed, /documento 123\.456\.789-09/);
  assert.match(signed, new RegExp(`<img src="${png.replace(/[+/]/g, "\\$&")}" alt="Assinatura do cliente">`));
  assert.match(signed, /SHA-256 a{64}/);
  assert.match(signed, /Tempo em atendimento/);
  assert.match(signed, /1 h 05 min/);
  assert.match(signed, /Técnico &lt;b&gt;: .* até em atendimento/);
  assert.doesNotMatch(signed, /Cliente · assinatura manual|nota interna|<b>/);
  const forged = buildWorkOrderPrintDocument(workOrder, subscriber, "Provedor", now.toISOString(), {
    ...base,
    signature: { signerName: "Maria", signerDocument: null, signedAt: now.toISOString(), sha256: "b".repeat(64), image: 'data:image/png;base64,AA" onerror="alert(1)' },
  });
  assert.doesNotMatch(forged, /<img|onerror/);
  assert.match(forged, /assinatura eletrônica de Maria/);
  const demo = buildWorkOrderPrintDocument(workOrder, subscriber, "Provedor", now.toISOString(), {
    signature: { signerName: "Maria", signerDocument: null, signedAt: now.toISOString(), sha256: "c".repeat(64), image: png },
  });
  assert.doesNotMatch(demo, /assinatura eletrônica de/, "ficha demonstrativa não exibe assinatura");
});

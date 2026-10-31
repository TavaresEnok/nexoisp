import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireMaterialIntent, materialIntentKey, readMaterialIntent, saveMaterialIntent, settleMaterialIntent } from "../features/field/material-intent";

test("persistência, isolamento e falha de armazenamento", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } as Storage;
  const a = materialIntentKey("tenant:user", "os1");
  const intent = { intention_id: "11111111-1111-4111-8111-111111111111", item_id: "22222222-2222-4222-8222-222222222222", qty: 2 };
  saveMaterialIntent(storage, a, intent);
  assert.deepEqual(readMaterialIntent(storage, a), intent);
  assert.equal(readMaterialIntent(storage, materialIntentKey("other:user", "os1")), null);
  assert.equal(readMaterialIntent(storage, materialIntentKey("tenant:user", "os2")), null);
  assert.throws(() => saveMaterialIntent({ ...storage, setItem: () => { throw new Error("quota"); } }, a, intent));
});

test("duas abas serializam criação e replay tardio preserva intenção posterior", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } as Storage;
  let queue = Promise.resolve();
  const locks = { request: (_key: string, callback: () => unknown) => {
    const result = queue.then(callback);
    queue = result.then(() => undefined, () => undefined);
    return result;
  } } as unknown as LockManager;
  const key = materialIntentKey("tenant:user", "os1");
  const first = { intention_id: "11111111-1111-4111-8111-111111111111", item_id: "22222222-2222-4222-8222-222222222222", qty: 2 };
  const second = { ...first, intention_id: "33333333-3333-4333-8333-333333333333" };
  const [tabA, tabB] = await Promise.all([
    acquireMaterialIntent(storage, locks, key, () => first),
    acquireMaterialIntent(storage, locks, key, () => second),
  ]);
  assert.deepEqual(tabA, first);
  assert.deepEqual(tabB, first);
  assert.equal(await settleMaterialIntent(storage, locks, key, tabA.intention_id), null);
  assert.deepEqual(await acquireMaterialIntent(storage, locks, key, () => second), second);
  assert.deepEqual(await settleMaterialIntent(storage, locks, key, tabB.intention_id), second);
  assert.deepEqual(readMaterialIntent(storage, key), second); // reload após resposta perdida
  await assert.rejects(acquireMaterialIntent(storage, undefined, key, () => first));
});

import assert from "node:assert/strict";
import test from "node:test";
import { attachmentActions, validateAttachment } from "../features/field/work-attachments-model";

test("ações de anexos acompanham o encerramento da OS e as permissões do servidor", () => {
  const allowed = { can_upload: true, can_delete: true };
  assert.deepEqual(attachmentActions("in_progress", true, allowed), { upload: true, delete: true });
  for (const status of ["done", "canceled"]) {
    assert.deepEqual(attachmentActions(status, true, allowed), { upload: false, delete: false });
  }
  assert.deepEqual(attachmentActions("open", true, { can_upload: false, can_delete: true }), { upload: false, delete: true });
  assert.deepEqual(attachmentActions("open", false, allowed), { upload: false, delete: false });
  assert.deepEqual(attachmentActions("open", true), { upload: false, delete: false });
});

test("validação aceita somente fotos e PDFs dentro do limite", () => {
  assert.equal(validateAttachment({ name: "visita.png", type: "image/png", size: 5 * 1024 * 1024 } as File), null);
  assert.ok(validateAttachment({ name: "visita.png", type: "image/png", size: 5 * 1024 * 1024 + 1 } as File));
  assert.ok(validateAttachment({ name: "visita.txt", type: "text/plain", size: 1 } as File));
});

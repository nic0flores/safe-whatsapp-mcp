import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SafeWhatsAppApplication } from "../dist/application.js";
import { approvalPreviewFor, digestSend } from "../dist/replies/digest.js";
import { FilePendingSendStore } from "../dist/replies/pendingStore.js";
import { StatePaths } from "../dist/storage/paths.js";

test("application composition is offline until paired and releases its state lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-app-"));
  const paths = new StatePaths(path.join(root, "state"));
  const application = await SafeWhatsAppApplication.open({ paths });
  try {
    const status = await application.services.reader.getStatus();
    assert.equal(status.paired, false);
    assert.equal(status.connected, false);
    assert.equal(status.credentialsAtRest, "aes-256-gcm+os-credential-vault");
    assert.equal(status.messageCacheAtRest, "aes-256-gcm+os-cache-vault");
    assert.equal(status.chatAccessPolicy, "explicit-direct-e164-allowlist-before-persistence");
    assert.equal(status.transport, "unofficial-baileys");
    assert.equal(status.sendEnabled, false);
    await assert.rejects(
      application.services.reader.listChats({ kind: "all", limit: 10 }),
      (error) => error.code === "pairing_required",
    );
  } finally {
    await application.close();
  }

  const reopened = await SafeWhatsAppApplication.open({ paths });
  await reopened.close();
});

test("application startup expires and redacts an abandoned prepared send", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-app-expiry-"));
  const paths = new StatePaths(path.join(root, "state"));
  const pendingId = "11111111-1111-4111-8111-111111111111";
  const now = Date.now();
  const payload = {
    kind: "text",
    destination: {
      chatId: "group-1",
      transportJid: "100000000000@g.us",
      kind: "group",
      displayName: "Private group",
    },
    text: "abandoned private draft",
  };
  const approvalPreview = approvalPreviewFor(payload, pendingId);
  const store = new FilePendingSendStore(paths.pendingDir);
  await store.create({
    id: pendingId,
    state: "prepared",
    messageKind: "text",
    destinationKind: "group",
    payload,
    digest: digestSend(payload, approvalPreview, pendingId),
    approvalPreview,
    createdAt: new Date(now - 11 * 60_000).toISOString(),
    updatedAt: new Date(now - 11 * 60_000).toISOString(),
    expiresAt: new Date(now - 60_000).toISOString(),
  });

  const application = await SafeWhatsAppApplication.open({ paths });
  try {
    const expired = await store.get(pendingId);
    assert.equal(expired.state, "expired");
    assert.equal(expired.payload, null);
    assert.equal(expired.approvalPreview, null);
    assert.equal(JSON.stringify(expired).includes("abandoned private draft"), false);
    assert.equal(JSON.stringify(expired).includes("Private group"), false);
  } finally {
    await application.close();
  }
});

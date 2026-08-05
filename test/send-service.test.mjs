import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonLineAuditLogger, NullAuditLogger } from "../dist/audit/redactedAudit.js";
import { OutboxMediaService } from "../dist/media/outbox.js";
import { approvalPreviewFor, digestSend } from "../dist/replies/digest.js";
import { FilePendingSendStore } from "../dist/replies/pendingStore.js";
import { validatePendingSendRecord } from "../dist/replies/recordValidation.js";
import { WhatsAppSendService } from "../dist/replies/sendService.js";

test("text send requires the unchanged digest and approval preview and cannot replay", async () => {
  const context = await makeContext();
  const prepared = await context.service.prepareText({ chatId: "chat-1", text: "hello" });

  await assert.rejects(
    () => context.service.sendPrepared({ ...prepared, digest: "0".repeat(64) }),
    /digest mismatch/i,
  );
  await assert.rejects(
    () => context.service.sendPrepared({ ...prepared, approvalPreview: `${prepared.approvalPreview}!` }),
    /approval preview mismatch/i,
  );
  const sent = await context.service.sendPrepared(prepared);
  assert.deepEqual(sent, { state: "sent", whatsappMessageId: "wa-1" });
  assert.equal(context.sender.text.length, 1);
  assert.equal(context.sender.text[0][3], undefined);
  const terminal = await context.store.get(prepared.pendingId);
  assert.equal(terminal.payload, null);
  assert.equal(terminal.approvalPreview, null);
  const terminalJson = JSON.stringify(terminal);
  assert.equal(terminalJson.includes("hello"), false);
  assert.equal(terminalJson.includes("Friendly Tester"), false);
  assert.equal(terminalJson.includes("Approve this exact"), false);
  await assert.rejects(() => context.service.sendPrepared(prepared), /state is 'sent'/i);
});

test("reviewed text sends exact final edits with the reviewed preview and explicit null", async () => {
  const context = await makeContext();
  const thumbnail = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const linkPreview = {
    matchedText: "https://example.com/story",
    canonicalUrl: "https://example.com/story",
    title: "Exact reviewed title",
    description: "Exact reviewed description",
    jpegThumbnailBase64: thumbnail.toString("base64"),
    thumbnailSha256: createHash("sha256").update(thumbnail).digest("hex"),
  };
  const firstId = "15151515-1515-4151-8151-151515151515";
  await context.service.sendReviewed({
    pendingId: firstId,
    kind: "text",
    destination: { chatId: "chat-1" },
    replyToMessageId: "reply-1",
    text: "Final edited text https://example.com/story",
    linkPreview,
  });

  assert.equal(context.sender.text.length, 1);
  assert.deepEqual(context.sender.text[0].slice(0, 4), [
    {
      chatId: "chat-1",
      transportJid: "chat-1@g.us",
      kind: "group",
      displayName: "Friendly Tester",
    },
    "Final edited text https://example.com/story",
    "reply-1",
    linkPreview,
  ]);
  assert.equal((await context.store.get(firstId)).state, "sent");

  const secondId = "16161616-1616-4161-8161-161616161616";
  await context.service.sendReviewed({
    pendingId: secondId,
    kind: "text",
    destination: { e164: "+919876543210" },
    text: "No card should be generated",
    linkPreview: null,
  });
  assert.equal(context.sender.text[1][1], "No card should be generated");
  assert.equal(context.sender.text[1][3], null);
});

test("a reviewed send ID can reach transport at most once", async () => {
  const context = await makeContext();
  const input = {
    pendingId: "17171717-1717-4171-8171-171717171717",
    kind: "text",
    destination: { e164: "+919876543210" },
    text: "Only once",
    linkPreview: null,
  };
  const results = await Promise.allSettled([
    context.service.sendReviewed(input),
    context.service.sendReviewed(input),
  ]);

  assert.equal(context.sender.text.length, 1);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("every reviewed link-card field is integrity bound before transport", async () => {
  const pendingId = "21212121-2121-4212-8212-212121212121";
  const thumbnail = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const payload = {
    kind: "text",
    destination: {
      chatId: "group-1",
      transportJid: "group-1@g.us",
      kind: "group",
      displayName: "Review group",
    },
    text: "https://example.com/story",
    linkPreview: {
      matchedText: "https://example.com/story",
      canonicalUrl: "https://example.com/story",
      title: "Story",
      description: "Description",
      jpegThumbnailBase64: thumbnail.toString("base64"),
      thumbnailSha256: createHash("sha256").update(thumbnail).digest("hex"),
    },
  };
  const approvalPreview = approvalPreviewFor(payload, pendingId);
  const digest = digestSend(payload, approvalPreview, pendingId);
  const record = {
    id: pendingId,
    state: "prepared",
    messageKind: "text",
    destinationKind: "group",
    payload,
    digest,
    approvalPreview,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:10:00.000Z",
  };
  assert.equal(validatePendingSendRecord(record, pendingId, "/tmp/review-binding").digest, digest);

  const mutations = [
    (copy) => { copy.payload.linkPreview.matchedText = "https://example.com/other"; },
    (copy) => { copy.payload.linkPreview.canonicalUrl = "https://example.com/other"; },
    (copy) => { copy.payload.linkPreview.title = "Changed"; },
    (copy) => { copy.payload.linkPreview.description = "Changed description"; },
    (copy) => { copy.payload.linkPreview.jpegThumbnailBase64 = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]).toString("base64"); },
    (copy) => { copy.payload.linkPreview.thumbnailSha256 = "f".repeat(64); },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(record);
    mutate(copy);
    assert.throws(
      () => validatePendingSendRecord(copy, pendingId, "/tmp/review-binding"),
      /integrity check/i,
    );
  }
});

test("review media helpers stage, replace, verify, and send only the final bytes", async () => {
  const context = await makeContext();
  await fs.writeFile(path.join(context.outboxDir, "initial.txt"), "initial bytes");
  const pendingId = "18181818-1818-4181-8181-181818181818";
  const initial = await context.service.stageReviewMedia({
    pendingId,
    outboxPath: "initial.txt",
  });
  assert.equal(initial.kind, "document");
  const replacementBytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const replacement = await context.service.replaceReviewMedia({
    pendingId,
    bytes: replacementBytes,
    fileName: "edited.png",
  });
  assert.equal(replacement.kind, "image");
  assert.equal(replacement.sha256, createHash("sha256").update(replacementBytes).digest("hex"));
  assert.deepEqual(
    Buffer.from((await context.service.readReviewMedia({ pendingId, snapshot: replacement })).bytes),
    replacementBytes,
  );
  await assert.rejects(
    () => context.service.readReviewMedia({ pendingId, snapshot: initial }),
    /snapshot changed/i,
  );

  await context.service.sendReviewed({
    pendingId,
    kind: "media",
    destination: { chatId: "group-1" },
    media: replacement,
    caption: "Final caption",
  });
  assert.equal(context.sender.media.length, 1);
  assert.deepEqual(Buffer.from(context.sender.media[0][1].bytes), replacementBytes);
  assert.equal(context.sender.media[0][2], "Final caption");
  await assert.rejects(() => fs.access(replacement.path), /ENOENT/u);
});

test("reviewed audio captions and forged preview hashes fail before transport", async () => {
  const context = await makeContext();
  const audioId = "19191919-1919-4191-8191-191919191919";
  const audio = await context.service.replaceReviewMedia({
    pendingId: audioId,
    bytes: wavBytes(),
    fileName: "voice.wav",
  });
  await assert.rejects(
    () => context.service.sendReviewed({
      pendingId: audioId,
      kind: "media",
      destination: { chatId: "group-1" },
      media: audio,
      caption: "Not supported",
    }),
    /audio messages do not support captions/i,
  );
  assert.equal(context.sender.media.length, 0);
  assert.equal(await context.store.get(audioId), undefined);

  await context.service.sendReviewed({
    pendingId: audioId,
    kind: "media",
    destination: { chatId: "group-1" },
    media: audio,
  });
  assert.equal(context.sender.media.length, 1);

  const thumbnail = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await assert.rejects(
    () => context.service.sendReviewed({
      pendingId: "20202020-2020-4202-8202-202020202020",
      kind: "text",
      destination: { e164: "+919876543210" },
      text: "Invalid preview",
      linkPreview: {
        matchedText: "https://example.com/",
        canonicalUrl: "https://example.com/",
        title: "Example",
        jpegThumbnailBase64: thumbnail.toString("base64"),
        thumbnailSha256: "0".repeat(64),
      },
    }),
    /preview is invalid/i,
  );
  assert.equal(context.sender.text.length, 0);
});

test("confirmation for one draft cannot authorize a second identical draft", async () => {
  const context = await makeContext();
  const first = await context.service.prepareText({ chatId: "chat-1", text: "identical" });
  const second = await context.service.prepareText({ chatId: "chat-1", text: "identical" });
  assert.notEqual(first.pendingId, second.pendingId);
  assert.notEqual(first.digest, second.digest);
  assert.notEqual(first.approvalPreview, second.approvalPreview);

  await assert.rejects(
    () => context.service.sendPrepared({ ...first, pendingId: second.pendingId }),
    /digest mismatch/i,
  );
  assert.equal(context.sender.text.length, 0);
  await context.service.sendPrepared(first);
  assert.equal(context.sender.text.length, 1);
});

test("approval previews render invisible direction controls as literal escapes", async () => {
  const context = await makeContext({
    resolver: {
      async resolve() {
        return {
          chatId: "group-1",
          transportJid: "100000000000@g.us",
          kind: "group",
          displayName: "Trusted\u202e spoofed",
        };
      },
      async assertReplyTarget() {},
    },
  });
  const prepared = await context.service.prepareText({
    chatId: "group-1",
    text: "hello \u2066hidden\u2069 world",
  });

  assert.equal(/[\p{Bidi_Control}\p{Cf}]/u.test(prepared.approvalPreview), false);
  assert.equal(/[\p{Bidi_Control}\p{Cf}]/u.test(JSON.stringify(prepared.preview)), false);
  assert.match(prepared.approvalPreview, /Trusted\\u202e spoofed/u);
  assert.match(prepared.approvalPreview, /hello \\u2066hidden\\u2069 world/u);
  const record = await context.store.get(prepared.pendingId);
  assert.equal(record.payload.text, "hello \u2066hidden\u2069 world");
  assert.equal(record.payload.destination.displayName, "Trusted\u202e spoofed");
});

test("parallel confirmations cause at most one transport send", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const context = await makeContext({ gate });
  const prepared = await context.service.prepareText({ chatId: "chat-1", text: "once" });
  const first = context.service.sendPrepared(prepared);
  await new Promise((resolve) => setImmediate(resolve));
  const second = context.service.sendPrepared(prepared);
  release();
  const results = await Promise.allSettled([first, second]);

  assert.equal(context.sender.text.length, 1);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("distinct confirmations serialize the complete claim-to-terminal transition", async () => {
  let releaseFirst;
  let markFirstStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const context = await makeContext({
    textGates: [firstGate],
    onTextStart(callNumber) {
      if (callNumber === 1) markFirstStarted();
    },
  });
  const first = await context.service.prepareText({ chatId: "chat-1", text: "first" });
  const second = await context.service.prepareText({ chatId: "chat-1", text: "second" });

  const firstSend = context.service.sendPrepared(first);
  await firstStarted;
  const secondSend = context.service.sendPrepared(second);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(context.sender.text.length, 1);
  assert.equal(context.sender.maxActiveText, 1);
  assert.equal((await context.store.get(second.pendingId)).state, "prepared");

  releaseFirst();
  assert.deepEqual(await Promise.all([firstSend, secondSend]), [
    { state: "sent", whatsappMessageId: "wa-1" },
    { state: "sent", whatsappMessageId: "wa-2" },
  ]);
  assert.equal(context.sender.maxActiveText, 1);
});

test("a rejected send releases the queue without retrying its transport", async () => {
  const context = await makeContext({ failTransportAt: 1 });
  const first = await context.service.prepareText({ chatId: "chat-1", text: "maybe first" });
  const second = await context.service.prepareText({ chatId: "chat-1", text: "definitely second" });

  const results = await Promise.allSettled([
    context.service.sendPrepared(first),
    context.service.sendPrepared(second),
  ]);

  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.deepEqual(results[1].value, { state: "sent", whatsappMessageId: "wa-2" });
  assert.equal(context.sender.text.length, 2);
  assert.equal(context.sender.maxActiveText, 1);
  assert.equal((await context.store.get(first.pendingId)).state, "failed");
  assert.equal((await context.store.get(second.pendingId)).state, "sent");
});

test("a transport failure becomes uncertain and is never retried", async () => {
  const context = await makeContext({ failTransport: true });
  const prepared = await context.service.prepareText({ chatId: "chat-1", text: "maybe" });

  await assert.rejects(() => context.service.sendPrepared(prepared), /may have accepted/i);
  assert.equal(context.sender.text.length, 1);
  const listed = await context.service.list({ status: "uncertain" });
  assert.equal(listed.sends.length, 1);
  await assert.rejects(() => context.service.sendPrepared(prepared), /state is 'uncertain'/i);
  assert.equal(context.sender.text.length, 1);
});

test("a late exact-ID rejection waits for the active send and then dominates acceptance", async () => {
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const didStart = new Promise((resolve) => { started = resolve; });
  const context = await makeContext({ gate, onTextStart: started });
  const prepared = await context.service.prepareText({ chatId: "chat-1", text: "race" });
  const sending = context.service.sendPrepared(prepared);
  await didStart;
  const rejection = context.service.reconcileTransportFailure("wa-1", "whatsapp_rejected_463");
  release();
  assert.deepEqual(await sending, { state: "sent", whatsappMessageId: "wa-1" });
  assert.equal(await rejection, prepared.pendingId);
  const terminal = await context.store.get(prepared.pendingId);
  assert.equal(terminal.state, "failed");
  assert.equal(terminal.errorCode, "whatsapp_rejected_463");
  assert.equal(context.sender.text.length, 1);
});

test("local terminal-write failures never relabel known WhatsApp outcomes", async () => {
  for (const scenario of [
    { options: {}, expected: "sent" },
    { options: { failTransportAt: 1 }, expected: "send_rejected" },
    { options: { uncertainTransportAt: 1 }, expected: "send_uncertain" },
  ]) {
    const context = await makeContext(scenario.options);
    const prepared = await context.service.prepareText({ chatId: "chat-1", text: scenario.expected });
    context.store.finish = async () => { throw new Error("local disk failure"); };
    if (scenario.expected === "sent") {
      assert.deepEqual(await context.service.sendPrepared(prepared), {
        state: "sent",
        whatsappMessageId: "wa-1",
      });
    } else {
      await assert.rejects(
        context.service.sendPrepared(prepared),
        (error) => error.code === scenario.expected,
      );
    }
    assert.equal(context.sender.text.length, 1);
  }
});

test("expired sends and disabled sends never reach the transport", async () => {
  const now = { value: new Date("2026-01-01T00:00:00.000Z") };
  const context = await makeContext({ now, sendEnabled: false });
  const disabled = await context.service.prepareText({ chatId: "chat-1", text: "disabled" });
  await assert.rejects(() => context.service.sendPrepared(disabled), /sending is disabled/i);
  now.value = new Date("2026-01-01T00:11:00.000Z");
  const listed = await context.service.list({ status: "expired" });
  assert.equal(listed.sends.length, 1);
  assert.equal(context.sender.text.length, 0);
});

test("media preparation snapshots outbox bytes and tampering fails before transport", async () => {
  const context = await makeContext();
  await fs.writeFile(path.join(context.outboxDir, "note.txt"), "exact bytes");
  const prepared = await context.service.prepareMedia({
    chatId: "chat-1",
    outboxPath: "note.txt",
    caption: "caption",
  });
  const record = await context.store.get(prepared.pendingId);
  await fs.writeFile(record.payload.media.path, "tampered");

  await assert.rejects(() => context.service.sendPrepared(prepared), /snapshot changed/i);
  assert.equal(context.sender.media.length, 0);
  assert.equal((await context.service.list({ status: "failed" })).sends.length, 1);
});

test("audio captions are rejected and their snapshot is removed", async () => {
  const context = await makeContext();
  await fs.writeFile(path.join(context.outboxDir, "voice.wav"), wavBytes());

  await assert.rejects(
    () => context.service.prepareMedia({
      chatId: "group-1",
      outboxPath: "voice.wav",
      caption: "WhatsApp would ignore this",
    }),
    /audio messages do not support captions/i,
  );
  assert.deepEqual(await context.store.list(), []);
  assert.deepEqual(await fs.readdir(path.join(context.pendingDir, "media")), []);
});

test("audit records contain no recipient, name, text, or filename", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-audit-"));
  const auditFile = path.join(root, "audit.jsonl");
  const context = await makeContext({ root, audit: new JsonLineAuditLogger(auditFile) });
  const secretText = "very secret reply";
  await context.service.prepareText({ e164: "+919999999999", text: secretText });
  const audit = await fs.readFile(auditFile, "utf8");

  assert.equal(audit.includes(secretText), false);
  assert.equal(audit.includes("+919999999999"), false);
  assert.equal(audit.includes("Friendly Tester"), false);
  assert.match(audit, /"result":"prepared"/u);
});

test("a later operation expires and redacts abandoned media without list", async () => {
  const now = { value: new Date("2026-01-01T00:00:00.000Z") };
  const context = await makeContext({ now });
  await fs.writeFile(path.join(context.outboxDir, "private-name.txt"), "private media bytes");
  const abandoned = await context.service.prepareMedia({
    chatId: "group-1",
    outboxPath: "private-name.txt",
    caption: "private caption",
  });
  const active = await context.store.get(abandoned.pendingId);
  const snapshotPath = active.payload.media.path;
  now.value = new Date("2026-01-01T00:11:00.000Z");

  await context.service.prepareText({ e164: "+919888888888", text: "next operation" });
  const expired = await context.store.get(abandoned.pendingId);
  const serialized = JSON.stringify(expired);
  assert.equal(expired.state, "expired");
  assert.equal(expired.payload, null);
  assert.equal(expired.approvalPreview, null);
  assert.equal(serialized.includes("private-name.txt"), false);
  assert.equal(serialized.includes("private caption"), false);
  await assert.rejects(() => fs.access(snapshotPath), /ENOENT/u);
});

test("startup reconciliation deletes orphan snapshots but preserves active snapshots", async () => {
  const context = await makeContext();
  await fs.writeFile(path.join(context.outboxDir, "orphan.txt"), "orphan");
  const orphanId = "77777777-7777-4777-8777-777777777777";
  const orphan = await context.media.snapshot("orphan.txt", orphanId);
  await context.store.create({
    id: orphanId,
    state: "sent",
    messageKind: "media",
    destinationKind: "group",
    payload: null,
    digest: "7".repeat(64),
    approvalPreview: null,
    createdAt: context.now.value.toISOString(),
    updatedAt: context.now.value.toISOString(),
    expiresAt: context.now.value.toISOString(),
  });

  const restarted = await makeContext({
    root: context.root,
    now: context.now,
  });
  await restarted.service.prepareText({ e164: "+919777777777", text: "trigger startup" });
  await assert.rejects(() => fs.access(orphan.path), /ENOENT/u);

  await fs.writeFile(path.join(context.outboxDir, "active.txt"), "active");
  const prepared = await restarted.service.prepareMedia({ chatId: "group-1", outboxPath: "active.txt" });
  const active = await restarted.store.get(prepared.pendingId);
  const secondRestart = await makeContext({ root: context.root, now: context.now });
  await secondRestart.service.prepareText({ e164: "+919666666666", text: "reconcile again" });
  await fs.access(active.payload.media.path);
});

test("audit pruning drops entries older than thirty days", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-audit-age-"));
  const auditFile = path.join(root, "audit.jsonl");
  const now = { value: new Date("2026-01-01T00:00:00.000Z") };
  const logger = new JsonLineAuditLogger(auditFile, () => now.value);
  const event = {
    action: "prepare",
    result: "prepared",
    digest: "a".repeat(64),
    messageKind: "text",
    destinationKind: "direct",
  };
  await logger.record({ ...event, pendingId: "11111111-1111-4111-8111-111111111111" });
  now.value = new Date("2026-02-01T00:00:01.000Z");
  await logger.record({ ...event, pendingId: "22222222-2222-4222-8222-222222222222" });
  const audit = await fs.readFile(auditFile, "utf8");
  assert.equal(audit.includes("11111111-1111-4111-8111-111111111111"), false);
  assert.equal(audit.includes("22222222-2222-4222-8222-222222222222"), true);
});

test("audit logger refuses a symlink target without changing its destination", async (t) => {
  if (process.platform === "win32") return t.skip("symlink creation requires elevated Windows privileges");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-audit-link-"));
  const outside = path.join(root, "outside.txt");
  const auditLink = path.join(root, "audit.jsonl");
  await fs.writeFile(outside, "leave unchanged");
  await fs.symlink(outside, auditLink);
  const logger = new JsonLineAuditLogger(auditLink);

  await assert.rejects(
    () => logger.record({
      action: "prepare",
      result: "prepared",
      pendingId: "33333333-3333-4333-8333-333333333333",
      messageKind: "text",
      destinationKind: "direct",
    }),
    /audit file path is unsafe/i,
  );
  await assert.rejects(() => logger.prune(new Date(0)), /audit file path is unsafe/i);
  assert.equal(await fs.readFile(outside, "utf8"), "leave unchanged");
});

test("audit maintenance removes stale recognized temp files and preserves fresh writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-audit-temp-"));
  const auditFile = path.join(root, "audit.jsonl");
  const oldTemp = `${auditFile}.123.11111111-1111-4111-8111-111111111111.tmp`;
  const freshTemp = `${auditFile}.123.22222222-2222-4222-8222-222222222222.tmp`;
  await fs.writeFile(oldTemp, "stale audit payload");
  await fs.writeFile(freshTemp, "active audit write");
  const now = { value: new Date("2026-01-01T00:10:00.000Z") };
  const oldTime = new Date(now.value.getTime() - 6 * 60_000);
  await fs.utimes(oldTemp, oldTime, oldTime);
  await fs.utimes(freshTemp, now.value, now.value);
  const logger = new JsonLineAuditLogger(auditFile, () => now.value);

  await logger.record({
    action: "prepare",
    result: "prepared",
    pendingId: "33333333-3333-4333-8333-333333333333",
    messageKind: "text",
    destinationKind: "direct",
  });
  await assert.rejects(() => fs.access(oldTemp), /ENOENT/u);
  await fs.access(freshTemp);
});

test("opaque chat IDs cannot target direct chats", async () => {
  const context = await makeContext({
    resolver: {
      async resolve() {
        return {
          chatId: "direct-chat",
          transportJid: "919999999999@s.whatsapp.net",
          kind: "direct",
          e164: "+919999999999",
        };
      },
      async assertReplyTarget() {},
    },
  });
  await assert.rejects(
    () => context.service.prepareText({ chatId: "direct-chat", text: "unsafe addressing" }),
    /existing groups/i,
  );
});

for (const scenario of [
  {
    name: "text",
    prepare: (context) => context.service.prepareText({ chatId: "group-1", text: "original text" }),
    mutate: (record) => { record.payload.text = "tampered text"; },
  },
  {
    name: "destination",
    prepare: (context) => context.service.prepareText({ e164: "+919999999999", text: "direct text" }),
    mutate: (record) => { record.payload.destination.transportJid = "918888888888@s.whatsapp.net"; },
  },
  {
    name: "media metadata",
    prepare: async (context) => {
      await fs.writeFile(path.join(context.outboxDir, "integrity.txt"), "original media");
      return context.service.prepareMedia({ chatId: "group-1", outboxPath: "integrity.txt" });
    },
    mutate: (record) => { record.payload.media.sha256 = "b".repeat(64); },
  },
  {
    name: "media path",
    prepare: async (context) => {
      await fs.writeFile(path.join(context.outboxDir, "confined.txt"), "confined media");
      return context.service.prepareMedia({ chatId: "group-1", outboxPath: "confined.txt" });
    },
    mutate: (record, context) => { record.payload.media.path = path.join(context.root, "outside.bin"); },
  },
]) {
  test(`disk-tampered ${scenario.name} is refused before transport`, async () => {
    const context = await makeContext();
    const prepared = await scenario.prepare(context);
    const file = pendingRecordFile(context, prepared.pendingId);
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    scenario.mutate(record, context);
    await fs.writeFile(file, JSON.stringify(record));

    await assert.rejects(() => context.service.sendPrepared(prepared), /integrity check/i);
    assert.equal(context.sender.text.length, 0);
    assert.equal(context.sender.media.length, 0);
  });
}

test("malformed and schema-invalid pending JSON are refused before transport", async () => {
  for (const invalid of ["{", JSON.stringify({ unexpected: true })]) {
    const context = await makeContext();
    const prepared = await context.service.prepareText({ chatId: "group-1", text: "must not send" });
    await fs.writeFile(pendingRecordFile(context, prepared.pendingId), invalid);

    await assert.rejects(() => context.service.sendPrepared(prepared), /integrity check/i);
    assert.equal(context.sender.text.length, 0);
  }
});

test("a pending-record symlink is refused before transport", async (t) => {
  if (process.platform === "win32") return t.skip("symlink creation requires elevated Windows privileges");
  const context = await makeContext();
  const prepared = await context.service.prepareText({ chatId: "group-1", text: "must stay local" });
  const recordFile = pendingRecordFile(context, prepared.pendingId);
  const outside = path.join(context.root, "outside-pending.json");
  await fs.rename(recordFile, outside);
  await fs.symlink(outside, recordFile);

  await assert.rejects(
    () => context.service.sendPrepared(prepared),
    (error) => error.code === "pending_send_corrupt",
  );
  assert.equal(context.sender.text.length, 0);
});

test("maintenance removes only stale recognized pending temporary artifacts", async () => {
  const now = { value: new Date("2026-01-01T00:10:00.000Z") };
  const context = await makeContext({ now });
  const mediaDir = path.join(context.pendingDir, "media");
  await fs.mkdir(mediaDir, { recursive: true });
  const oldDraft = path.join(
    context.pendingDir,
    "11111111-1111-4111-8111-111111111111.json.123.22222222-2222-4222-8222-222222222222.tmp",
  );
  const freshDraft = path.join(
    context.pendingDir,
    "33333333-3333-4333-8333-333333333333.json.123.44444444-4444-4444-8444-444444444444.tmp",
  );
  const oldMedia = path.join(
    mediaDir,
    "55555555-5555-4555-8555-555555555555.bin.123.66666666-6666-4666-8666-666666666666.tmp",
  );
  const freshMedia = path.join(
    mediaDir,
    "77777777-7777-4777-8777-777777777777.bin.123.88888888-8888-4888-8888-888888888888.tmp",
  );
  for (const file of [oldDraft, freshDraft, oldMedia, freshMedia]) {
    await fs.writeFile(file, "plaintext draft bytes");
  }
  const oldTime = new Date(now.value.getTime() - 6 * 60_000);
  await Promise.all([oldDraft, oldMedia].map((file) => fs.utimes(file, oldTime, oldTime)));
  await Promise.all([freshDraft, freshMedia].map((file) => fs.utimes(file, now.value, now.value)));

  await context.service.initialize();
  await assert.rejects(() => fs.access(oldDraft), /ENOENT/u);
  await assert.rejects(() => fs.access(oldMedia), /ENOENT/u);
  await fs.access(freshDraft);
  await fs.access(freshMedia);
});

async function makeContext(overrides = {}) {
  const root = overrides.root ?? await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-send-"));
  const pendingDir = path.join(root, "pending");
  const outboxDir = path.join(root, "outbox");
  await fs.mkdir(outboxDir, { recursive: true });
  const store = new FilePendingSendStore(pendingDir);
  const sender = new FakeSender(overrides);
  const now = overrides.now ?? { value: new Date("2026-01-01T00:00:00.000Z") };
  const resolver = overrides.resolver ?? {
    async resolve(input) {
      return {
        chatId: input.chatId ?? "resolved-direct-chat",
        transportJid: input.e164 ? `${input.e164.slice(1)}@s.whatsapp.net` : `${input.chatId}@g.us`,
        kind: input.e164 ? "direct" : "group",
        displayName: "Friendly Tester",
        e164: input.e164,
      };
    },
    async assertReplyTarget(chatId, messageId) {
      if (chatId !== "chat-1" || messageId === "missing") throw new Error("invalid fake reply");
    },
  };
  const media = new OutboxMediaService(outboxDir, pendingDir);
  const service = new WhatsAppSendService(
    store,
    resolver,
    media,
    sender,
    overrides.audit ?? new NullAuditLogger(),
    {
      sendEnabled: overrides.sendEnabled ?? true,
      mediaSendEnabled: overrides.mediaSendEnabled ?? true,
      pendingTtlMs: 10 * 60_000,
      now: () => now.value,
    },
  );
  return { root, pendingDir, outboxDir, store, sender, service, media, now };
}

class FakeSender {
  text = [];
  media = [];
  activeText = 0;
  maxActiveText = 0;

  constructor(options) {
    this.options = options;
  }

  async sendText(...args) {
    const callNumber = this.text.push(args);
    await args[4]?.(`wa-${callNumber}`);
    this.activeText += 1;
    this.maxActiveText = Math.max(this.maxActiveText, this.activeText);
    this.options.onTextStart?.(callNumber);
    try {
      if (this.options.gate) await this.options.gate;
      if (this.options.textGates?.[callNumber - 1]) {
        await this.options.textGates[callNumber - 1];
      }
      if (this.options.failTransportAt === callNumber) return { outcome: "rejected", messageId: `wa-${callNumber}`, errorCode: "whatsapp_rejected_463" };
      if (this.options.uncertainTransportAt === callNumber) return { outcome: "uncertain", messageId: `wa-${callNumber}` };
      if (this.options.failTransport) throw new Error("network details must not escape");
      return { outcome: "accepted", messageId: `wa-${callNumber}` };
    } finally {
      this.activeText -= 1;
    }
  }

  async sendMedia(...args) {
    const callNumber = this.media.push(args);
    await args[4]?.(`wa-media-${callNumber}`);
    if (this.options.failTransport) throw new Error("network details must not escape");
    return { outcome: "accepted", messageId: `wa-media-${callNumber}` };
  }
}

function wavBytes() {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24);
  bytes.writeUInt32LE(16_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  return bytes;
}

function pendingRecordFile(context, pendingId) {
  return path.join(context.pendingDir, `${pendingId}.json`);
}

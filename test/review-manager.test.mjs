import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { SendReviewManager } from "../dist/review/reviewManager.js";

const TEST_RECIPIENT_E164 = "+12025550123";
const TEST_REVIEW_TEXT = "Fixture review message";

test("opening a review never sends or returns the browser capability", async () => {
  const context = makeContext();
  const opened = await context.manager.open({
    kind: "text",
    e164: TEST_RECIPIENT_E164,
    text: TEST_REVIEW_TEXT,
  });
  try {
    assert.deepEqual(Object.keys(opened).sort(), ["browserOpened", "expiresAt", "reviewId", "state"]);
    assert.equal(opened.state, "awaiting_human");
    assert.equal(context.sends.reviewed.length, 0);
    assert.equal(JSON.stringify(opened).includes("127.0.0.1"), false);
    assert.equal(JSON.stringify(opened).includes("action"), false);
    assert.match(context.browserUrl, /^http:\/\/127\.0\.0\.1:\d+\/review\/[A-Za-z0-9_-]{43}\/#action=[A-Za-z0-9_-]{43}$/u);

    const state = await getState(context.browserUrl);
    assert.equal(state.fromLabel, "Your linked personal WhatsApp");
    assert.deepEqual(state.destination, { mode: "direct", e164: TEST_RECIPIENT_E164 });
    assert.equal(state.text, TEST_REVIEW_TEXT);
    assert.equal(state.groups.length, 2);
    assert.match(state.groups[0].label, /^Bliss Friends · …group1$/u);
  } finally {
    await context.manager.close();
  }
});

test("group reviews fail closed without a cached name and expose unambiguous labels", async () => {
  const context = makeContext();
  try {
    await assert.rejects(
      context.manager.open({ kind: "text", chatId: "unknown@g.us", text: "do not route blindly" }),
      (error) => error.code === "review_group_unavailable",
    );
    assert.equal(context.browserUrl, "");
    assert.equal(context.sends.reviewed.length, 0);

    await context.manager.open({ kind: "text", chatId: "group-2", text: "named group" });
    const state = await getState(context.browserUrl);
    assert.equal(state.groups[0].label, "Family · …group2");
    assert.equal(state.groups[1].label, "Bliss Friends · …group1");
  } finally {
    await context.manager.close();
  }
});

test("group labels visibly escape bidirectional controls before the stable suffix", async () => {
  const context = makeContext({
    groups: [{ chatId: "120363123456@g.us", title: "Friends\u202Ehidden" }],
  });
  try {
    await context.manager.open({ kind: "text", chatId: "120363123456@g.us", text: "hello" });
    const state = await getState(context.browserUrl);
    assert.equal(state.groups[0].label, "Friends⟦U+202E⟧hidden · …123456");
  } finally {
    await context.manager.close();
  }
});

test("reply reviews show an escaped local message summary and reject a target from another chat", async () => {
  const context = makeContext();
  try {
    await context.manager.open({
      kind: "text",
      e164: TEST_RECIPIENT_E164,
      text: "reply draft",
      replyToMessageId: "reply-1",
    });
    const state = await getState(context.browserUrl);
    assert.match(state.reply.label, /^\+919876543210 · 2026-07-28 17:00 UTC · Hello ⟦U\+202E⟧there · ref [0-9a-f]{8}$/u);

    await assert.rejects(
      context.manager.open({ kind: "text", e164: "+919999999999", text: "wrong chat", replyToMessageId: "reply-1" }),
      (error) => error.code === "invalid_reply_target",
    );
  } finally {
    await context.manager.close();
  }
});

test("concurrent opens have no session cap and share one fully initialized server", async () => {
  const groupsStarted = deferred();
  const releaseGroups = deferred();
  let starts = 0;
  const context = makeContext({
    groupsGate: releaseGroups.promise,
    onGroupsStarted: () => { starts += 1; if (starts === 6) groupsStarted.resolve(); },
  });
  const opens = Array.from({ length: 6 }, (_, index) => context.manager.open({
    kind: "text", e164: TEST_RECIPIENT_E164, text: `draft ${index}`,
  }));
  await groupsStarted.promise;
  releaseGroups.resolve();
  try {
    await Promise.all(opens);
    assert.equal(context.manager.sessionCount, 6);
    assert.equal(context.browserUrls.length, 6);
    assert.equal(new Set(context.browserUrls.map((url) => new URL(url).origin)).size, 1);
  } finally {
    await context.manager.close();
  }
});

test("only an authenticated same-origin browser POST sends the edited draft once", async () => {
  const context = makeContext();
  const opened = await context.manager.open({ kind: "text", e164: TEST_RECIPIENT_E164, text: "original" });
  const capability = parseCapability(context.browserUrl);
  try {
    const deniedOrigin = await fetch(new URL("send", capability.base), {
      method: "POST",
      headers: {
        origin: "https://attacker.invalid",
        "content-type": "application/json",
        "x-safe-whatsapp-action": capability.action,
      },
      body: JSON.stringify({ recipientMode: "direct", e164: "+919999999999", text: "edited", attachmentId: null }),
    });
    assert.equal(deniedOrigin.status, 403);

    const deniedToken = await post(capability, "send", {
      recipientMode: "direct",
      e164: "+919999999999",
      text: "edited",
      attachmentId: null,
    }, "wrong-token");
    assert.equal(deniedToken.status, 403);
    assert.equal(context.sends.reviewed.length, 0);

    const accepted = await post(capability, "send", {
      recipientMode: "direct",
      e164: "+919999999999",
      text: "edited by me",
      attachmentId: null,
    });
    assert.equal(accepted.status, 202);
    await eventually(() => context.sends.reviewed.length === 1);
    assert.deepEqual(context.sends.reviewed[0], {
      pendingId: opened.reviewId,
      kind: "text",
      destination: { e164: "+919999999999" },
      text: "edited by me",
      linkPreview: null,
    });

    const replay = await post(capability, "send", {
      recipientMode: "direct",
      e164: "+919999999999",
      text: "send twice",
      attachmentId: null,
    });
    assert.notEqual(replay.status, 202);
    assert.equal(context.sends.reviewed.length, 1);

    const state = await getState(context.browserUrl);
    assert.equal(state.state, "sent");
    assert.equal(state.whatsappMessageId, undefined);
    assert.equal(state.destination, undefined);
    assert.equal(state.groups, undefined);
    assert.equal(state.text, undefined);
    assert.equal(state.maxMediaBytes, undefined);
  } finally {
    await context.manager.close();
  }
});

test("review HTTP surface keeps draft data out of HTML and rejects hostile hosts and methods", async () => {
  const secretText = "<img src=x onerror=alert(1)> private draft";
  const context = makeContext();
  await context.manager.open({ kind: "text", e164: TEST_RECIPIENT_E164, text: secretText });
  const capability = parseCapability(context.browserUrl);
  try {
    const page = await fetch(capability.base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/u);
    assert.equal(page.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(page.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal((await page.text()).includes(secretText), false);

    const wrongHostStatus = await rawStatus(new URL("api", capability.base), {
      Host: "attacker.invalid",
    });
    assert.equal(wrongHostStatus, 421);

    const options = await fetch(new URL("send", capability.base), {
      method: "OPTIONS",
      headers: { origin: capability.origin },
    });
    assert.equal(options.status, 405);
    assert.equal(options.headers.get("access-control-allow-origin"), null);
    assert.equal(context.sends.reviewed.length, 0);
  } finally {
    await context.manager.close();
  }
});

test("reviewed preview is bound to the exact edited URL and stale previews are refused", async () => {
  let fetchedUrl;
  const context = makeContext({
    async fetchPreview(url) {
      fetchedUrl = url;
      return {
        requestedUrl: `${url}/`,
        finalUrl: "https://example.com/final",
        title: "Example card",
        description: "Safe local preview",
        jpegThumbnail: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      };
    },
  });
  await context.manager.open({ kind: "text", e164: TEST_RECIPIENT_E164, text: "See www.example.com" });
  const capability = parseCapability(context.browserUrl);
  try {
    const previewResponse = await post(capability, "preview", { url: "www.example.com" });
    assert.equal(previewResponse.status, 200);
    const withPreview = await previewResponse.json();
    assert.equal(fetchedUrl, "https://www.example.com");
    assert.equal(withPreview.linkPreview.url, "www.example.com");
    assert.equal(withPreview.linkPreview.title, "Example card");
    assert.equal("finalUrl" in withPreview.linkPreview, false);

    const stale = await post(capability, "send", {
      recipientMode: "direct",
      e164: TEST_RECIPIENT_E164,
      text: "Changed https://different.example",
      linkPreviewId: withPreview.linkPreview.id,
      attachmentId: null,
    });
    assert.equal(stale.status, 400);
    assert.equal(context.sends.reviewed.length, 0);

    const sent = await post(capability, "send", {
      recipientMode: "direct",
      e164: TEST_RECIPIENT_E164,
      text: "See www.example.com",
      linkPreviewId: withPreview.linkPreview.id,
      attachmentId: null,
    });
    assert.equal(sent.status, 202);
    await eventually(() => context.sends.reviewed.length === 1);
    const pending = context.sends.reviewed[0].linkPreview;
    assert.equal(pending.matchedText, "www.example.com");
    assert.equal(pending.canonicalUrl, "https://example.com/final");
    assert.equal(typeof pending.jpegThumbnailBase64, "string");
    assert.match(pending.thumbnailSha256, /^[0-9a-f]{64}$/u);
  } finally {
    await context.manager.close();
  }
});

test("a sent review retains one frozen capability-free summary of the exact approved text", async () => {
  const completedAt = "2026-07-29T08:15:00.000Z";
  const context = makeContext({
    now: () => new Date(completedAt),
    async fetchPreview(url) {
      return {
        requestedUrl: url,
        finalUrl: "https://example.com/final",
        title: "Approved card",
        description: "Approved description",
        jpegThumbnail: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      };
    },
  });
  await context.manager.open({
    kind: "text",
    e164: TEST_RECIPIENT_E164,
    text: "Original",
    replyToMessageId: "reply-1",
  });
  const capability = parseCapability(context.browserUrl);
  const session = context.manager.findByRoute(capability.routeToken);
  try {
    const initial = await getState(context.browserUrl);
    const previewResponse = await post(capability, "preview", { url: "https://example.com" });
    const preview = await previewResponse.json();
    assert.equal((await post(capability, "send", {
      recipientMode: "direct",
      e164: TEST_RECIPIENT_E164,
      text: "Final exact text https://example.com",
      replyToMessageId: "reply-1",
      linkPreviewId: preview.linkPreview.id,
      attachmentId: null,
    })).status, 202);
    await eventually(() => session.submittedSummary?.completedAt === completedAt);

    const state = await getState(context.browserUrl);
    assert.deepEqual(state.submittedSummary, {
      recipientLabel: TEST_RECIPIENT_E164,
      text: "Final exact text https://example.com",
      replyLabel: initial.reply.label,
      linkPreview: {
        url: "https://example.com",
        title: "Approved card",
        description: "Approved description",
      },
      completedAt,
    });
    assert.equal(Object.isFrozen(session.submittedSummary), true);
    assert.equal(Object.isFrozen(session.submittedSummary.linkPreview), true);
    const serialized = JSON.stringify(state.submittedSummary);
    for (const forbidden of [
      capability.action,
      capability.routeToken,
      "reply-1",
      "wa-reviewed-1",
      "jpegThumbnail",
      "thumbnailSha256",
    ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  } finally {
    await context.manager.close();
  }
});

test("a correlated late rejection corrects a still-open sent summary", async () => {
  const context = makeContext();
  const opened = await context.manager.open({
    kind: "text",
    e164: TEST_RECIPIENT_E164,
    text: "late outcome",
  });
  const capability = parseCapability(context.browserUrl);
  const session = context.manager.findByRoute(capability.routeToken);
  try {
    assert.equal((await post(capability, "send", {
      recipientMode: "direct",
      e164: TEST_RECIPIENT_E164,
      text: "late outcome",
      attachmentId: null,
    })).status, 202);
    await eventually(() => session.state === "sent");
    await context.manager.reconcileTransportFailure(opened.reviewId);
    const corrected = await getState(context.browserUrl);
    assert.equal(corrected.state, "failed");
    assert.equal(corrected.errorCode, "send_rejected");
    assert.equal(corrected.submittedSummary.text, "late outcome");
  } finally {
    await context.manager.close();
  }
});

test("a failed media send retains safe attachment metadata after its snapshot is removed", async () => {
  const completedAt = "2026-07-29T09:30:00.000Z";
  const context = makeContext({
    media: true,
    sendError: new Error("private transport details"),
    now: () => new Date(completedAt),
  });
  const opened = await context.manager.open({
    kind: "media",
    chatId: "group-1",
    outboxPath: "photo.png",
    caption: "Initial caption",
  });
  const capability = parseCapability(context.browserUrl);
  const session = context.manager.findByRoute(capability.routeToken);
  try {
    const initial = await getState(context.browserUrl);
    assert.equal((await post(capability, "send", {
      recipientMode: "group",
      groupChoiceId: initial.destination.groupChoiceId,
      text: "Final exact caption",
      attachmentId: initial.media.id,
    })).status, 202);
    await eventually(() => session.submittedSummary?.completedAt === completedAt && !session.media);

    const state = await getState(context.browserUrl);
    assert.equal(state.state, "failed");
    assert.equal(state.media, undefined);
    assert.deepEqual(state.submittedSummary, {
      recipientLabel: "Bliss Friends · …group1",
      text: "Final exact caption",
      attachment: {
        fileName: "photo.png",
        mimeType: "image/png",
        size: 12,
        kind: "image",
      },
      completedAt,
    });
    assert.equal(Object.isFrozen(session.submittedSummary), true);
    assert.equal(Object.isFrozen(session.submittedSummary.attachment), true);
    const serialized = JSON.stringify(state.submittedSummary);
    for (const forbidden of [
      opened.reviewId,
      capability.action,
      capability.routeToken,
      initial.media.id,
      "/private/review/",
      "group-1",
      "a".repeat(64),
    ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  } finally {
    await context.manager.close();
  }
});

test("media may be replaced or removed only inside an open review", async () => {
  const context = makeContext({ media: true });
  await context.manager.open({
    kind: "media",
    chatId: "group-1",
    outboxPath: "photo.png",
    caption: "initial caption",
  });
  const capability = parseCapability(context.browserUrl);
  try {
    const initial = await getState(context.browserUrl);
    assert.equal(initial.media.fileName, "photo.png");

    const replaced = await fetch(new URL("attachment", capability.base), {
      method: "PUT",
      headers: {
        origin: capability.origin,
        "x-safe-whatsapp-action": capability.action,
        "x-safe-file-name": encodeURIComponent("replacement.jpg"),
        "content-type": "image/jpeg",
      },
      body: Buffer.from("replacement bytes"),
    });
    assert.equal(replaced.status, 200);
    assert.equal(context.sends.replaced.length, 1);
    const replacedState = await replaced.json();
    assert.notEqual(replacedState.media.id, initial.media.id);

    const stale = await post(capability, "send", {
      recipientMode: "group",
      groupChoiceId: initial.destination.groupChoiceId,
      text: "stale attachment",
      attachmentId: initial.media.id,
    });
    assert.equal(stale.status, 400);
    assert.equal(context.sends.reviewed.length, 0);

    const removed = await fetch(new URL("attachment", capability.base), {
      method: "DELETE",
      headers: {
        origin: capability.origin,
        "x-safe-whatsapp-action": capability.action,
      },
    });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).media, undefined);

    const sent = await post(capability, "send", {
      recipientMode: "group",
      groupChoiceId: initial.destination.groupChoiceId,
      text: "now a text message",
      attachmentId: null,
    });
    assert.equal(sent.status, 202);
    await eventually(() => context.sends.reviewed.length === 1);
    assert.equal(context.sends.reviewed[0].kind, "text");
  } finally {
    await context.manager.close();
  }
});

test("attachment replacement is serialized and a stale browser tab cannot send different media", async () => {
  const replacementStarted = deferred();
  const releaseReplacement = deferred();
  const context = makeContext({
    media: true,
    onReplaceStarted: () => replacementStarted.resolve(),
    replaceGate: releaseReplacement.promise,
  });
  await context.manager.open({ kind: "media", chatId: "group-1", outboxPath: "first.png" });
  const capability = parseCapability(context.browserUrl);
  try {
    const initial = await getState(context.browserUrl);
    const upload = fetch(new URL("attachment", capability.base), {
      method: "PUT",
      headers: {
        origin: capability.origin,
        "x-safe-whatsapp-action": capability.action,
        "x-safe-file-name": encodeURIComponent("second.jpg"),
        "content-type": "image/jpeg",
      },
      body: Buffer.from("second image bytes"),
    });
    await replacementStarted.promise;
    const staleSend = post(capability, "send", {
      recipientMode: "group",
      groupChoiceId: initial.destination.groupChoiceId,
      text: "reviewed the first file",
      attachmentId: initial.media.id,
    });
    releaseReplacement.resolve();
    assert.equal((await upload).status, 200);
    assert.equal((await staleSend).status, 400);
    assert.equal(context.sends.reviewed.length, 0);
    const current = await getState(context.browserUrl);
    assert.notEqual(current.media.id, initial.media.id);
    assert.equal(current.state, "open");
  } finally {
    await context.manager.close();
  }
});

test("browser-launch failure and expiry clean reviews without sending", async () => {
  const failed = makeContext({ browserOpened: false, media: true });
  await assert.rejects(
    failed.manager.open({ kind: "media", chatId: "group-1", outboxPath: "photo.png" }),
    (error) => error.code === "browser_open_failed",
  );
  assert.equal(failed.manager.sessionCount, 0);
  assert.equal(failed.sends.removed.length, 1);
  assert.equal(failed.sends.reviewed.length, 0);
  await failed.manager.close();

  const expired = makeContext({ ttlMs: 25, terminalRetentionMs: 25 });
  await expired.manager.open({ kind: "text", e164: TEST_RECIPIENT_E164, text: "do not send" });
  await eventually(() => expired.manager.sessionCount === 0, 1_000);
  assert.equal(expired.sends.reviewed.length, 0);
  await expired.manager.close();
});

function makeContext(overrides = {}) {
  const sends = new FakeSends(overrides);
  let browserUrl = "";
  const browserUrls = [];
  const manager = new SendReviewManager({
    sends,
    listCachedGroups: async () => {
      overrides.onGroupsStarted?.();
      if (overrides.groupsGate) await overrides.groupsGate;
      return overrides.groups ?? [
        { chatId: "group-1", title: "Bliss Friends" },
        { chatId: "group-2", title: "Family" },
      ];
    },
    getCachedReply: (messageId) => messageId === "reply-1" ? {
      chatId: "direct-1",
      chatE164: TEST_RECIPIENT_E164,
      fromMe: false,
      senderE164: "+919876543210",
      timestamp: "2026-07-28T17:00:00.000Z",
      text: "Hello \u202Ethere",
    } : undefined,
    sendEnabled: true,
    mediaSendEnabled: true,
    maxMediaBytes: 25 * 1024 * 1024,
    ttlMs: overrides.ttlMs ?? 10 * 60_000,
    terminalRetentionMs: overrides.terminalRetentionMs ?? 5_000,
    now: overrides.now,
    openBrowser: async (url) => {
      browserUrl = url;
      browserUrls.push(url);
      return overrides.browserOpened !== false;
    },
    fetchPreview: overrides.fetchPreview,
  });
  return {
    manager,
    sends,
    browserUrls,
    get browserUrl() { return browserUrl; },
  };
}

class FakeSends {
  reviewed = [];
  replaced = [];
  removed = [];

  constructor(options) { this.options = options; }

  async stageReviewMedia({ pendingId, outboxPath }) {
    return snapshot(pendingId, outboxPath, this.options.mediaKind ?? "image");
  }

  async replaceReviewMedia({ pendingId, bytes, fileName }) {
    this.replaced.push({ pendingId, bytes: Buffer.from(bytes), fileName });
    this.options.onReplaceStarted?.();
    if (this.options.replaceGate) await this.options.replaceGate;
    return snapshot(pendingId, fileName, "image", bytes.byteLength);
  }

  async readReviewMedia({ snapshot: value }) {
    return { ...value, bytes: Buffer.from("safe preview bytes") };
  }

  async removeReviewMedia(input) { this.removed.push(input); }

  async sendReviewed(input) {
    this.reviewed.push(input);
    if (this.options.sendError) throw this.options.sendError;
    return { state: "sent", whatsappMessageId: `wa-reviewed-${this.reviewed.length}` };
  }
}

function snapshot(pendingId, fileName, kind, size = 12) {
  return {
    pendingId,
    path: `/private/review/${pendingId}.bin`,
    originalName: fileName,
    sha256: "a".repeat(64),
    size,
    mimeType: kind === "image" ? "image/png" : "application/octet-stream",
    kind,
  };
}

function parseCapability(value) {
  const url = new URL(value);
  const action = new URLSearchParams(url.hash.slice(1)).get("action");
  const routeToken = url.pathname.split("/")[2];
  url.hash = "";
  return { base: url, origin: url.origin, action, routeToken };
}

async function getState(value) {
  const capability = parseCapability(value);
  const response = await fetch(new URL("api", capability.base));
  assert.equal(response.status, 200);
  return response.json();
}

async function post(capability, route, body, action = capability.action) {
  return fetch(new URL(route, capability.base), {
    method: "POST",
    headers: {
      origin: capability.origin,
      "content-type": "application/json",
      "x-safe-whatsapp-action": action,
    },
    body: JSON.stringify(body),
  });
}

async function eventually(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function rawStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

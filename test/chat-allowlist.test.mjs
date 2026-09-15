import test from "node:test";
import assert from "node:assert/strict";
import {
  DirectChatAllowlist,
  ALLOWED_DIRECT_E164_ENV,
  DIRECT_CHAT_POLICY_ENV,
} from "../dist/security/chatAllowlist.js";

test("direct-chat allowlist mode fails closed when unset", () => {
  const allowlist = DirectChatAllowlist.fromEnvironment({});
  assert.equal(allowlist.mode, "allowlist");
  assert.equal(allowlist.size, 0);
  assert.equal(allowlist.allows({ kind: "direct", e164: "+56911111111" }), false);
});

test("direct-chat allowlist accepts canonical E.164 and always blocks groups", () => {
  const allowlist = DirectChatAllowlist.fromEnvironment({
    [ALLOWED_DIRECT_E164_ENV]: "+56911111111,+56922222222",
  });
  assert.equal(allowlist.mode, "allowlist");
  assert.equal(allowlist.size, 2);
  assert.equal(allowlist.allows({ kind: "direct", e164: "+56911111111" }), true);
  assert.equal(allowlist.allows({ kind: "direct", e164: "+56933333333" }), false);
  assert.equal(allowlist.allows({ kind: "group", e164: "+56911111111" }), false);
});

test("all-direct mode admits direct chats even before E.164 resolution and blocks groups", () => {
  const policy = DirectChatAllowlist.fromEnvironment({
    [DIRECT_CHAT_POLICY_ENV]: "all",
  });
  assert.equal(policy.mode, "all");
  assert.equal(policy.allows({ kind: "direct" }), true);
  assert.equal(policy.allows({ kind: "direct", e164: "+56933333333" }), true);
  assert.equal(policy.allowsE164(undefined), true);
  assert.equal(policy.allows({ kind: "group", e164: "+56933333333" }), false);
});

test("direct-chat policy rejects malformed settings", () => {
  assert.throws(
    () => DirectChatAllowlist.fromEnvironment({ [ALLOWED_DIRECT_E164_ENV]: "56911111111" }),
    /canonical E\.164/u,
  );
  assert.throws(
    () => DirectChatAllowlist.fromEnvironment({ [DIRECT_CHAT_POLICY_ENV]: "everything" }),
    /allowlist.*all/u,
  );
});

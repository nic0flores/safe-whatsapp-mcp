import test from "node:test";
import assert from "node:assert/strict";
import { DirectChatAllowlist, ALLOWED_DIRECT_E164_ENV } from "../dist/security/chatAllowlist.js";

test("direct-chat allowlist fails closed when unset", () => {
  const allowlist = DirectChatAllowlist.fromEnvironment({});
  assert.equal(allowlist.size, 0);
  assert.equal(allowlist.allows({ kind: "direct", e164: "+56911111111" }), false);
});

test("direct-chat allowlist accepts canonical E.164 and always blocks groups", () => {
  const allowlist = DirectChatAllowlist.fromEnvironment({
    [ALLOWED_DIRECT_E164_ENV]: "+56911111111,+56922222222",
  });
  assert.equal(allowlist.size, 2);
  assert.equal(allowlist.allows({ kind: "direct", e164: "+56911111111" }), true);
  assert.equal(allowlist.allows({ kind: "direct", e164: "+56933333333" }), false);
  assert.equal(allowlist.allows({ kind: "group", e164: "+56911111111" }), false);
});

test("direct-chat allowlist rejects malformed entries", () => {
  assert.throws(
    () => DirectChatAllowlist.fromEnvironment({ [ALLOWED_DIRECT_E164_ENV]: "56911111111" }),
    /canonical E\.164/u,
  );
});

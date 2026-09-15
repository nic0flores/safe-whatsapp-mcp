import test from "node:test";
import assert from "node:assert/strict";
import {
  createPinnedWaWebVersionResolver,
  V3_COMPANION_BROWSER,
} from "../dist/whatsapp/baileysSocketFactory.js";

test("WA Web version is fetched once and pinned across pairing retries/restart", async () => {
  let calls = 0;
  const resolveVersion = createPinnedWaWebVersionResolver(async () => {
    calls += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return { version: [2, 3000, 1047580615] };
  });

  const [first, second] = await Promise.all([resolveVersion(), resolveVersion()]);
  const third = await resolveVersion();

  assert.deepEqual(first, [2, 3000, 1047580615]);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.equal(calls, 1);
});

test("V3 pairing uses the stable desktop companion identity", () => {
  assert.deepEqual(V3_COMPANION_BROWSER, ["Mac OS", "Desktop", "14.4.1"]);
});

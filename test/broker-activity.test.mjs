import test from "node:test";
import assert from "node:assert/strict";
import { BrokerActivity } from "../dist/broker/activity.js";

test("broker shutdown waits for in-flight service work through rejection", async () => {
  const activity = new BrokerActivity();
  let release;
  let idleNotifications = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  activity.onIdle = () => { idleNotifications += 1; };

  const operation = activity.run(async () => {
    await gate;
    throw new Error("expected test failure");
  });
  let idle = false;
  const waited = activity.waitForIdle().then(() => { idle = true; });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(activity.count, 1);
  assert.equal(idle, false);

  release();
  await assert.rejects(operation, /expected test failure/u);
  await waited;
  assert.equal(activity.count, 0);
  assert.equal(idle, true);
  assert.equal(idleNotifications, 1);
});

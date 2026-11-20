import test from "node:test";
import assert from "node:assert/strict";

import { decideRoute, DEFAULT_POLICY } from "../public/routing.js";

const ready = { online: true, deviceReady: true };
const noDevice = { online: true, deviceReady: false };
const offline = { online: false, deviceReady: true };

test("short simple question goes on-device when the model is ready", () => {
  const r = decideRoute("What's the weather like today?", ready);
  assert.equal(r.target, "on-device");
  assert.equal(r.mode, "prefer_on_device");
});

test("falls back to the cloud when no local model is ready", () => {
  const r = decideRoute("What's the weather like today?", noDevice);
  assert.equal(r.target, "cloud");
  assert.equal(r.mode, "only_in_cloud");
});

test("long input is routed to the cloud", () => {
  const long = "word ".repeat(DEFAULT_POLICY.maxOnDeviceWords + 5).trim();
  const r = decideRoute(long, ready);
  assert.equal(r.target, "cloud");
  assert.match(r.reason, /Long input/);
});

test("complex phrasing is routed to the cloud", () => {
  const r = decideRoute("Compare solar and wind power", ready);
  assert.equal(r.target, "cloud");
  assert.match(r.reason, /Complex task/);
});

test("code input is routed to the cloud", () => {
  const r = decideRoute("why does this fail\n```js\nlet x = ;\n```", ready);
  assert.equal(r.target, "cloud");
});

test("offline with a ready local model stays on-device", () => {
  const r = decideRoute("Set a timer for five minutes", offline);
  assert.equal(r.target, "on-device");
  assert.match(r.reason, /Offline/);
});

test("offline without a local model cannot answer", () => {
  const r = decideRoute("Set a timer for five minutes", { online: false, deviceReady: false });
  assert.equal(r.target, "none");
  assert.equal(r.mode, "none");
});

test("empty input is rejected", () => {
  assert.equal(decideRoute("   ", ready).target, "none");
  assert.equal(decideRoute(undefined, ready).target, "none");
});

test("carried-over history counts toward the on-device budget", () => {
  const question = "what about the other one?";
  const short = decideRoute(question, { ...ready, historyChars: 0 });
  assert.equal(short.target, "on-device");

  const withHistory = decideRoute(question, {
    ...ready,
    historyChars: DEFAULT_POLICY.maxOnDeviceChars,
  });
  assert.equal(withHistory.target, "cloud");
});

test("policy overrides are honoured", () => {
  const r = decideRoute("Compare solar and wind power", {
    ...ready,
    policy: { maxOnDeviceChars: 5 },
  });
  assert.equal(r.target, "cloud");
});

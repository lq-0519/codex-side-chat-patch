/** Verify durable consent, restart boundaries and failed saves without opening the application. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
const { createPolicy } = createRequire(import.meta.url)("../runtime/update-policy.cjs");

/** Allocate all policy fixtures outside the repository and remove them after each test. */
function fixture(t, filesystem = fs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-policy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const policyPath = path.join(directory, "state", "update-policy.json");
  const environment = { CODEX_SPARKLE_ENABLED: "true" };
  return { policyPath, environment, policy: createPolicy({ policyPath, environment, filesystem }) };
}

test("missing and malformed preferences fail closed before native bootstrap", t => {
  const { policy, policyPath, environment } = fixture(t);
  assert.equal(policy.initialize(), false);
  assert.equal(environment.CODEX_SPARKLE_ENABLED, "false");
  fs.mkdirSync(path.dirname(policyPath));
  for (const content of ["{", "null", '{"version":1,"enabled":"true"}', '{"version":2,"enabled":true}']) {
    fs.writeFileSync(policyPath, content);
    const owner = createPolicy({ policyPath, environment: {} });
    assert.equal(owner.initialize(), false);
    assert.ok(owner.read().error);
  }
});

test("enabled consent restores the native gate and saves privately", t => {
  const { policy, policyPath, environment } = fixture(t);
  policy.setEnabled(true);
  assert.equal(fs.statSync(policyPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(policyPath)), { version: 1, enabled: true });
  environment.CODEX_SPARKLE_ENABLED = "false";
  assert.equal(policy.initialize(), true);
  assert.equal(environment.CODEX_SPARKLE_ENABLED, "true");
  assert.equal(fs.readdirSync(path.dirname(policyPath)).length, 1);
});

test("changing preferences freezes this process and applies to a new process", t => {
  const { policy, policyPath, environment } = fixture(t);
  policy.initialize();
  policy.setEnabled(true);
  assert.equal(policy.initialize(), false);
  assert.equal(environment.CODEX_SPARKLE_ENABLED, "false");
  const next = createPolicy({ policyPath, environment: {} });
  assert.equal(next.initialize(), true);
  next.setEnabled(false);
  assert.equal(next.initialize(), true);
  assert.equal(createPolicy({ policyPath, environment: {} }).initialize(), false);
});

test("failed atomic rename preserves prior consent and removes the temporary file", t => {
  const { policyPath } = fixture(t);
  const original = createPolicy({ policyPath, environment: {} });
  original.setEnabled(true);
  const failing = createPolicy({
    policyPath, environment: {},
    filesystem: { ...fs, renameSync() { throw Error("synthetic rename failure"); } },
  });
  assert.throws(() => failing.setEnabled(false), /synthetic rename failure/);
  assert.equal(original.read().enabled, true);
  assert.deepEqual(fs.readdirSync(path.dirname(policyPath)), ["update-policy.json"]);
});

test("menu checkbox persists consent and reports the next-launch boundary", async t => {
  const { policy, environment } = fixture(t);
  policy.initialize();
  const messages = [];
  const item = policy.menuItem({ showMessageBox: async message => messages.push(message) });
  assert.equal(item.type, "checkbox");
  assert.equal(item.checked, false);
  item.checked = true;
  await item.click(item);
  assert.equal(policy.read().enabled, true);
  assert.equal(environment.CODEX_SPARKLE_ENABLED, "false");
  assert.match(messages[0].message, /下次启动生效/);
  assert.match(messages[0].detail, /自行完全退出/);
});

test("failed menu save reverts the checkbox without claiming success", async t => {
  const { policyPath } = fixture(t);
  const policy = createPolicy({
    policyPath, environment: {},
    filesystem: { ...fs, renameSync() { throw Error("synthetic failure"); } },
  });
  policy.initialize();
  const messages = [];
  const item = policy.menuItem({ showMessageBox: async message => messages.push(message) });
  item.checked = true;
  await item.click(item);
  assert.equal(item.checked, false);
  assert.equal(policy.read().enabled, false);
  assert.equal(messages[0].type, "error");
});

test("nonboolean caller input cannot enable updates", t => {
  const { policy } = fixture(t);
  assert.throws(() => policy.setEnabled("false"), /boolean/);
  assert.equal(policy.read().enabled, false);
});

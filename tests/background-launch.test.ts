// A new or edited rule must not make a macOS background worker start in a protected location.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateBackgroundLaunch } from "../host/background-launch.ts";
import { parseRules } from "../protocol/rules.ts";

test("generic startup validation covers new rules, aliases, and script arguments", () => {
  const home = mkdtempSync(join(tmpdir(), "startup-test-"));
  try {
    mkdirSync(join(home, "Documents"));
    symlinkSync(join(home, "Documents"), join(home, "alias"));
    const rules = {
      rules: [{ name: "a new task", to: "worker", cwd: "~/.agent-autoloop/jobs" }],
      agents: { worker: { command: ["node", "--no-warnings", "~/.agent-autoloop/run.mjs"] } },
      elsewhere: [],
    };
    assert.doesNotThrow(() => validateBackgroundLaunch(rules, home));
    rules.rules[0].cwd = "~/alias/project";
    assert.throws(() => validateBackgroundLaunch(rules, home), /a new task.*alias/);
    rules.rules[0].cwd = "~/.agent-autoloop/jobs";
    rules.agents.worker.command[2] = "~/Documents/run.mjs";
    assert.throws(() => validateBackgroundLaunch(rules, home), /a new task.*run.mjs/);
    rules.agents.worker.command = ["cat", "~/Documents/business-data.json"];
    assert.doesNotThrow(() => validateBackgroundLaunch(rules, home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("only an omitted working directory uses the installation default", () => {
  const config = (cwd?: string) =>
    JSON.stringify({
      sources: {},
      agents: { worker: { name: "Worker", worker: "mac", use: "command", command: ["pwd"] } },
      rules: [{ name: "new task", to: "worker", when: { cron: "0 9 * * *" }, cwd }],
    });
  const read = (cwd?: string) => parseRules(config(cwd), 0, "UTC", "/install/work").rules[0].cwd;
  assert.equal(read(), "/install/work");
  assert.equal(read("/explicit"), "/explicit");
  assert.throws(() => read(""), /cwd/);
});

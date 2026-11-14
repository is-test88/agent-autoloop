import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlugin } from "./app/host/plugins.ts";

const root = import.meta.dirname;
const { agents, channels, configChannels } = JSON.parse(readFileSync(join(root, "local-check.json"), "utf8"));
for (const agent of agents) {
  const adapter = await loadPlugin(agent.use, "agent");
  assert.equal(typeof adapter.command, "function");
  for (const path of [agent.program, ...(agent.command ?? [])]) {
    if (path?.startsWith("/") && !path.includes("{")) assert.ok(existsSync(path), path);
  }
}
for (const name of new Set([...channels, ...configChannels])) {
  assert.equal(typeof await loadPlugin(name, "channel"), "function");
}
const adapter = await loadPlugin("command-feedback", "agent");
const contextFile = join(root, "feedback.json");
const turn = { contextFile, cwd: root, folder: root, prompt: "升级验证", command: ["echo", "{prompt}"], access: "read" };
for (const answers of [[], [{choice: 0, text: "备注"}]]) {
  writeFileSync(contextFile, JSON.stringify({ answers }));
  assert.deepEqual(adapter.command(turn), ["echo", "升级验证"]);
}
writeFileSync(contextFile, JSON.stringify({ answers: [{ choice: null, text: "原任务意见" }] }));
const argv = adapter.command(turn);
assert.ok(argv.includes("gpt-6.1-sol") && argv.some((arg) => arg.includes('model_reasoning_effort="high"')));
assert.ok(!argv.some((arg) => arg.includes("原任务意见")));
console.log("本地插件加载与 Codex 文字反馈路由通过。");

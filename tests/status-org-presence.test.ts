// Background steps must not look like duplicate business tasks; grouping must not hide an offline worker or mutate state.
import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "../cli/status.ts";

test("organization workflow is one presence entry while unavailable stages remain visible", () => {
  const state = {
    now: "2026-11-13T11:00:00.000Z",
    timezone: "Asia/Shanghai",
    spending: {
      today: { rounds: 0, tokens: 0, cost: 0, missingTokens: 0, missingCost: 0 },
      week: { rounds: 0, tokens: 0, cost: 0, missingTokens: 0, missingCost: 0 },
    },
    totals: { running: 0, queued: 0, retrying: 0, unknown: 0, doneToday: 0 },
    agents: [
      { id: "codex", name: "Codex", worker: "mac", online: true },
      { id: "org-notify-script", name: "组织优化 · 脚本发送提醒", worker: "mac", online: true },
      { id: "org-rollup-script", name: "组织优化 · 脚本线下汇总", worker: "mac", online: true },
    ],
    channels: [],
    sources: [],
    lines: [],
    elsewhere: [],
    cards: [],
    recentCards: [],
    runs: [],
    unrouted: [],
  };
  const original = structuredClone(state);
  const text = render(state, { color: false });
  assert.match(text, /● 组织优化每日流程/);
  assert.match(text, /2\/2 个步骤在线/);
  assert.doesNotMatch(text, /● 组织优化 ·/);
  assert.match(text, /● Codex/);
  assert.match(text, /status --json/);
  assert.deepEqual(state, original);
  state.agents[2].online = false;
  const partial = render(state, { color: false });
  assert.match(partial, /○ 组织优化每日流程/);
  assert.match(partial, /1\/2 个步骤在线/);
  assert.match(partial, /组织优化 · 脚本线下汇总.*离线/);
});

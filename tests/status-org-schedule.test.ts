// A daily calendar check must not be presented as a weekend business execution.
// The display must retain makeup workdays and fail closed at an unknown calendar year.
import assert from "node:assert/strict";
import { test } from "node:test";
import { orgScheduleDisplay } from "../cli/org-schedule.ts";
const row = (next: string, agent = "org-morning-gate") => ({ agent, every: "每天 10:30", next });
const workday = (date: string): boolean | null => {
  if (date.startsWith("2028")) return null;
  if (date === "2026-10-10") return true;
  if (date >= "2026-10-01" && date <= "2026-10-07") return false;
  if (date >= "2027-01-01" && date <= "2027-01-03") return false;
  return ![0, 6].includes(new Date(date + "T12:00:00Z").getUTCDay());
};
test("weekend polling is displayed as the next business day without changing the raw state", () => {
  const state = { lines: [row("2026-11-14T02:30:00.000Z"), row("2026-11-14T02:30:00.000Z", "other")] };
  const shown = orgScheduleDisplay(state, workday);
  assert.equal(shown.lines[0].next, "2026-11-16T02:30:00.000Z");
  assert.equal(shown.lines[0].every, "工作日 10:30（含调休）");
  assert.equal(state.lines[0].next, "2026-11-14T02:30:00.000Z");
  assert.equal(shown.lines[1], state.lines[1]);
});
test("makeup Saturday and cross-year holidays share the gate calendar", () => {
  assert.equal(
    orgScheduleDisplay({ lines: [row("2026-10-10T02:30:00.000Z")] }, workday).lines[0].next,
    "2026-10-10T02:30:00.000Z",
  );
  assert.equal(
    orgScheduleDisplay({ lines: [row("2027-01-01T02:30:00.000Z")] }, workday).lines[0].next,
    "2027-01-04T02:30:00.000Z",
  );
});
test("missing calendar does not invent a business execution date", () => {
  const shown = orgScheduleDisplay({ lines: [row("2028-01-01T02:30:00.000Z")] }, workday);
  assert.equal(shown.lines[0].next, null);
  assert.equal("nextLabel" in shown.lines[0] && shown.lines[0].nextLabel, "未知，工作日日历待维护");
});

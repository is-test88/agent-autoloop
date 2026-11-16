// Local display adapter only: scheduling and the raw API remain untouched.
// Import the workflow's own calendar predicate rather than maintaining a second holiday list.
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Workday = (date: string) => boolean | null;
type Line = { agent?: string; every: string | null; next: string | null; nextLabel?: string };
const gates = new Set(["org-morning-gate", "org-afternoon-gate", "org-rollup-gate"]);

export function orgScheduleDisplay<T extends { lines: Line[] }>(state: T, workday: Workday): T {
  return {
    ...state,
    lines: state.lines.map((line) => {
      if (!gates.has(line.agent ?? "") || !line.next || !line.every) return line;
      const raw = new Date(line.next);
      const local = new Date(raw.getTime() + 8 * 3600000).toISOString();
      const every = "工作日 " + local.slice(11, 16) + "（含调休）";
      for (let offset = 0; offset < 366; offset++) {
        const next = new Date(raw.getTime() + offset * 86400000);
        const date = new Date(next.getTime() + 8 * 3600000).toISOString().slice(0, 10);
        const eligible = workday(date);
        if (eligible === null) break;
        if (eligible) return { ...line, every, next: next.toISOString() };
      }
      return { ...line, every, next: null, nextLabel: "未知，工作日日历待维护" };
    }),
  };
}

export async function localOrgScheduleDisplay<T extends { lines: Line[] }>(state: T): Promise<T> {
  if (!state.lines.some((line) => gates.has(line.agent ?? ""))) return state;
  try {
    const gate = await import(pathToFileURL(join(homedir(), ".agent-autoloop", "org-optimization", "gate.mjs")).href);
    return orgScheduleDisplay(state, gate.workday);
  } catch {
    return orgScheduleDisplay(state, () => null);
  }
}

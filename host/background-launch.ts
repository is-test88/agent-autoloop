import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Rules } from "../kernel/rules.ts";
import { RulesError } from "../protocol/rules.ts";

type LaunchRules = {
  rules: Array<{ name: string; to: string; cwd?: string }>;
  elsewhere: Array<{ name: string; to: string; cwd?: string }>;
  agents: Record<string, { program?: string; command?: string[] }>;
};

function physical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(physical(parent), path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
  }
}

const script = /\.(?:[cm]?[jt]sx?|py|sh|zsh|bash|fish|rb|pl|ps1)$/i;

export function validateBackgroundLaunch(rules: LaunchRules, home: string) {
  const folders = ["Documents", "Desktop", "Downloads"].flatMap((folder) => {
    const path = resolve(home, folder);
    return [path, physical(path)];
  });
  const absolute = (value: string, cwd: string) =>
    value.startsWith("~/") ? resolve(home, value.slice(2)) : resolve(cwd, value);
  const issues: string[] = [];
  for (const entry of [...rules.rules, ...rules.elsewhere]) {
    if (!entry.cwd) continue;
    const cwd = absolute(entry.cwd, home);
    const agent = rules.agents[entry.to];
    const [executable, ...args] = agent.command ?? [];
    const paths = [entry.cwd, agent.program, executable, ...args.filter((value) => script.test(value))];
    for (const [index, value] of paths.entries()) {
      if (!value || !value.includes("/") || value.includes("{")) continue;
      const path = absolute(value, index === 0 ? home : cwd);
      const candidates = [path, physical(path)];
      if (folders.some((folder) => candidates.some((item) => item === folder || item.startsWith(folder + sep)))) {
        issues.push(`「${entry.name}」的后台启动路径 ${value} 位于 macOS 受保护目录，请使用后台运行目录`);
      }
    }
  }
  if (issues.length) throw new RulesError(issues);
}

export function checkBackgroundLaunch(rules: Rules) {
  if (process.platform === "darwin") validateBackgroundLaunch(rules, homedir());
  return rules;
}

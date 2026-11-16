import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { cli } from "../app/plugins/delivery/gitea-history.mjs";

const home = dirname(fileURLToPath(import.meta.url));
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const read = (path) => readFileSync(path, "utf8");
const skill = join(homedir(), ".agents/skills/gitea-pr-review/SKILL.md");
const rulesPath = process.env.AGENT_AUTOLOOP_RULES ?? join(home, "..", "rules.json");
const agent = JSON.parse(read(rulesPath)).agents["gitea-codex"];
const instance = JSON.parse(read(join(home, "repositories.json"))).origin;
const reviewer = { name: "codex", model: agent.model, effort: agent.effort };
const policy = digest([read(join(home, "AGENTS.md")), read(skill)]);
let legacyPolicy;
try {
  legacyPolicy = read(join(home, "review-history-legacy-policy")).trim();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

process.exitCode = await cli(home, { instance, reviewer, policy, legacyPolicy }, process.argv.slice(2));

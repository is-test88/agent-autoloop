import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { reviewStart, sameMergeTarget, verifyRelease } from "./gates.ts";

import { reviewCovers, reviewSignature } from "./review-policy.ts";
import { reviewGuidance, runReviewRound } from "./gitea-reviewer.mjs";
import { tmpdir } from "node:os";

const sha = /^[a-f0-9]{40}$/;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value) => typeof value === "string" && value.trim().length > 0;
const positive = (value) => Number.isSafeInteger(value) && value > 0;

function reviewInputs(snapshot, { repo, store, policy, reviewer, legacyPolicy, instance }) {
  const {
    base_repository: repository,
    base_repository_id: repoId,
    pull_id: pullId,
    number,
    base: branch,
    base_sha: base,
    head_sha: head,
    target_head_sha: target,
    merge_base_sha: mergeBase,
    policy_digest: remotePolicy,
  } = snapshot;
  if (
    !instance ||
    snapshot.gitea_instance !== instance ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    ![repoId, pullId, number].every(positive) ||
    ![base, head, mergeBase].every((x) => sha.test(x)) ||
    base !== target ||
    !text(branch) ||
    !/^sha256:[a-f0-9]{64}$/.test(remotePolicy) ||
    snapshot.state !== "open" ||
    snapshot.draft === true ||
    snapshot.merged !== false ||
    snapshot.base_repository_identity_verified !== true ||
    snapshot.target_branch_identity_verified !== true
  )
    throw Error("需要当前 PR 的已核验开放状态快照");
  const git = (...args) =>
    execFileSync("git", ["--no-replace-objects", "-C", repo, ...args], { encoding: "utf8" }).trim();
  const actual = git("merge-base", "--all", base, head);
  if (actual !== mergeBase) throw Error("本机 Git 对象与 PR 的合并基点不一致");
  const ancestor = (old, next) =>
    spawnSync("git", ["--no-replace-objects", "-C", repo, "merge-base", "--is-ancestor", old, next]).status === 0;
  const key = { instance, repository, repoId, pullId, number, branch };
  const file = join(store, digest(key) + ".json");
  const scope = digest({ key, base, mergeBase, remotePolicy, policy });
  const legacyScope = legacyPolicy && digest({ key, base, mergeBase, remotePolicy, policy: legacyPolicy });
  let rounds = [];
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (saved.version !== 1 || digest(saved.key) !== digest(key) || !Array.isArray(saved.rounds))
      throw Error("审查记录格式不匹配");
    rounds = saved.rounds;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { key, file, scope, legacyScope, reviewer, head, base, mergeBase, ancestor, rounds };
}

function planFrom({ rounds, scope, legacyScope, reviewer, head, base, mergeBase, ancestor }) {
  const previous = rounds.at(-1);
  const efforts = reviewer ? [reviewer.effort ?? "high"] : [];
  const covered =
    !reviewer ||
    (previous?.review
      ? reviewCovers(previous.review, [reviewer], efforts)
      : previous?.scope === legacyScope &&
        reviewCovers({ signature: "gpt-6.1-sol", effort: "high" }, [reviewer], efforts));
  const compatible = previous && (previous.scope === scope || previous.scope === legacyScope) && covered;
  const start = reviewStart(previous?.head, head, compatible, ancestor);
  const reusable = start === head;
  const incremental = !!start && !reusable;
  const mode = reusable ? "reuse" : incremental ? "incremental" : "full";
  const unresolved = previous?.findings ?? [];
  return {
    mode,
    head,
    base,
    number: rounds.length + 1,
    range: reusable ? null : [start ?? mergeBase, head],
    unresolved,
    planId: digest({
      scope,
      head,
      previous,
      reviewer: reviewer && reviewSignature([{ ...reviewer, name: "codex" }]),
      efforts,
    }),
  };
}

export function reviewPlan(snapshot, options) {
  return planFrom(reviewInputs(snapshot, options));
}

export function saveReview(snapshot, options, result) {
  const inputs = reviewInputs(snapshot, options);
  const plan = planFrom(inputs);
  if (result.planId !== plan.planId || plan.mode === "reuse") throw Error("审查计划已变化或该提交已有记录");
  const { findings, resolved } = result;
  const valid = (items) =>
    Array.isArray(items) && items.every((x) => x && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(x.id) && text(x.evidence));
  if (!valid(findings) || !valid(resolved) || !findings.every((x) => text(x.title)))
    throw Error("审查结果缺少问题编号、标题或证据");
  const ids = new Set([...findings, ...resolved].map((x) => x.id));
  if (ids.size !== findings.length + resolved.length) throw Error("问题编号重复");
  for (const item of plan.unresolved) if (!ids.has(item.id)) throw Error("缺少旧问题的复查结果 " + item.id);
  if (resolved.some((x) => !plan.unresolved.some((y) => y.id === x.id))) throw Error("只能关闭已有问题");
  const { key, file, scope, head, base, rounds, reviewer } = inputs;
  const round = {
    head,
    base,
    scope,
    mode: plan.mode,
    range: plan.range,
    findings,
    resolved,
    ...(reviewer && {
      review: {
        signature: reviewSignature([reviewer]),
        effort: reviewer.effort ?? "high",
      },
    }),
    at: new Date().toISOString(),
  };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + process.pid + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, key, rounds: [...rounds, round] }, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(tmp, file);
  } finally {
    try {
      unlinkSync(tmp);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return round;
}

export function premerge(reviewed, current, options) {
  const target = (s) => ({ head: s.head_sha, base: s.target_head_sha, branch: s.base });
  for (const key of ["gitea_instance", "base_repository", "base_repository_id", "pull_id", "number", "policy_digest"])
    if (reviewed[key] !== current[key]) throw Error("PR 身份或审查策略已变化");
  if (!sameMergeTarget(target(reviewed), target(current))) throw Error("PR 或目标分支版本已变化");
  const plan = reviewPlan(current, options);
  if (plan.mode !== "reuse" || plan.unresolved.length) throw Error("当前提交缺少无阻断问题的审查记录");
  if (!/^sha256:[a-f0-9]{64}$/.test(current.snapshot_id)) throw Error("缺少合并快照编号");
  return { head: plan.head, base: plan.base, snapshotId: current.snapshot_id };
}

export async function liveStatus(snapshot, evidence, repo, instance) {
  const { merged_commit_id: merged } = snapshot;
  if (
    !instance ||
    snapshot.gitea_instance !== instance ||
    snapshot.merged !== true ||
    !sha.test(merged) ||
    snapshot.base_repository_identity_verified !== true
  )
    throw Error("需要 Gitea 已合并 PR 的核验结果");
  if (
    evidence.repository !== snapshot.base_repository ||
    evidence.merge !== merged ||
    !sha.test(evidence.release) ||
    !sha.test(evidence.live)
  )
    throw Error("发布证据与已合并 PR 不匹配");
  const contains = (a, b) =>
    spawnSync("git", ["--no-replace-objects", "-C", repo, "merge-base", "--is-ancestor", a, b]).status === 0;
  const phase = await verifyRelease(
    merged,
    {
      release: evidence.release,
      live: evidence.healthy === true ? evidence.live : null,
      successful: evidence.successful === true,
    },
    contains,
  );
  if (!phase) throw Error("尚未核实包含该提交的成功发布与实际线上版本");
  return { phase, merged, live: evidence.live };
}

export async function executeReview(snapshot, options, { timeout } = {}) {
  const plan = reviewPlan(snapshot, options);
  if (plan.mode === "reuse") return { ok: true, plan };
  const [start, end] = plan.range;
  const git = (...args) =>
    execFileSync("git", ["--no-replace-objects", "-C", options.repo, ...args], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const temp = mkdtempSync(join(tmpdir(), "autoloop-gitea-review-"));
  try {
    const diff = git("diff", "--no-ext-diff", "--no-textconv", start, end, "--");
    let points = "";
    try {
      const trusted = git("show", `${plan.base}:AGENTS.md`);
      points = trusted.match(/^## 审查要点\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]?.trim() ?? "";
    } catch (error) {
      if (error.status !== 128) throw error;
    }
    const result = await runReviewRound(temp, plan, diff, points, options.reviewer, timeout);
    if (!result.ok) return result;
    const round = saveReview(snapshot, options, result.review);
    return { ok: true, plan, round, guidance: reviewGuidance(plan.number, round.findings) };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export async function cli(home, options, args) {
  const [action, snapshotFile, repo, resultFile] = args;
  if (
    !snapshotFile ||
    !repo ||
    !["plan", "run", "premerge", "live"].includes(action) ||
    (["premerge", "live"].includes(action) && !resultFile)
  )
    throw Error("用法：node review-history.mjs <plan|run|premerge|live> <状态JSON> <Git目录> [证据JSON]");
  const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
  options = { ...options, repo, store: join(home, "review-history") };
  const evidence = resultFile ? JSON.parse(readFileSync(resultFile, "utf8")) : null;
  let result;
  if (action === "plan") result = reviewPlan(snapshot, options);
  if (action === "run") result = await executeReview(snapshot, options);
  if (action === "premerge") result = premerge(snapshot, evidence, options);
  if (action === "live") result = await liveStatus(snapshot, evidence, repo, options.instance);
  if (result.ok === false) {
    const line = `没跑成：${snapshot.base_repository} #${snapshot.number} · ${result.receipt.summary}`;
    console.log(JSON.stringify({ ...result, reply: line }, null, 2));
    return 1;
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

// A review is reusable only for its own PR, policy and verified Git history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readMessage } from "../worker/contract.ts";
import {
  reviewPlan,
  saveReview,
  premerge,
  liveStatus,
  executeReview,
  cli,
} from "../plugins/delivery/gitea-history.mjs";

test("same head reuses findings, a descendant reviews its delta, and a changed base or rewrite requires full review", async () => {
  const root = mkdtempSync(join(tmpdir(), "gitea-review-history-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const commit = (name) => {
    writeFileSync(join(root, name), name);
    git("add", name);
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", name);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q");
    const base = commit("base"),
      first = commit("first"),
      second = commit("second");
    const instance = "http://gitea.example.test";
    const snapshot = {
      gitea_instance: instance,
      base_repository: "owner/repo",
      base_repository_id: 1,
      pull_id: 2,
      number: 3,
      base: "main",
      base_sha: base,
      target_head_sha: base,
      merge_base_sha: base,
      head_sha: first,
      policy_digest: "sha256:" + "1".repeat(64),
      base_repository_identity_verified: true,
      target_branch_identity_verified: true,
      state: "open",
      merged: false,
    };
    const opts = { instance, repo: root, store: join(root, "ledger"), policy: "v1" };
    const finding = { id: "missing-check", title: "Missing check", evidence: "first" };
    const initial = reviewPlan(snapshot, opts);
    assert.equal(initial.mode, "full");
    saveReview(snapshot, opts, { planId: initial.planId, findings: [finding], resolved: [] });
    assert.deepEqual(reviewPlan(snapshot, opts).unresolved, [finding]);
    assert.equal(reviewPlan(snapshot, opts).mode, "reuse");
    const next = { ...snapshot, head_sha: second };
    const delta = reviewPlan(next, opts);
    assert.equal(delta.mode, "incremental");
    assert.deepEqual(delta.range, [first, second]);
    assert.deepEqual(delta.unresolved, [finding]);
    assert.throws(() => saveReview(next, opts, { planId: delta.planId, findings: [], resolved: [] }), /missing-check/);
    assert.equal(reviewPlan(next, { ...opts, policy: "v2" }).mode, "full");
    assert.equal(
      reviewPlan({ ...next, base_sha: first, target_head_sha: first, merge_base_sha: first }, opts).mode,
      "full",
    );
    saveReview(next, opts, {
      planId: delta.planId,
      findings: [],
      resolved: [{ id: finding.id, evidence: "second adds the check" }],
    });
    const replay = reviewPlan(next, opts);
    assert.equal(replay.mode, "reuse");
    assert.deepEqual(replay.unresolved, []);
    assert.throws(() => saveReview(next, opts, { planId: delta.planId, findings: [], resolved: [] }), /审查计划已变化/);
    const checked = { ...next, snapshot_id: "sha256:" + "2".repeat(64) };
    assert.equal(premerge(next, checked, opts).snapshotId, checked.snapshot_id);
    assert.throws(() => premerge(next, { ...checked, target_head_sha: first }, opts), /版本已变化/);
    assert.throws(() => premerge(next, { ...checked, draft: true }, opts), /开放状态/);
    const merged = { ...checked, merged: true, merged_commit_id: second };
    const evidence = {
      repository: "owner/repo",
      merge: second,
      release: second,
      live: second,
      successful: true,
      healthy: true,
    };
    assert.equal((await liveStatus(merged, evidence, root, instance)).phase, "live");
    await assert.rejects(liveStatus(merged, { ...evidence, live: first }, root, instance), /尚未核实/);
    await assert.rejects(liveStatus(merged, { ...evidence, successful: false }, root, instance), /尚未核实/);
    const testCommand = [
      process.execPath,
      "-e",
      `
      const change = require("node:fs").readFileSync("changes.txt", "utf8");
      if (change.includes("diff --git a/first b/first") === change.includes("diff --git a/second b/second")) process.exit(3);
      console.log(JSON.stringify({findings: []}));
    `,
    ];
    const reviewerOptions = {
      ...opts,
      store: join(root, "reviewer-ledger"),
      reviewer: { name: "original", command: testCommand },
    };
    assert.equal((await executeReview(snapshot, reviewerOptions)).ok, true);
    const renamed = { ...reviewerOptions, reviewer: { ...reviewerOptions.reviewer, name: "renamed" } };
    assert.equal((await executeReview(snapshot, renamed)).plan.mode, "reuse");
    const deltaRun = await executeReview(next, renamed);
    assert.equal(deltaRun.ok, true);
    assert.deepEqual(deltaRun.plan.range, [first, second]);
    assert.equal(reviewPlan(next, { ...renamed, reviewer: { ...renamed.reviewer, effort: "xhigh" } }).mode, "full");
    const failing = {
      ...opts,
      store: join(root, "failed-ledger"),
      reviewer: {
        name: "failure",
        command: [process.execPath, "-e", "console.error('mock failure');process.exit(4)"],
      },
    };
    assert.equal((await executeReview(snapshot, failing)).ok, false);
    assert.equal(reviewPlan(snapshot, failing).mode, "full");
    const snapshotFile = join(root, "snapshot.json");
    writeFileSync(snapshotFile, JSON.stringify(snapshot));
    const log = console.log;
    let output;
    console.log = (value) => {
      output = JSON.parse(value);
    };
    try {
      assert.equal(await cli(root, failing, ["run", snapshotFile, root]), 1);
      const receipt = readMessage(output.reply);
      assert.equal(receipt.outcome, "failed");
      assert.match(receipt.error, /owner\/repo #3.*mock failure/);
    } finally {
      console.log = log;
    }
    await assert.rejects(executeReview({ ...snapshot, state: "closed" }, failing), /开放状态/);
    git("checkout", "--detach", base);
    const rewritten = commit("rewritten");
    assert.equal(reviewPlan({ ...next, head_sha: rewritten }, opts).mode, "full");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A reviewer failure must yield a usable receipt and must never count as an empty review.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { REVIEW_MINUTES } from "../plugins/delivery/review.ts";
import { reviewResult, runReviewRound, reviewGuidance } from "../plugins/delivery/gitea-reviewer.mjs";

test("same finding keeps one ID and every location", () => {
  const finding = { id: "missing-check", title: "Missing check", text: "One symptom" };
  const answer = reviewResult(
    [
      { ...finding, locations: ["first.ts:2"] },
      { ...finding, locations: ["second.ts:3"] },
    ],
    [],
  );
  assert.equal(answer.findings.length, 1);
  assert.equal(reviewGuidance(2, answer.findings), undefined);
  assert.match(reviewGuidance(3, answer.findings), /新增改动/);
  assert.match(answer.findings[0].evidence, /first\.ts:2[\s\S]*second\.ts:3/);
});

test("real child failures retain stderr and a timeout has a specific receipt", async () => {
  assert.equal(REVIEW_MINUTES, 30);
  const path = mkdtempSync(join(tmpdir(), "gitea-review-run-"));
  try {
    const plan = { mode: "full", planId: "plan", unresolved: [] };
    const fail = await runReviewRound(path, plan, "fixture", "", {
      name: "codex",
      command: [process.execPath, "-e", "console.error('fixture error'); process.exit(9)"],
    });
    assert.equal(fail.ok, false);
    assert.match(fail.receipt.summary, /fixture error/);
    const timeout = await runReviewRound(
      path,
      plan,
      "fixture",
      "",
      {
        name: "codex",
        command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      },
      50,
    );
    assert.equal(timeout.ok, false);
    assert.match(timeout.receipt.summary, /30 分钟/);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

// Shared delivery decisions over Git and platform evidence. Adapters own API calls and mutations.
type Contains = (ancestor: string, descendant: string) => boolean | Promise<boolean>;

export function reviewStart(
  previous: string | undefined,
  head: string,
  compatible: boolean,
  contains: (ancestor: string, descendant: string) => boolean,
) {
  if (!previous || !compatible) return;
  if (previous === head || contains(previous, head)) return previous;
}

type MergeTarget = { head: string; base: string; branch: string };

export function sameMergeTarget(expected: MergeTarget, current: MergeTarget) {
  return expected.head === current.head && expected.base === current.base && expected.branch === current.branch;
}

export async function verifyRelease(
  merged: string,
  evidence: { release: string; successful: boolean; live: string | null },
  contains: Contains,
  releaseRequired?: (live: string, release: string) => boolean | Promise<boolean>,
): Promise<"live" | "docs_only" | null> {
  const { release, successful, live } = evidence;
  if (!successful || !live || !(await contains(merged, release))) return null;
  if (await contains(release, live)) return "live";
  if (releaseRequired && !(await releaseRequired(live, release))) return "docs_only";
  return null;
}

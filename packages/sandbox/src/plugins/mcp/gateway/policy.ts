import type { CanonicalToolPolicy } from '../schema.js';

/**
 * Filter the upstream's `tools/list` to what the guest is allowed to
 * see. With `defaultAction === 'allow'`, every upstream tool passes;
 * otherwise only tools mentioned by at least one policy are shown.
 * Argument constraints don't apply here — args aren't known until
 * `tools/call`, and we'd rather expose the tool name (so the guest can
 * attempt a call) than hide it because *some* arg combination is
 * blocked.
 */
export function filterToolsForList<T extends { name: string }>(
  tools: T[],
  policies: readonly CanonicalToolPolicy[],
  defaultAction: 'allow' | 'block',
): T[] {
  if (defaultAction === 'allow') return tools;
  const allow = new Set<string>();
  for (const p of policies) for (const t of p.tools) allow.add(t);
  return tools.filter((t) => allow.has(t.name));
}

/**
 * Outcome of {@link matchToolCall}. On denial, `reason` carries a
 * human-readable description of *why* the call was refused so the
 * forwarder can surface it to the guest. Two failure shapes:
 *
 * - `tool-not-allowed`: the tool name doesn't appear in any policy
 *   (with `defaultAction: 'block'`). The guest is calling a tool the
 *   sandbox simply isn't permitted to invoke.
 * - `argument-mismatch`: at least one policy named the tool, but each
 *   such policy had at least one `arguments` constraint that didn't
 *   match. `failures` lists per-policy details so a guest can see
 *   what value would have been accepted.
 */
export type ToolCallDecision =
  | { allow: true }
  | { allow: false; reason: string };

interface ArgumentMismatch {
  key: string;
  expected: string | number | boolean;
  /** `actual` is `undefined` when the call omitted the key entirely. */
  actual: unknown;
}

/**
 * First-match-wins evaluation of a `tools/call` against the per-server
 * policy list. A policy matches when `params.name` is in `policy.tools`
 * AND every key in `policy.arguments` (if set) equals (`===`) the
 * corresponding value on `params.arguments`. Extra keys on the call
 * are ignored (subset semantics). Missing key on the call = no match.
 *
 * No policy matched → fall through to `defaultAction`. When the result
 * is a denial, `reason` distinguishes "tool not in any policy" from
 * "policy named the tool but args didn't satisfy it" and lists the
 * specific mismatched key(s) so the caller can present an actionable
 * error.
 */
export function matchToolCall(
  policies: readonly CanonicalToolPolicy[],
  defaultAction: 'allow' | 'block',
  params: { name: string; arguments?: Record<string, unknown> | undefined },
): ToolCallDecision {
  const callArgs = params.arguments ?? {};
  // Per-policy mismatch records, only populated when a policy named the
  // tool but its `arguments` constraints were not satisfied.
  const argFailures: { mismatches: ArgumentMismatch[] }[] = [];
  let toolNameMatched = false;

  for (const policy of policies) {
    if (!policy.tools.includes(params.name)) continue;
    toolNameMatched = true;
    if (policy.arguments === undefined) {
      return { allow: true };
    }
    const mismatches: ArgumentMismatch[] = [];
    for (const [key, expected] of Object.entries(policy.arguments)) {
      const actual = callArgs[key];
      if (actual !== expected) mismatches.push({ key, expected, actual });
    }
    if (mismatches.length === 0) return { allow: true };
    argFailures.push({ mismatches });
  }

  if (defaultAction === 'allow') return { allow: true };

  if (!toolNameMatched) {
    return {
      allow: false,
      reason: `tool ${params.name} is not allowed for this sandbox`,
    };
  }

  // Tool name matched at least one policy but every such policy failed
  // on args. Report the first policy's failure — listing all of them
  // tends to be more noise than help, and first-match-wins is already
  // the evaluation order so the first failure is the most relevant.
  const first = argFailures[0];
  if (first === undefined) {
    // Defensive: shouldn't happen — toolNameMatched implies at least
    // one policy ran arg checks and either passed (would've returned
    // above) or pushed to argFailures.
    return { allow: false, reason: `tool ${params.name} is not allowed` };
  }
  const detail = first.mismatches
    .map((m) => formatArgumentMismatch(m))
    .join('; ');
  return {
    allow: false,
    reason: `tool ${params.name} call denied: ${detail}`,
  };
}

function formatArgumentMismatch(m: ArgumentMismatch): string {
  if (m.actual === undefined) {
    return `argument "${m.key}" is required (expected ${JSON.stringify(m.expected)}, but it was missing from the call)`;
  }
  return `argument "${m.key}" must equal ${JSON.stringify(m.expected)} (got ${JSON.stringify(m.actual)})`;
}

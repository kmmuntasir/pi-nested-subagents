/**
 * verify.ts — ground-truth tree rendering for the sub-agents extension.
 *
 * Native successor to the nesting-probe POC (`.pi/extensions/nesting-probe.ts`).
 * The probe had to reach the shared root manager via a globalThis Symbol; here
 * the manager is a direct reference, so this module is pure and testable.
 *
 * Used by:
 *   - the root-only `subagents_tree` tool (agent/programmatic dump)
 *   - the root-only `/agents-tree` command
 *   - the `verifyLog` setting's per-completion forensic log
 *
 * TODO(fork): the parent→child DFS below mirrors `ui/fleet-list.ts` (L~186–220).
 * Unify them — have FleetList call `buildRecordTree()` — so the TUI and the text
 * dump can never diverge. Kept independent here to avoid touching the working
 * TUI during the in-place integration; the fork should do the refactor.
 */
import type { AgentRecord } from "./types.js";

/** A built parent→child node. */
export interface TreeNode {
  record: AgentRecord;
  children: TreeNode[];
}

/** Result of building a flat record list into a forest. */
export interface BuiltTree {
  /** Top-level nodes (records whose parentId is absent OR not in the set). */
  roots: TreeNode[];
  /** Nesting depth → count of records at that depth. */
  byDepth: Map<number, number>;
}

/**
 * Group a flat record list into a parent→child forest. Roots are records whose
 * `parentId` is absent or refers to an id not in the set (defensive against a
 * root that was cleared from the registry). Children are sorted by `startedAt`
 * for stable, chronological ordering.
 */
export function buildRecordTree(records: AgentRecord[]): BuiltTree {
  const byId = new Map(records.map((r) => [r.id, r] as const));
  const nodeOf = new Map<string, TreeNode>();
  for (const r of records) nodeOf.set(r.id, { record: r, children: [] });

  const childrenOf = new Map<string, TreeNode[]>();
  const roots: TreeNode[] = [];
  for (const r of records) {
    const node = nodeOf.get(r.id)!;
    const parentKnown = !!r.parentId && byId.has(r.parentId);
    if (parentKnown) {
      const list = childrenOf.get(r.parentId!) ?? [];
      list.push(node);
      childrenOf.set(r.parentId!, list);
    } else {
      roots.push(node);
    }
  }
  const byStarted = (a: TreeNode, b: TreeNode) =>
    (a.record.startedAt ?? 0) - (b.record.startedAt ?? 0);
  for (const r of records) {
    const node = nodeOf.get(r.id)!;
    node.children = (childrenOf.get(r.id) ?? []).slice().sort(byStarted);
  }
  roots.sort(byStarted);

  const byDepth = new Map<number, number>();
  for (const r of records) byDepth.set(r.depth ?? 0, (byDepth.get(r.depth ?? 0) ?? 0) + 1);
  return { roots, byDepth };
}

export interface RenderTreeOptions {
  /** Optional event-name → count tally to append (lifecycle propagation check). */
  eventTally?: Map<string, number>;
  /** Optional title line. Default: `tree (<n> records)`. */
  title?: string;
}

/** Render the record forest as grep-friendly plain text (matches the POC format). */
export function renderRecordTreeText(records: AgentRecord[], opts: RenderTreeOptions = {}): string {
  const { roots, byDepth } = buildRecordTree(records);
  const short = (id?: string) => (id ? id.slice(0, 8) : "root");
  const lines: string[] = [];
  lines.push(`=== ${opts.title ?? `tree (${records.length} records)`} @ ${new Date().toISOString()} ===`);
  lines.push(
    "depth histogram: " +
      [...byDepth]
        .sort((a, b) => a[0] - b[0])
        .map(([d, n]) => `d${d}=${n}`)
        .join(" "),
  );
  const walk = (node: TreeNode, indent: number): void => {
    const r = node.record;
    lines.push(
      `${"  ".repeat(indent)}- [d${r.depth ?? 0}] ${r.type} #${short(r.id)} parent=${short(
        r.parentId,
      )} status=${r.status} "${r.description ?? ""}"`,
    );
    for (const c of node.children) walk(c, indent + 1);
  };
  for (const root of roots) walk(root, 0);

  if (opts.eventTally !== undefined) {
    lines.push("");
    lines.push("event tally (root bus): " + (opts.eventTally.size ? "" : "(none observed)"));
    for (const [k, v] of [...opts.eventTally.entries()].sort()) lines.push(`  ${k}: ${v}`);
  }
  return lines.join("\n");
}

# pi-nested-subagents — docs

This folder documents **why this fork exists**, **what it sets out to be**, and
**how it gets there**.

## Start here
- **[`fork-rationale-and-architecture.md`](./fork-rationale-and-architecture.md)** —
  the complete write-up: fork rationale (vs `tintinweb/pi-subagents`), the core
  vision (safe deep nesting + built-in verification), the Option-A architecture,
  the guardrails, the `clearCompleted` fix, the verification mechanism, and the
  validated POC results.

## Reference (deep-dive design notes, preserved for traceability)
- **[`reference/nesting-depth-plan.md`](./reference/nesting-depth-plan.md)** — the
  original plan for raising subagent nesting depth to 5–6: the six problems depth
  exposes (P1–P6), the Option A vs Option B architectural decision, per-file change
  inventory, phased rollout.
- **[`reference/verify-integration-analysis.md`](./reference/verify-integration-analysis.md)** —
  analysis of folding the verification probe natively into the extension (indirection
  removal, reuse of the FleetView DFS, settings integration, migration guide).

## Quick orientation
- **What changed vs upstream:** nesting (configurable depth, default 5), `parentId`
  tree, parent-routed notifications, descendant-scoped tools, fan-out/cost
  guardrails, the `clearCompleted` fix, and the `subagents_tree` tool /
  `/agents-tree` command / `verifyLog` forensic log.
- **What did NOT change:** everything else (scheduling, join modes, custom agents,
  worktree isolation, model scoping, the FleetView itself) is upstream as-is.
- **Validation:** a 4-level orchestration-shaped run produced an 11-record tree
  (`d1=1 d2=1 d3=2 d4=7`) with both sequential branches intact, 11/11 events
  propagated to the root bus — confirmed via the built-in `subagents_tree` tool.

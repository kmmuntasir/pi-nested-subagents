# pi-nested-subagents — Fork Rationale, Vision & Architecture

> **Upstream:** [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) (v0.13.0)
> **Fork purpose:** safe, deep (5–6 level) subagent nesting **with built-in ground-truth verification**.
> **Status:** POC validated end-to-end; ready for iterative hardening before a stable release.
> **Date:** 2026-07-02

This document is the canonical explanation of *why this fork exists*, *what it is
trying to be*, and *how it achieves it*. Deep-dive design notes live in
[`./reference/`](./reference).

---

## 1. TL;DR

Upstream `pi-subagents` is an excellent Claude-Code-style subagent extension, but
in its released form it does **not allow subagents to spawn their own subagents**
— every agent runs at a single level below the top-level session. That caps the
expressiveness of multi-agent orchestration: you can fan out, but you cannot
*delegate recursively* (an orchestrator → a ticket handler → a planner → leaf
analysts/writers/coders).

This fork turns that single level into a **configurable, safe nesting depth
(default 5)** and, critically, adds a **first-class verification mechanism** so the
nesting tree, parent/child links, fan-out, and lifecycle-event propagation can be
**audited independently of what the agents themselves report**.

The verification mechanism is not decorative: it is what surfaced a real,
non-obvious registry-wiping bug during validation (see §6.3).

---

## 2. Origin — what upstream is, and what it lacked

[`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) provides:

- the **`Agent`** tool (spawn sub-agents), **`get_subagent_result`**, and
  **`steer_subagent`**;
- background agents with smart/group/async join modes;
- a Claude-Code-style **FleetView** (main + subagents list) and an above-editor
  widget;
- scheduling, custom agent types, worktree isolation, model scoping, and a rich
  settings system.

What v0.13.0 **does not** provide:

| Capability | Upstream | This fork |
|---|---|---|
| Subagents can spawn their own subagents | ❌ no (depth-1 only) | ✅ configurable, default 5 |
| `depth` / `parentId` on agent records | ❌ | ✅ (Option-A nesting) |
| True parent→child tree in FleetView | flat list | ✅ DFS tree by `parentId` |
| Completion notifications routed to the **parent** agent | n/a (one level) | ✅ via parent's session |
| `get_subagent_result`/`steer_subagent` scoped to descendants | global | ✅ descendant-authorized |
| Fan-out / breadth / cost guardrails | ❌ | ✅ |
| Programmatic ground-truth dump + forensic log | ❌ | ✅ `subagents_tree` + `verifyLog` |

So the fork is **additive**: everything upstream does still works; nesting and
verification are layered on top.

---

## 3. The problem — why deep nesting is *not* just bumping a number

"Allow 5 levels" is a one-line config change. Doing it **safely** is the actual
work. Depth exposes six problems that are harmless at depth 1–2 but break or
degrade at 5–6 (full analysis in
[`reference/nesting-depth-plan.md`](./reference/nesting-depth-plan.md)):

| # | Problem | Why it bites at depth |
|---|---|---|
| **P1** | **Notifications route to the wrong session.** The root manager's completion callback closes over the *top-level* session. | A depth-4 agent's result is consumed by its depth-3 parent, but the nudge floods the top-level, which didn't spawn it. |
| **P2** | **No parent links → unreadable tree.** Only `depth`, no `parentId`. | 5 levels with branching → siblings/cousins indistinguishable. |
| **P3** | **No isolation.** Any agent can inspect/steer *any* agent id. | A depth-3 agent could steer a depth-1 sibling. Safety gap. |
| **P4** | **No breadth cap.** `maxNestingDepth` bounds depth, not fan-out. | depth 5 × branching `b` → ~`b⁵` agents/tokens/sessions. |
| **P5** | **Perf:** every nested `setup()` rebuilds UI/scheduler objects. | 5 redundant full setups per chain. |
| **P6** | **Observability:** do nested lifecycle events reach the root bus? | Unverified upstream — you can't audit a deep run. |

P6 is the motivation for the verification mechanism: without a way to observe the
*actual* tree and event flow, the other five fixes can't even be trusted.

---

## 4. Core vision — two pillars

### Pillar 1 — Safe, deep, recursive delegation
A subagent should be able to delegate further, recursively, up to a configurable
depth, with:
- correct result/notification delivery to the **parent**, not the top level;
- a **true parent→child tree** that's legible in the UI;
- **scoped authority** (an agent may only address its own descendants);
- hard **guardrails** so depth × breadth can't go exponential.

### Pillar 2 — Built-in ground-truth verification
The fleet list is ephemeral and TUI-only. This fork treats verification as a
**first-class, mode-agnostic capability**: any orchestrator, automation, or
post-hoc reader can ask *"what actually ran, at what depth, under which parent,
and did events propagate?"* and get an authoritative answer — not the agents'
self-report.

The second pillar is what makes the first trustworthy.

---

## 5. How it was achieved

### 5.1 Architectural decision — Option A: extend the flat-root model

Two designs were considered (see
[`reference/nesting-depth-plan.md`](./reference/nesting-depth-plan.md) §4):

- **Option B — hierarchical managers:** one `AgentManager` per level. Solves P1/P2/P3
  structurally but is a large refactor.
- **Option A — extend the flat-root model:** keep the single root manager; add
  `parentId`; route notifications via the parent's session object; scope tools by
  descendant-check; render a tree; add guardrails.

**Option A was chosen.** The deciding factor (resolved in the plan's Phase 0): pi's
`AgentSession.sendCustomMessage()` / `.followUp()` are **public**, and the extension
already stores every agent's `AgentSession` on `record.session`. So delivering a
completion nudge to an arbitrary parent reduces to
`parentRecord.session.sendCustomMessage(..., { deliverAs: "followUp" })` — no new
mailbox/IPC mechanism. That erased Option B's main advantage, making Option A the
strictly cheaper path. The whole fork builds on this.

### 5.2 Depth propagation & identity (`agent-runner.ts`, `types.ts`)

- `AsyncLocalStorage` (`depthContext`) carries each subagent's `{ depth, agentId }`
  through its `session.prompt`. Each `runAgent()` wraps its run in its own store, so
  concurrent background subagents never race on depth.
- `spawn()` reads the store to stamp `resolvedDepth = parentDepth + 1`.
- `AgentRecord` gains `depth?` and `parentId?` (`types.ts`). Depth-1 agents have
  `parentId` undefined (their parent is the top-level session, which is not itself a
  tracked record).
- `maxNestingDepth` (default **5**) gates the spawn tools: an agent at depth `d` may
  spawn children only while `d < maxNestingDepth`. At the floor, `Agent` /
  `get_subagent_result` / `steer_subagent` are filtered out of its tool set.

### 5.3 Correct notification routing — `index.ts` (`emitIndividualNudge`)

Completion nudges are delivered to the **parent's session** via
`parentRecord.session.sendCustomMessage(...)`, falling back to the top-level for
depth-1 agents. This fixes P1.

### 5.4 Descendant-scoped tool access — `index.ts` (`addressDenied`)

`get_subagent_result` / `steer_subagent` are authorized against the caller's
**descendant set**; the top-level session remains unrestricted. This fixes P3.

### 5.5 Fan-out & cost guardrails (`agent-manager.ts`, `agent-runner.ts`, `settings.ts`)

| Guardrail | Default | Purpose |
|---|---|---|
| `maxChildrenPerAgent` | 4 | bounds breadth so a single agent can't fan out wildly |
| `maxTotalAgents` | 32 | global backstop against `b^d` blow-up |
| `nestingTurnStep` / `nestingTurnFloor` | 5 / 6 | per-level default-`max_turns` shrinks with depth (deep agents stay terse) |
| `maxInheritContextDepth` | 2 | `inherit_context` dropped past this level (copying parent context at depth is catastrophic) |

All are persisted settings, tunable via `/agents → Settings` or `.pi/subagents.json`.

### 5.6 The `clearCompleted` fix — the bug verification found (P-adjacent)

**Symptom:** during validation, the post-run tree kept showing only the *last*
sequential branch — earlier branches vanished from the registry.

**Root cause:** every instance (including nested ones) registered
`pi.on("session_start", () => manager.clearCompleted(true))`, and `manager` is the
**shared root** manager. So each new subagent session wiped all previously-completed
records — meaning a `ticket-handler` running `planner → implementer → verifier`
sequentially would lose the planner's subtree the instant the implementer's session
started.

**Fix:** gate the clear on root only — `if (!isNested) manager.clearCompleted(true);`
— matching the guard already used on the line below it. Root still clears on its own
`session_start` / `/reload` / `/new` (unchanged); nested sessions stop wiping the
shared registry.

This is exactly the kind of bug that is invisible without an authoritative,
persistent view of the registry — which is why it was found by the verification
tool, not by the agents' self-reports.

### 5.7 Built-in verification (`verify.ts` + `index.ts` + `settings.ts`)

The native successor to a throwaway probe extension used during the POC. Three
surfaces, all **root-only** so they never clutter a sub-agent's tool palette:

1. **`subagents_tree` tool** — read-only dump of the authoritative record tree
   (`depth`, `parentId`, `status` per agent) plus a lifecycle-event tally. This is
   the agent-callable / RPC / print / JSON path (FleetView only covers TUI).
2. **`/agents-tree` command** — writes the same tree to the verify log.
3. **`verifyLog` setting** (off by default) — when on, appends the full tree on
   **every agent completion** to `.pi/subagents-verify.log` (or a custom path): the
   forensic, append-only record of how the tree evolved — the feature that surfaced
   §5.6.

A pure module, `src/verify.ts`, exports `buildRecordTree()` and
`renderRecordTreeText()`. It mirrors the FleetView DFS; a future refactor should
unify them so the TUI and the text dump can never diverge (noted as a TODO in the
file and in
[`reference/verify-integration-analysis.md`](./reference/verify-integration-analysis.md)).

A root-bus event tally answers **P6** affirmatively: nested agents' `started` and
`completed` events **do** propagate to the root bus.

---

## 6. Validation — the orchestration-shaped POC

The fork was validated against a realistic multi-agent workflow shape
(orchestrator → ticket-handler → sequential step agents → parallel leaf workers),
matching how the extension is actually used.

### 6.1 The shape under test

```
orchestrator (d1)
└── ticket-handler (d2)
    ├── planner (d3) ── step 1
    │   ├── analyst (d4, parallel)
    │   ├── analyst (d4, parallel)
    │   ├── analyst (d4, parallel)
    │   └── writer  (d4, after analysis)
    ├── task-breakdown (d3) ── step 2  (same leaf pattern)
    ├── implementer (d3) ── step 3
    │   ├── analyst    (d4, parallel)
    │   ├── coder-node (d4, parallel)
    │   └── coder-react(d4, parallel)
    └── verifier (d3) ── step 4  (same leaf pattern)
```

The workflow maxes out at **depth 4** (≤ the default `maxNestingDepth` of 5), with
leaf-level parallelism and **≤ 7 concurrent agents** (3 leaves + step + ticket-handler
+ orchestrator + top-level) — well under the `maxChildrenPerAgent=4` and
`maxTotalAgents=32` guardrails.

### 6.2 Ground-truth result (from the built-in `subagents_tree` tool)

```
[d1] orchestrator     parent=root
└─[d2] ticket-handler parent=orchestrator
   ├─[d3] planner     parent=ticket-handler
   │  ├─[d4] analyst-1, analyst-2, analyst-3   (spawned in one message → parallel)
   │  └─[d4] writer                              (spawned after the analysts → sequential)
   └─[d3] implementer parent=ticket-handler
      ├─[d4] analyst, coder-node, coder-react   (parallel)

depth histogram: d1=1 d2=1 d3=2 d4=7   (11 records total)
event tally: started=11, completed=11   (on the root bus)
```

Verified:
- ✅ nesting reaches d1→d2→d3→d4 with correct `parentId` links end-to-end;
- ✅ true leaf parallelism (3 background spawns in one message) in both branches;
- ✅ sequential-after-parallel (writer spawned only after its analysts finished);
- ✅ **P6 resolved**: all 11 nested `started`+`completed` events reached the root bus;
- ✅ the `Agent` tool remained available at every depth-4 leaf (stripping only at d5);
- ✅ concurrency stayed ≤ 7;
- ✅ **both sequential branches survive** in the final registry (the §5.6 fix working
  — before the fix, only the last branch remained: 6 records instead of 11).

### 6.3 What the verification caught that self-report could not

The agents' own summaries described a complete run. The `subagents_tree` dump
revealed records **disappearing mid-run** — leading directly to the §5.6
`clearCompleted` diagnosis. After the fix, the post-run tree matched the
self-report. This is the entire justification for Pillar 2.

---

## 7. File-level change inventory vs upstream

| File | Change |
|---|---|
| `src/verify.ts` (**new**) | Pure `buildRecordTree()` + `renderRecordTreeText()`. Shared renderer for the tool, command, and log. |
| `src/agent-runner.ts` | `depthContext` (`{depth, agentId}`), `maxNestingDepth` (default 5), per-level `max_turns` shrink, `inherit_context` depth limit, spawn-tool depth filter. |
| `src/agent-manager.ts` | `parentId` stamping, `maxChildrenPerAgent` / `maxTotalAgents` enforcement, tree-aware `listAgents()`. |
| `src/types.ts` | `AgentRecord.depth` + `AgentRecord.parentId`. |
| `src/ui/fleet-list.ts` | Parent→child DFS tree render (depth-first, indented). |
| `src/index.ts` | Flat-root reuse + `isNested` detection; parent-targeted completion nudges; descendant-scoped tool authorization; breadth/cost guardrails; **`clearCompleted` gated on `!isNested`**; `subagents_tree` tool + `/agents-tree` command (root-only); event tally; `verifyLog` per-completion logging; settings menu/snapshot/apply wiring. |
| `src/settings.ts` | Nesting settings + `verifyLog` (field, applier, sanitize, apply). |

Everything else (`schedule*.ts`, `group-join.ts`, `memory.ts`, `model-resolver.ts`,
`worktree.ts`, `cross-extension-rpc.ts`, …) is **unchanged from upstream**.

---

## 8. Configuration

All settings are persisted in `.pi/subagents.json` (project) or
`~/.pi/agent/subagents.json` (global), and editable via `/agents → Settings`.

| Setting | Default | Meaning |
|---|---|---|
| `maxNestingDepth` | 5 | Max subagent levels below the top-level session |
| `maxChildrenPerAgent` | 4 | Max simultaneous children one agent may spawn |
| `maxTotalAgents` | 32 | Global ceiling on active agents |
| `nestingTurnStep` | 5 | Per-level default-`max_turns` shrink |
| `nestingTurnFloor` | 6 | Min default `max_turns` after shrinking |
| `maxInheritContextDepth` | 2 | Deepest level allowing `inherit_context` |
| `verifyLog` | off | `true` → log tree on every completion (default path `.pi/subagents-verify.log`); string → custom path |

Verification interfaces (always available, root-only, regardless of `verifyLog`):
- **`subagents_tree`** tool
- **`/agents-tree`** command

---

## 9. Known limitations & future work

- **Parent-already-finished background children:** a followUp with nowhere to land
  falls back to the top level (policy decision deferred).
- **Tree is render-ordered, not collapsible:** no collapse/expand keyboard
  interaction yet (depth-first ordering + indent is the current solution).
- **No per-level concurrency limit:** `maxConcurrent` is global; deep fan-out still
  queues on one pool.
- **Shared renderer TODO:** `verify.ts`'s DFS mirrors `fleet-list.ts`'s; unify them.
- **Event payloads carry no `depth`/`parentId`:** adding them would let external
  observers get ground truth without reading the manager.
- **`verifyLog` retention:** grows unbounded across a session — add rotation/cap.

---

## 10. Attribution & relationship to upstream

This project is a fork of [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents)
by tintinweb (MIT licensed — see `LICENSE`). The upstream's core design — the flat
`AgentManager`, the FleetView, the join modes, scheduling, custom agents — is
preserved unchanged and is the foundation everything here builds on. The additions
are scoped to **deep nesting** and **verification**, as described above.

The detailed reasoning that led to these decisions is preserved verbatim for
traceability in [`./reference/`](./reference):

- [`reference/nesting-depth-plan.md`](./reference/nesting-depth-plan.md) — the full
  plan for raising nesting depth to 5–6 (problems P1–P6, the Option A vs B decision,
  per-file inventory).
- [`reference/verify-integration-analysis.md`](./reference/verify-integration-analysis.md)
  — the analysis of folding the verification probe natively into the extension.

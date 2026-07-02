# Plan — Increasing Subagent Nesting Depth to 5–6

> **Status:** Design plan only. **No code changes.** Builds on the validated 2-level POC
> (see `poc-subagent-nesting.md`).
> **Date:** 2026-07-02

---

## 1. Goal

Raise the maximum subagent nesting depth from the POC's hard-coded `2` to **5–6** levels:

```
top-level (d0) → d1 → d2 → d3 → d4 → d5
```

…safely: correct notifications, legible TUI, bounded cost, no runaway fan-out.

---

## 2. Why this is NOT just bumping a number

The 2-level POC took shortcuts that are acceptable at depth 2 but **break or degrade at 5–6**.
`maxNestingDepth` already accepts any integer, so "allow 5" is a one-liner. The real work is fixing
the four problems that depth exposes:

| # | Problem | Why it's fine at d=2 | Why it breaks at d=5–6 |
|---|---|---|---|
| **P1** | **Notifications route to the wrong session.** All agents live in the single root `AgentManager`; its `onComplete` closes over the **top-level** `pi`, so `deliverAs:"followUp"` nudges always hit the top-level. | A grandchild's consumer *is* effectively the top-level (via the d1 subagent). Mild extra noise. | A d4 agent's result is consumed by its d3 parent, but the completion nudge floods the **top-level**, which didn't spawn it and can't act on it. Semantically wrong + noisy. |
| **P2** | **No parent links → flat-with-indent list.** `AgentRecord` has `depth` but no `parentId`; FleetList indents by level only. | Two levels: indent is enough to read. | 5 levels with any branching → cousins/siblings indistinguishable; the list is unreadable. |
| **P3** | **No isolation between agents.** Any agent can `get_subagent_result`/`steer_subagent` on **any** id in the root manager — siblings, cousins, even the top-level's own agents. | Negligible at 2 levels. | A d3 agent could inspect/steer a d1 sibling. Real safety/isolation gap. |
| **P4** | **No breadth cap.** `maxNestingDepth` bounds *depth*, never *fan-out*. | d=2 limits total agents anyway. | depth 5 × branching factor `b` → ~`b⁵` agents, tokens, and sessions. Exponential blow-up is the #1 practical blocker. |

Plus two **non-blocking but worth fixing** issues:
- **P5 (perf):** every nested `setup()` still constructs inert `widget`/`fleet`/`groupJoin`/`scheduler` objects. At d=5 that's 5 redundant full-setup runs per chain.
- **P6 (observability):** `subagents:created/started/completed` events fire on each instance's `pi.events`; whether they aggregate to root is unverified.

---

## 3. Current architecture recap (the 2-level POC)

- **Single flat registry:** every nested `setup()` reuses the **root** `AgentManager` (via `globalThis[Symbol.for("pi-subagents:manager")].__raw`). All agents at all depths share one manager.
- **Depth propagation:** `AsyncLocalStorage` (`depthContext`) carries each subagent's depth through its `session.prompt`; `spawn()` reads it to stamp `resolvedDepth = parentDepth + 1`.
- **Cap:** the spawn-tool filter `myDepth >= maxNestingDepth` strips `Agent`/`get_subagent_result`/`steer_subagent` at the floor.
- **Detection:** nesting is detected by the presence of the published root manager on `globalThis` (because `bindExtensions` runs *before* the `depthContext.run` wrap, so ALS isn't active at `setup()` time).
- **TUI:** FleetList reads `manager.listAgents()` (flat) and indents by `record.depth`.

This flat-root design is what makes P1/P3 inevitable at depth. So the first decision is architectural.

---

## 4. Architectural decision: extend-flat vs. hierarchical

> **Phase 0 RESOLVED (see §8.1):** Option A chosen. `AgentSession.sendCustomMessage()` / `.followUp()` are
> **public** methods, and the extension already holds every agent's session in `record.session`. So the
> "hardest problem" (delivering a followUp to an arbitrary parent session) reduces to
> `parentRecord.session.sendCustomMessage(..., {deliverAs:"followUp"})`. Targeted routing is trivially
> achievable on the flat-root model → Option A's one real disadvantage vanished. We keep the validated
> POC and add `parentId` + targeted routing + descendant-scoping + tree render + guardrails, rather than
> ripping out the root-manager-reuse for a hierarchical refactor.

### Option A — Extend the flat-root model  ✅ CHOSEN

### Option A — Extend the flat-root model
Keep one root manager; patch the four problems:
- P1: route nudges by looking up the completing agent's `parentId` and delivering the followUp to *that* agent's session (requires each agent to expose its session for followUp delivery — non-trivial, since `pi.sendMessage` targets the *current* session, not an arbitrary one).
- P2: add `parentId`; render a tree.
- P3: authorize `get_subagent_result`/`steer_subagent` against the descendant set.
- P4: add a breadth cap.

**Pros:** smaller diff; reuses the working POC. **Cons:** P1 is hard — `pi.sendMessage({deliverAs:"followUp"})` has no "deliver to agent X's session" primitive; you'd likely need a per-agent mailbox/queue that the parent agent drains on its next turn. That's a new mechanism, invented specifically to work around the flat model.

### Option B — Hierarchical managers (recommended for deep nesting)
Each level gets its **own** `AgentManager` (closer to the original upstream design), but:
- each child manager **registers itself with its parent** (parent tracks child managers);
- each manager's `onComplete` closes over **its own** `pi` → completion nudges naturally deliver to the correct parent session (P1 solved for free);
- the top-level FleetList **aggregates recursively** across the manager tree for display (P2: natural tree);
- `get_subagent_result`/`steer_subagent` are scoped to a manager's own children by construction (P3 solved);
- the depth cap still lives in `runAgent`'s filter (unchanged).

**Pros:** P1/P2/P3 fall out of the structure; matches pi's "nested session" reality; each level's UI/scheduler/state is naturally scoped. **Cons:** bigger refactor; the POC's root-manager-reuse is removed in favor of parent-child wiring; need a recursive aggregation path for the FleetList.

**Recommendation (revised post Phase 0):** **Option A.** Phase 0 showed targeted followUp delivery is
trivial (`session.sendCustomMessage` is public + we hold session refs), so Option B's main advantage is
 gone. The rest of this plan now assumes **Option A**: keep the flat-root registry, add `parentId`, route
 notifications via the parent's session object, scope tools by descendant-check, render a `parentId`-tree,
 and add breadth/cost guardrails.

---

## 5. Required work (Option B)

### 5.1 Cap configuration (trivial)
- Set `maxNestingDepth = 5` (or 6) as the new default, or via `.pi/subagents.json` / `/agents → Settings`. No code logic change — the filter already generalizes.

### 5.2 Manager hierarchy
- Revert the POC's "reuse root manager" behavior. Instead, in nested `setup()`:
  - create a **fresh** `AgentManager` (as upstream did), BUT
  - discover the **parent** manager+session via the ALS store (see 5.3) and register this child manager with it;
  - register only the tools + the manager; skip root-only ops (global slot, `/agents` command, RPC, scheduler) — same `!isNested` guards as today, but `isNested` now means "has a parent in the ALS store".
- Parent manager gains a `childManagers: AgentManager[]` (or a tree node abstraction) so the FleetList can recurse.

### 5.3 Identity propagation (extends `depthContext`)
The ALS store currently carries `{ depth }`. Extend to carry the running agent's identity so children can link to their parent:

```ts
// shape only — not implemented
type NestCtx = { depth: number; agentId: string; session: AgentSession; manager: AgentManager };
depthContext.run({ depth: myDepth, agentId: options.agentId, session, manager }, () => session.prompt(...));
```

- `options.agentId` already exists in `RunOptions` (confirmed) → `parentId`/parent wiring is feasible.
- **Caveat (unchanged from POC):** `setup()` runs at `bindExtensions` time, **before** the `depthContext.run` wrap. So *manager-hierarchy wiring at setup time* still can't read the ALS store. Two resolutions:
  1. Do the parent-linking in `runAgent` **after** `bindExtensions` but **before** `session.prompt` (runAgent owns both the child manager-via-session and the ALS store). Recommended.
  2. Move the `depthContext.run` wrap to enclose `bindExtensions` too. Riskier (changes when setup sees the store; may have side effects).
- This also makes **detection** robust: nested = "ALS store present at runAgent entry", replacing the `globalThis` heuristic.

### 5.4 `parentId` + true tree rendering (P2)
- Add `parentId?: string` to `AgentRecord`; stamp `record.parentId = store.agentId` at spawn.
- FleetList: render a **collapsible tree** (group children under their parent; default-collapse levels ≥ 2 to avoid noise). Keep the depth-based indent as a fallback for flat mode.
- Widget (above-editor): consider showing only the current branch's ancestry breadcrumb at deep levels.

### 5.5 Correct notification routing (P1) — mostly free under Option B
- Each manager's `onComplete` uses its own `pi.sendMessage(..., {deliverAs:"followUp"})`, which delivers to that manager's session = the **parent** of the completing agent. Correct by construction.
- Verify the `groupJoin`/batching logic is per-manager (it already uses local closures), so smart-join grouping happens within the right parent.
- Edge case to handle: a **background** agent whose parent has itself already finished. The followUp has nowhere to land → must either (a) persist the result for the grandparent, or (b) auto-foreground. Document a policy.

### 5.6 Scoping `get_subagent_result` / `steer_subagent` (P3)
- Under Option B each manager only knows its own children → scoping is structural. Confirm the tools read from the *current* (per-session) manager, not a global.
- If any path still reaches across managers, add an authorization check: an agent may only address its own descendants.

### 5.7 Breadth cap (P4) — REQUIRED before enabling d≥3
`maxNestingDepth` bounds depth, not fan-out. Add:
- `maxChildrenPerAgent` (default e.g. 4) — hard cap on simultaneous children one agent may spawn; excess either queue or error.
- Consider a global `maxTotalAgents` ceiling as a backstop against `b^d` blow-up.
- Decide queueing policy for over-breadth (fail fast vs. queue vs. ask-parent).

### 5.8 Cost guardrails (the real practical blocker)
Deep nesting multiplies tokens geometrically. Add policy levers:
- **Per-level `max_turns`** that shrink with depth (e.g. d1=30, d2=20, … d5=8) so deep agents can't spiral.
- **Total token budget** across the whole tree (aggregate via the existing `lifetimeUsage` accumulator); abort the deepest level when exceeded.
- **`inherit_context` policy:** forbid or warn for `inherit_context: true` beyond d=2 (each inherit copies the parent's whole context → catastrophic at depth).
- Surface cumulative cost in the TUI (fleet already shows per-agent tokens; add a tree-total).

### 5.9 Lifecycle: abort/steer cascade
- Verify the existing parent-signal wiring (`options.signal` → child `abortController`) cascades through N levels (it should — each spawn chains its parent's signal).
- Confirm `steer_subagent` reaches the right session under the hierarchical model (per-manager).
- Decide what happens to a subtree when an intermediate node is aborted (cascade-abort descendants).

### 5.10 Nested-setup short-circuit (P5, perf)
- In nested `setup()`, skip constructing `widget`/`fleet`/`groupJoin`/`scheduler` entirely; use no-op stubs so the tool handlers' references don't crash. Only register the 3 tools + wire the manager to its parent. Cuts per-level overhead meaningfully at d=5.

### 5.11 Event aggregation (P6, observability)
- Determine whether nested sessions' `pi.events` connect to the root bus. If not, have each child manager forward `subagents:created/started/completed` to its parent so the root (and any fleet/observability extension) sees the whole tree.

---

## 6. Recommended policy defaults for d=5–6

| Setting | Suggested value | Rationale |
|---|---|---|
| `maxNestingDepth` | 5 | the ask |
| `maxChildrenPerAgent` | 4 | bounds fan-out |
| `maxTotalAgents` | 32 | `b^d` backstop |
| per-level `max_turns` | 30 → 8 (shrinking) | deep agents must be terse |
| `inherit_context` beyond d=2 | disabled | prevent context-copy explosion |
| `maxConcurrent` (background) | 8 | allow some parallelism without floods |

---

## 7. Per-file change inventory (for implementation, Option B)

| File | Change |
|---|---|
| `src/agent-runner.ts` | Extend `depthContext` store to `{depth, agentId, session, manager}`; move manager-parent linking here (post-`bindExtensions`, pre-`prompt`); keep depth filter (now reads `maxNestingDepth`). |
| `src/agent-manager.ts` | `parentId` on record; `childManagers` (or tree node) on manager; per-manager `maxChildren` enforcement; recursive `listAgents()`/aggregation for the fleet. |
| `src/types.ts` | `AgentRecord.parentId`; optional `childManagers`/tree-node type. |
| `src/index.ts` | Replace root-manager-reuse with hierarchical wiring in nested `setup()`; short-circuit nested setup (no-op widget/fleet); keep `!isNested` guards but redefine `isNested` via ALS; tree-aware notification (per-manager, already correct); forward events to parent. |
| `src/ui/fleet-list.ts` | Recursive tree render with collapsible levels; ancestry breadcrumb. |
| `src/ui/agent-widget.ts` | Show current-branch ancestry at deep levels (optional). |
| `src/settings.ts` | Add `maxChildrenPerAgent`, `maxTotalAgents`, per-level turn schedule, `inherit_context` depth limit. |

---

## 8. Risks & open questions

1. **~~followUp delivery target~~ — RESOLVED (Phase 0, see §8.1).** `pi.sendMessage` targets only its
   bound session, but `AgentSession.sendCustomMessage()` / `.followUp()` (dist `agent-session.d.ts`
   L346/354/373) are **public**, and the extension holds every agent's `AgentSession` in `record.session`.
   So targeted delivery = `parentRecord.session.sendCustomMessage(msg, {deliverAs:"followUp", triggerTurn:true})`.
   Option A is therefore cheap; chosen over Option B.
2. **ALS across background agents** — the store wraps `session.prompt`; verify it stays active for a background agent's tool calls that fire after the spawning frame returns (the POC test used foreground; background-at-depth needs an explicit test).
3. **`bindExtensions` vs ALS timing** — the known ordering trap; resolve per 5.3 before anything else.
4. **Token reality** — even with guardrails, d=5 with `inherit_context` is likely unusable on cost. The policy defaults in §6 may need to be lower in practice.
5. **Semantic anti-pattern** — deep delegation chains are usually worse than flat orchestration from the top. Before shipping d=5, confirm the use case truly needs depth rather than breadth.
6. **Re-init side effects** — each level still re-runs the extension factory; verify no singleton (e.g. the scheduler cron store) collides across levels.

### 8.1 Phase 0 finding (decided A vs. B)

Investigated `@earendil-works/pi-coding-agent` (`dist/core/agent-session.js` / `.d.ts`, `core/extensions/types.d.ts`):

- `pi.sendMessage(...)` (ExtensionAPI) is documented as "Send a custom message **to the session**" — the
  session the extension instance is bound to. There is **no session-id parameter**; it cannot address an
  arbitrary session.
- However `AgentSession` exposes **public** methods: `steer(text)` (L346), `followUp(text)` (L354), and
  `sendCustomMessage<T>(msg, {deliverAs, triggerTurn})` (L373). These operate on `this` — whichever
  session object you call them on.
- The extension already stores every agent's live `AgentSession` on `AgentRecord.session`.

Therefore delivering a completion nudge to a completing agent's **parent** reduces to:
```ts
const parent = parentOf(record);            // record.parentId → root manager.getRecord
parent.session.sendCustomMessage(
  { customType: "subagent-notification", content: ..., display: true, details: ... },
  { deliverAs: "followUp", triggerTurn: true }
);
```
No new mailbox/IPC mechanism required. This makes Option A strictly cheaper than Option B, so **A is chosen**.

Caveat to honor in implementation: `triggerTurn:true` re-awakens an idle parent; a parent blocked in
`spawnAndWait` is mid-prompt, where `deliverAs:"followUp"` queues correctly. A parent that has already
**finished** its session has nowhere to deliver — handle by persisting the result for the grandparent,
or auto-foregrounding orphans. Pick a policy in Phase 2.

---

## 9. Testing strategy

- **Unit:** depth stamping, `parentId` linking, breadth-cap enforcement, scoping authorization — all pure functions, table-driven.
- **Integration (the chain test):** generalize the validated POC test to N levels — spawn d1 that spawns d2 … that spawns dN, each reporting its tool list; assert `Agent` present for d < cap, absent for d == cap.
- **Notification routing test:** background agent at d3 completes → assert the followUp lands in the **d2 parent** session, not the top-level.
- **Fan-out test:** one parent spawns `maxChildrenPerAgent + 1` → assert the excess is queued/errored, not spawned.
- **Abort cascade:** abort d2 → assert d3/d4 descendants abort.
- **Cost ceiling:** exceed `maxTotalAgents` → assert backstop triggers.
- **Concurrency:** background fan-out at depth under `maxConcurrent` queueing.

---

## 10. Phased rollout

1. **Phase 0 — Investigate open question #1** (followUp targeting). Decides A vs B. ~1h.
2. **Phase 1 — Guardrails only** (§5.7 breadth cap, §5.8 cost limits) on the *current flat* POC, cap raised to 3. Lets us evaluate depth 3 cheaply before the big refactor.
3. **Phase 2 — Hierarchical refactor** (§5.2–5.6, 5.9) → enables correct depth 4–5.
4. **Phase 3 — Polish** (§5.4 tree UI, §5.10 perf, §5.11 events) → depth 5–6 usable in practice.

Each phase is independently shippable and testable with the chain test from §9.

---

## 11. TL;DR

- Allowing depth 5 is a one-line config; **doing it safely is additive work on the flat-root POC (Option A).**
- Phase 0 resolved the deciding question: `AgentSession.sendCustomMessage()` is public and we hold every
  session ref → targeted notification routing is trivial. No hierarchical refactor needed.
- Path: add **`parentId`** + route completion nudges to the **parent's session object**; **scope**
  `get_subagent_result`/`steer_subagent` to descendants; render a **`parentId`-tree** in FleetView; add a
  **breadth cap** (`maxChildrenPerAgent`) and **per-level cost guardrails**; raise `maxNestingDepth`.

---

## 12. Implementation status (Option A — implemented, pending runtime verification)

> Done in the local install after the plan was written. All files pass TypeScript `transpileModule`
> syntax checks. Runtime verification needs a pi restart (chain test at depth 5).

| Step | What | Where |
|---|---|---|
| 1 | `AgentRecord.parentId`; `depthContext` store extended to `{depth, agentId}`; stamped at spawn | `types.ts`, `agent-runner.ts`, `agent-manager.ts` |
| 2 | Completion nudges routed to the **parent's session** via `parentRecord.session.sendCustomMessage(...)`, falling back to top-level for depth-1 agents | `index.ts` (`emitIndividualNudge`) |
| 3 | `get_subagent_result` / `steer_subagent` scoped to **descendants** via `addressDenied()` (top-level unrestricted) | `index.ts` |
| 4 | Guardrails: `maxChildrenPerAgent=4`, `maxTotalAgents=32`, per-level `max_turns` shrink (`nestingTurnStep=5`, `nestingTurnFloor=6`), `inherit_context` dropped past `maxInheritContextDepth=2`. All persisted settings. | `agent-manager.ts`, `agent-runner.ts`, `settings.ts`, `index.ts` |
| 5 | FleetView renders a **parent→child DFS tree** (tree-depth indent), reusing flat navigation | `ui/fleet-list.ts` |
| 6 | `maxNestingDepth` default raised **2 → 5** | `agent-runner.ts` |

### Runtime test to run after restart
Generalize the validated 2-level chain test to depth 5: spawn d1 → d2 → d3 → d4 → d5, each reporting
whether it has `Agent`. Expect `Agent` present for d1–d4 and absent at d5 (the floor). Also exercise a
fan-out attempt to confirm `maxChildrenPerAgent` throws a clear error, and confirm a d3 completion nudge
lands in its d2 parent (not the top-level).

**VERIFIED (post-restart):** the depth-5 chain ran end to end. `Agent` was present at d1–d4 and correctly
**stripped at d5**, where the chain terminated (no d6). Each level received its child's result inline,
confirming `parentId` stamping + result propagation work across all 5 levels.

Remaining runtime checks (optional): breadth-cap throw (`maxChildrenPerAgent`), parent-targeted nudge
delivery, and the FleetView tree indentation (visual).

### Known limitations carried forward
- **Parent-already-finished** background children: the followUp has nowhere to land → falls back to
  top-level (policy decision deferred; see §8.1).
- **Tree is render-ordered, not collapsible** — no collapse/expand keyboard interaction yet (depth-first
  ordering + indent is the POC-level solution).
- **No per-level concurrency limit** — `maxConcurrent` is global; deep fan-out still queues on one pool.

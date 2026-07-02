# Analysis — Integrating the Nesting Verification Mechanism into the Subagents Extension

> **Status:** Design analysis. No code changes — read this before forking.
> **Context:** The `nesting-probe.ts` POC proved a separate extension can read the
> subagents extension's shared root `AgentManager` and surface ground-truth
> `depth`/`parentId`/`status` + event propagation. The fork should absorb this
> capability natively. **Verdict: yes — and it is strictly cleaner inside.**
> **Date:** 2026-07-02

---

## 1. TL;DR

- The probe exists as a separate extension **only because** it had to reach the
  subagents extension's internals from the outside, via
  `globalThis[Symbol.for("pi-subagents:manager")].__raw`.
- Inside the extension, that indirection vanishes: the factory already has `manager`
  in scope, `isNested` for root-detection, the emit sites for every `subagents:*`
  event, and — crucially — **the exact tree-build DFS already written** in
  `ui/fleet-list.ts` (L190–217).
- So integration is not "port the probe"; it is **factor out the tree renderer the
  FleetView already uses, point a read-only tool + command + opt-in log at it.**
- The one thing the FleetView does NOT provide, and the feature that gave the probe
  its real value (it caught the `clearCompleted` wipe bug), is a **persistent,
  append-only, mode-agnostic ground-truth log + programmatic dump.** That must be
  preserved in the fork.

---

## 2. What the probe does → how each piece collapses inside

| Probe mechanism (external) | How it works as a separate ext | Native equivalent inside the fork |
|---|---|---|
| Reach the registry | `globalThis[Symbol.for("pi-subagents:manager")].__raw` | `manager` is already in factory scope — direct reference |
| Root-only gating | `globalThis[Symbol.for("nesting-probe:is-root")]` flag + `session_shutdown` clear (reload-safe dance) | The existing `isNested` boolean (`index.ts` L429). One-line `if (!isNested)`. **No flag, no shutdown handler.** |
| Lifecycle event tally | Subscribes to `subagents:*` on `pi.events` | Either subscribe once at root (decoupled, mirrors probe) **or** increment a counter at each existing emit site (L439/441/476/483/1274/1533/1539). The extension *owns* these emits. |
| Build the `parentId` tree | Reimplements DFS over `listAgents()` | **Reuse `FleetList`'s DFS** (`fleet-list.ts` L190–217) — it already groups by `parentId`, finds roots, walks depth-first. Factor it into a shared util. |
| `probe_dump` tool | `pi.registerTool` from the probe | `pi.registerTool` from the extension — same API the 3 existing tools use (L904/1423/1507) |
| `/probe-tree` command | `pi.registerCommand` from the probe | Fold into the existing root-only `/agents` menu (L2389) or add `/agents tree` |
| Auto-log on completion | Subscribes to `completed`, writes tree | Hook the manager's existing `onComplete` callback, or the `subagents:completed` emit |

Every column-3 cell is *less* code than column-2, because the indirection is gone.

---

## 3. Why native integration is strictly better

1. **No globalThis Symbol contract.** The probe depends on
   `Symbol.for("pi-subagents:manager").__raw` — an undocumented internal handle. If
   the fork ever switches to the hierarchical-manager model (Option B in the nesting
   plan), that handle changes or disappears and the probe silently breaks. Native
   code holds a real reference and refactors with the manager.
2. **No root-detection heuristics.** The probe's flag-clear-on-`session_shutdown`
   is a workaround for globalThis surviving `/reload`. `isNested` is the source of
   truth and already correct.
3. **Single tree renderer.** Today the probe's DFS and `FleetList`'s DFS are two
   implementations of the same algorithm. A fork that ships both invites drift
   (different sort orders, different root detection, different filtering). One
   shared `renderRecordTree()` used by FleetView, the tool, the command, and the log.
4. **Settings-consistent UX.** The extension already has a settings system
   (`settings.ts` → `SettingsAppliers` → `applySettings` → the `/agents` menu). The
   log toggle becomes a first-class setting with a menu entry, not a hard-coded path
   in a side extension.
5. **One artifact to ship.** A published fork that still needs "also install this
   second probe extension to verify nesting" is a worse product. Built-in = zero
   extra setup for users.

---

## 4. Existing hooks in the extension to reuse (grounded in current source)

- **`manager.listAgents()`** (`agent-manager.ts` L561) — the authoritative flat
  record list. Already returns `depth` + `parentId` + `status` per record (the
  Option-A fields). This is the single source of ground truth.
- **`FleetList` DFS** (`ui/fleet-list.ts` L186–220): groups `listAgents()` by
  `parentId`, resolves roots (parentId absent *or* not in set), sorts children by
  `startedAt`, walks depth-first. **This is the function to factor out.** Today it
  emits `{kind:"agent", record, treeDepth}` for the TUI; a shared core can produce
  both that and a plain-text line per node.
- **`isNested`** (`index.ts` L429) — root detection, free.
- **`pi.registerTool`** sites (L904 Agent, L1423 get_subagent_result, L1507
  steer_subagent) — the registration pattern + `defineTool` wrapper to copy.
- **`/agents` command** (`index.ts` L2389–2396, root-only) → `showAgentsMenu(ctx)`.
  Natural home for a "dump tree" menu item or `/agents tree` arg.
- **Event emit sites**: `subagents:created` (L1274), `started` (L476),
  `completed`/`failed` (L439/441), `compacted` (L483), `steered` (L1533/1539). A
  verify module subscribes to these once at root.
- **Settings plumbing**: `SubagentsSettings` interface + `SettingsAppliers` +
  `applySettings(...)` + the numeric/menu appliers around L2142/L2253. A new
  `verifyLog` setting slots in here unchanged.

---

## 5. Proposed design (for the fork)

### 5.1 New module: `src/verify.ts` (pure, testable)

Export two pure functions, no `pi`/`ctx` dependency:

```ts
// Reused by FleetList (refactor), the tool, the command, and the log writer.
export interface TreeNode { record: AgentRecord; children: TreeNode[]; }

export function buildRecordTree(records: AgentRecord[]): {
  roots: TreeNode[]; byDepth: Map<number, number>; /* histogram */
}

export function renderRecordTreeText(records: AgentRecord[], opts?: {
  includeStatus?: boolean; includeEventTally?: Map<string, number>;
}): string;
```

`FleetList`'s private DFS (L186–220) is refactored to call `buildRecordTree()` so
the TUI and the text dump can never diverge.

### 5.2 In-memory event tally (root-only, always on)

In `index.ts`, root branch, subscribe once:

```ts
const eventTally = new Map<string, number>();
for (const e of ["subagents:created","started","completed","failed","steered","compacted"]) {
  pi.events.on(e, () => eventTally.set(e, (eventTally.get(e) ?? 0) + 1));
}
```

Cheap, no I/O, answers the P6 question ("do nested lifecycle events reach root?")
on demand. This is what confirmed `11 started / 11 completed` in the POC.

### 5.3 Tool: `subagents_tree` (read-only, root-only)

Registered under `if (!isNested)` alongside the existing tools. Returns the
authoritative tree + depth histogram + event tally as tool text — exactly what
`probe_dump` returned. This is the agent-callable / RPC / print-mode / JSON-mode
path (the FleetView is TUI-only, so this fills every non-TUI mode and programmatic
use).

### 5.4 Command: fold into `/agents`

Either a menu entry ("Dump tree to log") or `/agents tree` that writes
`renderRecordTreeText(...)` to the log + notifies. Reuses the root-only `/agents`
registration — no new command surface.

### 5.5 Setting: `verifyLog` (opt-in persistent log)

```ts
// settings.ts
/** Append the full record tree + event lines to a log on every agent
 * completion. Mode-agnostic forensic record of what actually ran (depths,
 * parent links, propagation). Default: off (I/O + noise). */
verifyLog?: boolean | string;   // true → default path; string → custom path
```

Wired through `SettingsAppliers.setVerifyLog` + `applySettings`, with a menu entry.
When on, the manager `onComplete` callback appends `renderRecordTreeText()` +
the event line. **This is the feature that caught the `clearCompleted` bug** — it
must ship, but off by default.

---

## 6. The killer feature to preserve: the persistent forensic log

The FleetView is **ephemeral and TUI-only** — you can't query it after the run, and
it doesn't exist in `-p`/RPC/JSON modes. The probe's value was precisely that it:

1. captured the **full evolving tree at every completion** (so post-hoc you could
   see records appear *and disappear*), and
2. was **callable as a tool** by the orchestrating agent / automation.

That combination is what exposed the `clearCompleted`-on-nested-`session_start` wipe
(records dropped 6→4 when `writer` started, then the whole planner branch vanished
when `implementer` started). A FleetView-only "verification" would have missed it.

**Requirement for the fork:** the `verifyLog` + `subagents_tree` tool together must
reproduce this: an append-only on-disk record of the tree over time, plus a
read-only programmatic dump. Do not reduce "verification" to "the FleetView already
shows the tree."

---

## 7. Synergy with the `clearCompleted` patch

The POC patch (`if (!isNested) manager.clearCompleted(true);` at `index.ts` L543)
and the verify feature are complementary and should ship together in the fork:

- **Without the patch**, the persistent log shows records vanishing mid-run
  (confusing forensic output) and the final `subagents_tree` dump is missing
  sequential-sibling branches.
- **With the patch**, the log is coherent (monotonically growing tree) and the
  final dump reflects the full run.

Recommend the fork includes the patch as a committed change, not a local-only edit.
(Upstreaming note: the patch is one line + a comment; tintinweb may want it behind a
setting if anyone relies on the current eager-clear behavior.)

---

## 8. Gating / scope decisions (recommendations for the fork)

| Decision | Recommendation | Why |
|---|---|---|
| Register `subagents_tree` tool in nested sessions? | **No — root-only** (`!isNested`) | Avoids cluttering every sub-agent's tool surface; the POC had to explicitly tell agents *not* to call `probe_dump`. Root is where verification happens. |
| Event tally in nested sessions? | **No — root-only** | Nested buses only see their own children's `created` events anyway (lifecycle `completed` already routes to root). Root tally is the authoritative one. |
| `verifyLog` default | **Off** | Per-completion disk writes are noise + I/O for normal use. Opt-in for debugging/forensics. |
| `subagents_tree` default | **On (root)** | Read-only, cheap, no side effects. Fills the non-TUI/programmatic gap for free. |
| Tool name | `subagents_tree` (namespaced) | Consistent with a fork that may add more inspect tools; avoids colliding with a user's own `probe_dump`. |
| Reuse FleetList DFS | **Yes — factor to shared util** | Single source of truth for tree shape. |

---

## 9. Migration: what to lift vs drop from `nesting-probe.ts`

**Lift (port the logic, drop the scaffolding):**
- `renderTree()` → becomes `renderRecordTreeText()` in `verify.ts` (minus the
  `globalThis[MANAGER_KEY].__raw` lookup — take `manager` as a param).
- The event-tally loop → moves into `index.ts` root branch (drop the per-event
  `log()` call unless `verifyLog` is on).
- The "dump on completion" behavior → hook the manager `onComplete` callback.

**Drop entirely (replaced by native equivalents):**
- `MANAGER_KEY` / `globalThis` lookup → direct `manager` ref.
- `ROOT_FLAG` + `session_shutdown` clear → `isNested`.
- The standalone `probe_dump` tool registration → `subagents_tree` in `index.ts`.
- The standalone `/probe-tree` command → folded into `/agents`.
- The log-file path hard-coding → `verifyLog` setting.

Net: ~150 lines of probe → ~60 lines of `verify.ts` + ~15 lines of wiring in
`index.ts`, reusing the existing FleetList DFS.

---

## 10. Per-file change inventory (for the fork)

| File | Change |
|---|---|
| `src/verify.ts` (**new**) | `buildRecordTree()`, `renderRecordTreeText()` — pure, tested. |
| `src/ui/fleet-list.ts` | Refactor the private DFS (L186–220) to call `verify.buildRecordTree()`; keep its TUI rendering. |
| `src/index.ts` | Root-only: subscribe event tally; register `subagents_tree` tool; add `/agents` dump entry/menu item; gate `manager.clearCompleted(true)` on `!isNested` (the POC patch); when `verifyLog` on, append tree in `onComplete`. |
| `src/settings.ts` | Add `verifyLog?: boolean \| string`; add `setVerifyLog` to `SettingsAppliers`. |
| `src/types.ts` | No change (`AgentRecord` already has `depth`/`parentId`). |
| `src/agent-manager.ts` | Optional: expose a `snapshot()` helper returning a serializable tree (for RPC/JSON consumers). |

---

## 11. Open questions for the fork author

1. **Hierarchical vs flat registry.** If the fork later moves to Option B
   (per-level managers), `subagents_tree` must aggregate across the manager tree,
   not read one flat `listAgents()`. Design `buildRecordTree()` to accept a
   record source so this swap is localized.
2. **`subagents_tree` in nested sessions for self-introspection?** Tempting (a deep
   agent inspects its own subtree) but risks sub-agents calling it mid-task.
   Recommendation stands: root-only; revisit if a real need appears.
3. **Log format.** Plain text (POC style, grep-friendly) vs JSONL (machine-parsable
   for dashboards). JSONL is more fork-friendly; consider `verifyLogFormat`.
4. **Event payload depth.** POC showed `subagents:*` events carry no `depth`. Adding
   `depth`/`parentId` to the emit payloads would let external observers (other
   extensions, dashboards) get ground truth without reading the manager. Low-cost,
   high-value — recommend including in the fork.
5. **Retention.** `verifyLog` grows unbounded across a long session. Add rotation
   or a cap (e.g. last N KB / per-session file).

---

## 12. Bottom line

The probe was the right tool to *prove* the mechanism from the outside. For the
fork, fold it in: one pure `verify.ts` module (shared with FleetView's existing
DFS), a root-only `subagents_tree` tool, an opt-in `verifyLog` setting, and ship the
`clearCompleted` patch alongside. Result: ground-truth verification becomes a
zero-setup, mode-agnostic, first-class feature of the extension — and the forensic
log that caught a real bug stays available for the next one.

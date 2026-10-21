# M1-P7 shared controls and panel consistency — owner decision audit

> **Status: investigation and proposal only. No UI implementation or new canonical controls have been approved by this brief.** This is an agent handoff, not an implementation authorization. The project owner's decisions are final and required for every choice.

## Assignment and authorization boundary

Audit Uburoom's **buttons, icon buttons, toggles, switches, segmented selection controls, tabs, toolbars, action groups, and directly related Room/Queue/Media panel conventions**. Determine where equivalent controls are implemented or styled differently; distinguish a genuine inconsistency from a documented or necessary specialized behavior. Propose an owner-reviewable, minimal set of canonical controls and usage contracts, enforcement options, and a staged migration plan.

The owner retains **ALL** decisions, including seemingly minor dimensions, padding, color, naming, variant/class selection, pressed/checked semantics, icon treatment, panel/header layout, implementation architecture, test approach, migration order, and exceptions. The agent may investigate, analyze, compare, recommend, and formulate questions. The agent **must not choose, implement, document as approved, merge, deploy, or publish** any proposed decision. Passing tests, current code, "best practice", a recommendation, or silence are not approval. If approval is partial or ambiguous, record the unresolved portion and ask follow-ups. Do not carry over the limited one-time implementation delegation recorded for the **2026-10-20 popup consistency pass** into this new assignment.

**Phase zero is read-only audit and owner questions. STOP after delivering the report; request a separate implementation authorization before making any application, CSS, documentation-standard, dependency or test changes.** Running appropriate *isolated* existing read-only fixture checks may be suggested or undertaken only when safe and within the current task's authorization; no live provider/Activity credentials, production config/state, deployment, or production restarts. Do not overwrite existing screenshot baselines or misstate executed evidence.

## Required reading and authoritative references

Read these **in full or relevant sections before assessing the UI**:

- `AGENTS.md` (especially owner decisions, stack rules, UI & Design, verification)
- `docs/design-guide.md` (canonical; respect existing appearance, branding, five named action classes, icons, toggle rules and approved popup pass)
- `ROADMAP.md` (M1-P7 UI/UX scope)
- `SPEC.md`
- `docs/development.md` and relevant `docs/testing.md` entries

Inspect the actual current code rather than extrapolating from this brief. For initial source coverage, include:

- `web/watch.html`, `web/watch.js`, `web/watch.css`
- `web/watch-rooms-ui.js`, `web/watch-queue-ui.js`, `web/watch-library.js`
- `web/watch-queue.css`, `web/watch-library.css`
- `web/watch-player-ui.js`, `web/watch-player.css`, `web/watch-dialogs.js`
- `web/remote-ui.js`, `web/account.js`, `web/theme.js`
- Relevant scripts such as `scripts/room-ui-smoke.js`, `scripts/queue-ui-smoke.js`, `scripts/plex-library-smoke.js`, `scripts/watch-layout-smoke.js`, `scripts/theme-smoke.js`, `scripts/popup-ui-smoke.js` and related tests

The independent `uburoom-remote` repository owns its extension UI; **do not change it or quietly impose web styling contracts across repository boundaries**. Note any interoperability concern as a separate owner question.

## Verified source leads, NOT conclusions or approved designs

Validate these against the **current checkout**, with locations and context:

1. Room UI has its own `node()` and `button()` factories in `web/watch-rooms-ui.js`.
2. Queue UI has a separate `node()` / `button()` implementation in `web/watch-queue-ui.js`, with its own default action class and icon handling.
3. Media UI uses a separate `button()` helper whose usual class is `library-key`, with different navigation and view-switch styles in `web/watch-library.css`.
4. Queue view switches use `.queue-view-button` in `web/watch-queue.css`; Room/permissions presets use `.button-group .group-button` in `web/watch.css`; Media uses `.library-views .library-key` and `.library-choices .library-choice`. These may represent legitimate distinct semantics; **do not equate them automatically**.
5. Remote controls define additional local styles, including `.control-track` / `.control-thumb`, in `web/remote-ui.js`. Respect its rendering scope and intended exceptions.
6. Controls have varying minimum sizes, icon dimensions, borders, pressed treatments and hover/disabled styles. Investigate each in context: do **not** treat visual differences as a confirmed defect before comparing roles, environments and the design guide.
7. Room/Queue/Media panels use related but separately specialized headers, controls, navigation and responsive rules. Inspect actual layouts before proposing alignment.
8. The popup consistency pass introduced `web/watch-dialogs.js` and `scripts/popup-ui-smoke.js`, with explicitly authorized modal behavior. **Do not reopen or casually reverse approved popup decisions**. Note any interaction that genuinely depends on this newer boundary.

The brief is a lead list, **not an exhaustive inventory, mandate to consolidate all implementations, or approval of any new type**. Search for additional occurrences across markup, CSS, JavaScript, and test fixtures.

## Audit workstream A — every control and interaction type

Create a **control inventory** with one entry per meaningful instance or repeated pattern, across Room, Queue, Media, Player, Account, watch lobby, remote and fullscreen Menu where applicable. Capture:

- Surface/context and user task; exact file, selector, construction function and line references
- Semantic role (navigation, action, single-choice selection, multi-choice selection, boolean switch, icon-only, destructive, transport, permission-gated, status)
- Existing CSS class(es), actual dimensions/tokens, icon path and label/tooltip strategy
- Default, hover, focus-visible, active, pressed/selected/checked, disabled, loading, error, and permission-denied states
- Keyboard/assistive-technology semantics: role, accessible name, `aria-pressed`, `aria-checked`, `aria-selected`, focus order, Tab and arrow behavior
- Behavior in normal, theater, mobile, fullscreen and Activity (distinguish what was executed from what was inferred)
- Whether a documented canonical pattern already applies; implementation variation; likely owner decisions

Classify each finding **confirmed violation / suspected inconsistency / approved exception / accessibility or behavioral risk / verification gap / owner decision required**. Cite evidence; avoid unsupported severity claims.

## Audit workstream B — action and icon-button consistency

Review all uses of the **existing five action classes** `.primary`, `.quiet`, `.icon-button`, `.danger-button`, `.solid-button` against their documented roles. Do not redefine these roles.

Examine specialist controls such as `library-key`, `queue-view-button`, `group-button`, `player-button`, queue transport/actions, remote keys, breadcrumbs, tab-like choices and filtered chips. Determine whether they are semantic variants, a genuinely different interaction category or drift.

Compare minimum touch targets, horizontal/vertical padding, radius, icon sizes and strokes, icon/text gap, accessible label/title, click target, hover/focus, disabled, busy, selected and destructive treatment. Account for deliberate compact controls and the dark video chrome.

For every inconsistency, show at least two concrete side-by-side source examples, the existing rule (if any), proposed alternatives and a numbered owner question.

## Audit workstream C — toggles, switches and selection groups

Inventory all boolean controls and selection mechanisms: Room permissions, privacy, queue autoplay/auto-queue, player CC, quality/audio tracks, appearance, Media view Cards/List/Posters, Queue Cards/List, filters, permissions presets, Room/Queue/Media section tabs, remote sharing/options.

Do **not** assume that a checkbox, track/thumb switch, push-button toggle, segmented choice, radio group and navigation tab are interchangeable. Separate the semantic and functional requirements first. Document controlled versus saved state, pending/permission-denied states, screen-reader representation, keyboard focus/selection behavior, instant-save versus explicit-save semantics and error rollback.

Identify any duplicates in rendering, event wiring, labels, sizing, active indicators or persisted preferences. Propose which categories *could* be canonical and which should remain specialized. Request owner decisions on ambiguous cases. Preserve established authorization, role boundaries, consent and server-owned state.

## Audit workstream D — surrounding Room/Queue/Media panel patterns

Audit only the panel structures **directly involved in control consistency**, not a broad visual redesign. Compare:

- Panel title/icon/collapse actions, header height/inset, control placement, action alignment
- Toolbars, grouped switches, navigation clusters, breadcrumbs, view selectors, filtering and sorting
- Disabled/empty/unavailable/permission-hidden controls and corresponding explanatory feedback
- Sticky headers, scroll ownership, wrapping/clipping, long labels and minimum targets at desktop/narrow/mobile
- Fullscreen Menu relocation, normal/theater distinctions and keyboard/focus preservation

Different workflows may warrant different arrangements; do not force identical appearance when behavior differs. Report genuine design decisions as owner questions. Respect already approved popup layouts.

## Audit workstream E — CSS contracts, DOM helpers, ownership and safety

Trace the construction of controls from call sites to styling rules. Identify distinct safe-DOM factories, duplicated helpers, broad descendant selectors, competing specificity, hard-coded sizes/colors, unnecessary overrides and style leakage between panels.

Evaluate small shared primitives **within the existing JavaScript/CSS architecture** versus retaining contextual variants. Do not add packages or invent a new abstraction without owner approval. Avoid unsafe DOM APIs and preserve CSP constraints. Identify the precise callers/risks before recommending consolidation.

Evaluate the existing icon library, `remote-ui.js` shadow/local styling constraints, token semantics, light/dark and orange/pink treatments, player dark chrome and responsive media/container queries.

For any proposed shared helper/style, specify its ownership and API possibilities, compatibility risk, proposed migrations, escape hatches, how visual semantics are enforced, and whether the owner must approve each field.

## Audit workstream F — verification and drift prevention

Inspect relevant current browser/unit tests; distinguish passing scoped checks from gaps. The last popup verification documented **other broader smoke-test failures** involving older text or missing selectors. Check their **current** state rather than declaring them fixed, blaming the latest changes, or treating stale failures as expected.

Propose, for owner approval:

- Static checks or tests for unauthorized action classes, icon substitutions, missing accessibility attributes, duplicated primitives and forbidden style additions
- Representative fixture states for action/selection/permission/busy states across Room, Queue, Media, Account, Player and remote
- Chrome/Firefox desktop/phone/theme/fullscreen coverage; Activity/physical device as separate integration or human gates
- Screenshot baselines and appropriate review/threshold strategy (none approved by this brief)
- Scope, maintenance and false-positive cost of each proposed control standard

Record results **only for tests actually executed**; avoid editing or regenerating test baselines without approval.

## Required report and decision packet

Deliver the following before any implementation:

1. **Executive summary** — most important problems, where inconsistencies are concentrated and whether they are verified.
2. **Complete control catalog** — occurrences and families, files/selectors, behavior/states, current styles and source evidence.
3. **Findings register** — stable IDs, classification, severity and confidence, reproduction where possible, code links/lines, relevant existing rule, impact and possible regressions.
4. **Comparison matrix** — Room vs Queue vs Media vs Player/Account/remote for equivalent action, icon, selection and status patterns.
5. **Proposed canonical control types** — possible types and variants, approved existing roles versus new owner choices, shared versus specialized surfaces. All **PROPOSED / NOT APPROVED**.
6. **Focused panel-standard proposals** — only what is necessary to make shared controls coherent.
7. **Implementation alternatives** — precise module/CSS ownership, migration scope, dependencies and compatibility limits, without choosing for the owner.
8. **Staged plan** — small reviewable increments; test/evidence/rollback scope and owner-approval gate for each.
9. **Enforcement and verification proposal** — options, false positives, coverage and remaining real-device/human acceptance gates.
10. **Numbered owner questions** — clearly separate decisions, with current behavior, options, trade-offs, nonbinding recommendation, exact answer needed and which tasks that answer unblocks.
11. **Unresolved/blocked list** — what could not be inspected, conflicts in existing guidance, uncertainties and tests not run.

For every question, use this template:

**Q-XX — [single specific decision]**
- **Current / evidence:** Exact instances and documented rules.
- **Why it matters:** User impact or maintenance risk.
- **Option A / B / etc.:** Benefits, compromises, scope and risks.
- **Agent's recommendation:** Explicitly *nonbinding*.
- **Owner decision needed:** Concrete, narrow, answerable question.
- **Dependent work:** What remains blocked.

Questions about independent dimensions, visual treatments, behavior, abstraction, tests and sequencing must not be smuggled into a blanket "approve the plan" request. Prioritize foundational questions but include a full decision index. If the owner approves one item, everything else remains unresolved.

## Later implementation and canonical design-guide record — NOT authorized now

Only after the owner answers the necessary questions **and separately authorizes a scoped next phase**, record the exact approved canonical control types and contracts in `docs/design-guide.md` **before changing affected UI code**. For each type include stable ID, role, allowed contexts, markup/helper/class, visual tokens/dimensions, variants, state behavior, focus/keyboard/ARIA contract, responsive/fullscreen exceptions, source ownership, tests and dated owner approval reference. Mark pending alternatives plainly as **unapproved**; never backfill the registry with guesses.

Maintain `AGENTS.md` and the guide's mandatory consultation rule so **all future agents** are directed to the guide, reuse approved types and stop when an unknown variant or exception is needed. The guide, not this temporary handoff, holds final approved standards.

**STOP CONDITION:** Complete the audit, proposals, owner questionnaire and evidence limitations. **Do not implement any change, silently select a design, edit application styles/components, rewrite tests, create approved type records, merge or deploy. Await explicit owner decisions and implementation authorization.**

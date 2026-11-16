# V2 Implementation Plan

Status: opt-in V2 preview implemented; full V2 release acceptance remains incomplete.
Date: 2026-11-14.

## Assignment

Implement the complete scope in `V2_PRODUCT.md` using `V2_ARCHITECTURE.md` and the Copilot runtime decision in `docs\decisions\agent-runtime.md`.

Proceed through the work below in dependency order. The initial SDK checks are normal first implementation tasks, not a separate user approval phase and not a reason to postpone the rest of the design. Escalate concrete incompatibilities or missing authority; do not silently weaken requirements or swap frameworks.

The outcome is a coding/research/browser-capable terminal product, not just a successful SDK chat. Keep the existing MVP usable during development and preserve its specifications and user data.

## Scope and Technical Direction

| Area | Plan |
|---|---|
| Product | One general-purpose agent can plan, act, inspect results, revise bounded work, and return verification evidence. |
| Frontend | Windows Terminal + PowerShell; TypeScript/Node.js and React/Ink. No additional client or multi-session dashboard. |
| Runtime | Copilot SDK as the single primary V2 execution engine. No OpenAI/Copilot nested loops or new graph framework. |
| Model | Existing BYOK endpoint/model/key configuration, mapped explicitly to the SDK. No account/provider fallback. |
| Storage | SQLite for product metadata/evidence and runtime-session mapping; the runtime owns its conversation journal and compaction. |
| Coding | General text/source tools, precise patches, Git inspection, isolated process execution, and test/build evidence. |
| Research | Search/retrieval, source/claim tracking, citation validation, bounded result retrieval, and an evidence-backed report. |
| Browser | Session-isolated Playwright or equivalent integration, observations/actions, screenshot/download artifacts, and explicit submission policy. |
| Permissions | Approval-first by default; optional scoped trusted-read grants. No automatic broadening because runtime tools are available. |
| Skills/MCP | Reviewed local workflow skills and explicitly trusted no-auth MCP integrations. No automatic marketplace installation or ambient hook execution. |
| Isolation proposal | Start with Docker Desktop-backed execution from the Windows frontend, using a filtered workspace mirror and no unconfined host-shell fallback. Native Windows toolchains require a separately proved provider. |

The isolation proposal and exact package/search/browser-provider versions are technical choices to resolve in implementation. They are not claims about installed prerequisites or already verified SDK behavior.

## Work Sequence

| Phase | Prerequisites | Implement | Completion evidence |
|---|---|---|---|
| P0: Runtime integration and compatibility | None | Pin compatible SDK/runtime/Node versions; exercise BYOK, streaming, tools, permissions, resume, cancellation, usage, and isolated configuration. Determine actual policy/admission extension points. | A01 integration cases and a recorded responsibility map. No credential leakage or silent alternate provider. Concrete mismatches have a resolution or an explicit blocked capability. |
| P1: Product/runtime boundary | P0 runtime contracts | Add a clean runtime adapter, normalized API/events, session mapping, objective/step/evidence records, result IDs, ownership locks, and versioned V2 storage. | Concurrent terminals remain independent, one objective is admitted per session, and no application code rewrites runtime conversation history. |
| P2: Policy, secrets, and isolation | P1 | Implement capability/action policy, request-bound approvals, trusted-read grants, hook/skill trust, credential separation, resource admission, and the isolated execution provider. | Denied actions cannot execute; sandbox escape/secret/network attempts fail; real concurrency and process cleanup are proved. Unverified execution stays disabled. |
| P3: Coding workflow | P1, P2 | Integrate source discovery/search/reads, exact patches, read-only Git operations, sandboxed process tools, change publication, coding skills, and coding completion validators. | A02: reproduce/fix a fixture bug, run relevant checks, preserve unrelated edits, and return a reviewable diff with genuine results. |
| P4: Research workflow | P1, P2, P3 workspace/artifact primitives | Integrate an explicitly selected search service, protected URL retrieval/extraction, source/claim ledger, result pagination, research skills, and citation/report verification. | A03: inspect primary/independent evidence, handle a fixture contradiction, and produce a cited report with resolvable support and honest uncertainty. |
| P5: Browser workflow | P1, P2, P4 network/evidence primitives | Add isolated browser state, snapshots/navigation/actions, protected submissions, screenshot/download handling, browser skills, and browser-result validators. | A04: complete a deterministic website task; deny submission without effect; prove browser state cannot leak across sessions. |
| P6: Acceptance, migration, and distribution | P3, P4, P5 | Complete TUI/headless integration, failure injection, limits, legacy history access, Windows packaging, documentation, and live integration checks within explicit authority/budgets. | A01-A08 results, requirement-to-evidence coverage, an installable package, preserved MVP data, and an honest release report before switching the default launch path. |

Planning, privacy, tracing, tests, and directly related documentation accompany every phase. Add each domain's skills and verification with that domain, not as a final prompt-only layer.

## P0: First Implementation Tasks

1. Inspect the published TypeScript SDK and compatible runtime artifacts; pin the actual versions and verify Windows installation/cleanup. Do not copy examples from a different SDK revision blindly.
2. Connect the existing OpenAI-compatible endpoint through BYOK and the appropriate wire API. Separate canonical model identity from deployment/wire aliases when required by runtime tool selection.
3. Use a disposable workspace and controlled tools to verify allow/deny/ask semantics, tool filters, exact request identity, pre-execution intent recording, post-result events, and callback restoration after restart.
4. Verify session creation, stop, cold resume, pending-decision handling, cancellation, and process ownership. Do not equate idle with verified objective completion.
5. Account for all model work, including compaction and other auxiliary requests. Establish real concurrency control and token/currency admission; document any soft-limit behavior rather than relabeling it hard enforcement.
6. Confirm the private runtime configuration namespace, disabled ambient hooks/plugins, telemetry settings, and absence of secrets in journals/logs. Prove the execution-provider boundary before enabling host-affecting capabilities.

Use deterministic/custom-tool and protocol fixtures where possible. Any paid calls use only synthetic data and a separately authorized budget; a key existing in `.env` is not open-ended spending permission.

## Product and Runtime Implementation Contract

- Preserve the original user objective and scope separately from summaries. Record steps, dependencies, expected outcomes, blockers, result references, verification evidence, and bounded replans.
- Prefer SDK planning, context, skills, hooks, and stop-extension mechanisms. Keep product evidence and completion checks without implementing another agent loop or an unnecessary graph scheduler.
- Normalize tool capabilities so SDK/model-specific names do not become the product API. Filter unknown/unsupported tools before exposure and fail closed at dispatch.
- Keep one admitted top-level command/objective even while SDK session restoration or permission handling awaits. Test conflicting commands, cancellation during preparation, and shutdown races.
- Record action intent before effects and outcomes afterward. Reconcile runtime events with the product ledger before resuming; repeat only where identity and idempotency are proven.
- Restore explicit provider, policy, callbacks, skills, capability restrictions, and configuration namespace on cold resume. Do not accidentally import personal or another session's remembered grants.
- Provide both user and model access to bounded stored results/artifacts. Reading prior evidence must not repeat its external action.
- Retain the original transcript/runtime journal; runtime compaction must not erase the authoritative objective/evidence or silently change permissions.

## Capability Implementation Details

### Coding

Support general source/configuration text with paging, glob, search, precise patches, binary/protected-path rejection, and stale-content preconditions. Display meaningful diffs and identify destructive patch operations explicitly.

Use fixed read-only Git operations, with dangerous helpers/configuration disabled. Never stash, reset, change refs, commit, or push as an implementation shortcut in a user-owned checkout.

Run commands in the proved isolated provider using executable/argument contracts and a minimal environment. Package installation is arbitrary execution and network activity, not a harmless exception. The model cannot select container mounts, privileged flags, or host-engine access.

Execute against a filtered workspace mirror. Capture baseline hashes and publish only approved changes through conflict checks; never overwrite unrelated or concurrent user changes.

### Research

Choose a supported search connector and validate its data/cost contract rather than assuming hosted search works with BYOK. Missing search credentials/provider capability is an explicit limitation, not a fabricated search result.

Apply destination, DNS/redirect, query/export, body/time, and output limits before retrieval. Keep protected network ranges blocked unless a specific local fixture/scope is explicitly authorized.

Store retrieved sources and evidence with provenance. Compare independent origins and distinguish publication dates, retrieval times, source assertions, and model inference. Validate citations against the retrieved records, not only a plausible URL string.

### Browser

Use a clean session-isolated browser with enforced target/network policy. Observe current page state before acting; do not replay stale selectors blindly.

Protect forms, uploads, sensitive typing, external submissions, scripts, and downloads. Downloaded files are quarantined artifacts until inspected/published, not executable inputs automatically.

Use a controlled local test site for routine acceptance. Personal login/cookie reuse and enterprise authentication are deferred, not silently enabled to make a demonstration work.

### Runtime and Provider Controls

Keep actual command/tool/model concurrency separate from provider hints. Enforce time/output/step/replan limits and make tool/process cancellation observable.

Preserve budgets across objective continuations and restart. Include auxiliary model and separately charged tool calls. Do not price unknown usage at zero.

If strict BYOK admission requires an application-owned model broker, keep it loopback-only, session-authenticated, fixed-upstream, bounded, and inaccessible to untrusted execution. It is not a public proxy or a second agent runtime.

## Acceptance and Verification

| Scenario | Required positive and negative checks |
|---|---|
| A01: Runtime | Real selected endpoint/model integration plus deterministic SDK/protocol fixtures; denial, invalid credentials/configuration, unsupported tools, no fallback, callback restoration, and secret exclusion. |
| A02: Coding | Failing baseline test, relevant source inspection, focused change, genuine test/build results, approved publication, stale-write rejection, and preservation of unrelated edits. |
| A03: Research | Retrieved-source ledger, fixture facts and conflict, citation resolution to supporting content, failed retrieval handling, duplicate-origin detection, and explicit uncertainty. |
| A04: Browser | Observation-driven local-site task, approved/denied actions, navigation/redirect controls, isolated cookies/storage, and screenshot/download provenance. |
| A05: Recovery | Restart at approval/clarification waits; inject failure before dispatch and after an external effect; verify no blind replay, no duplicate objective, valid conversation continuation, and bounded replanning. |
| A06: Policy/isolation | Attempt scope escape, secret access, hook/prompt injection, disallowed egress, unsafe uploads, and unconfined process/container-engine access; demonstrate enforcement, not merely a prompt refusal. |
| A07: Resources | Trigger each configured cap, parallel admission, cancellation, timeout, unknown usage, compaction/auxiliary calls, output pagination, and accounting persistence. Failed or partial work must not be reported as completed. |
| A08: Product/distribution | Concurrent real terminal processes, duplicate ownership, paste/resize/inspection, cancellation/resume, a clean installed package, private-file exclusion, and unchanged legacy data. Record physical clipboard/font checks separately where automation cannot observe them. |

Use synthetic repositories/documents/sites and deterministic fixtures for routine regression. Run live network/model/browser scenarios only against authorized destinations and budgets. Keep unsupported, failed, skipped, and manual-only observations visible.

## Requirement-to-Evidence Map

| Requirement | Primary phases | Acceptance |
|---|---|---|
| V2-01: Terminal/session continuity | P1, P6 | A05, A08 |
| V2-02: Runtime/BYOK | P0, P1 | A01 |
| V2-03: Planning/completion | P1, P3-P6 | A02-A05, A07 |
| V2-04: Filesystem/editing | P2, P3 | A02, A06 |
| V2-05: Isolated processes | P2, P3 | A02, A06, A07 |
| V2-06: Git inspection | P3 | A02, A06 |
| V2-07: Web discovery/retrieval | P2, P4 | A03, A06, A07 |
| V2-08: Research evidence | P4 | A03 |
| V2-09: Browser work | P2, P5 | A04, A06 |
| V2-10: Permissions/trust | P0-P6 | A01, A04-A06 |
| V2-11: Recovery | P1, P2, P6 | A05, A08 |
| V2-12: Context/resources | P0-P6 | A05, A07 |
| V2-13: Artifacts/results | P1, P3-P5 | A02-A05, A07 |
| V2-14: Skills/integrations | P0, P2-P5 | A01-A06 |
| V2-15: UI/API/auditability | P1-P6 | A01-A08 |
| V2-16: Migration/package/evaluation | P6 | A01-A08 |

Replace planned evidence with concrete test names, commands, results, and observed manual checks during implementation. Existing MVP tests provide a regression baseline, but OpenAI-specific assertions must not be presented as evidence that the Copilot backend works.

## Migration and Handoff

- Introduce versioned V2 configuration and a separate V2 product database/runtime namespace. Keep the private `.env` and all existing user data intact.
- Preserve MVP history through a read-only legacy view; do not convert serialized OpenAI execution state by copying fields or rewriting its journal.
- Keep the original launch path available during development. Make V2 the default only after its declared acceptance passes with recorded evidence; do not require two cooperating runtimes in steady state.
- Package compatible Windows SDK/runtime and capability dependencies reproducibly. Verify installation from a clean directory, no private files in the package, and cleanup of owned processes.
- Document setup, model/search/browser/execution prerequisites, permission modes, data locations, migration, troubleshooting, resource semantics, unsupported toolchains, and known limitations.

V2 is complete when every V2-01 through V2-16 requirement has implementation/evidence and all required positive and negative cases in A01-A08 meet their expected outcomes. Record failures, skipped checks, and unobserved manual cases accurately; they do not count as passing release acceptance. A runnable chat, one successful code edit, or an SDK task-complete event alone is insufficient.

## Inputs and Escalation

Existing credentials may be reused through secure configuration, but this documentation task does not authorize model calls, new service accounts, image/package downloads, external submissions, or spending.

Resolve routine implementation details autonomously: compatible package versions, internal layout, schemas, provider adapters, and test organization. Ask only for material missing authority or a design change, such as a paid search provider, missing execution infrastructure, a Windows-native toolchain requirement, broader data access, or an SDK contract that cannot satisfy required enforcement.

An unavailable capability remains explicitly blocked/disabled while independent safe work continues. Do not hide a failure, auto-enable an unsafe fallback, or turn the initial compatibility work into an indefinite separate approval phase.

## Implementation Record (2026-11-14)

The opt-in implementation is in `src\v2`; setup, the headless protocol, enforced
boundaries and limitations are documented in `docs\V2.md`. `harness-v2` is a
separate command. The existing MVP command, specifications, database and private
credentials remain intact. No commits, pushes, branch changes or live paid
model/search calls were made as part of implementation.

### Verified SDK responsibility map

| Responsibility | Actual integration |
|---|---|
| SDK/runtime/Node | `@github/copilot-sdk` 1.0.34, bundled runtime 1.0.112, Node 22.14.0; runtime version is checked at startup. |
| Primary agent loop and conversation | An owned SDK stdio runtime in `mode: empty`; no second agent loop or application history rewrite. |
| BYOK identities | Explicit `openai` Responses HTTP/SSE provider, canonical `modelId` and deployment `wireModel`; no account/provider fallback. |
| Model admission/usage | SDK `requestHandler` intercepts HTTP requests; the application fixes upstream/model, retains credentials, reserves before dispatch, and accounts reported usage. WebSocket model traffic is denied. Buffered auxiliary responses are supported; production-load compaction remains unverified. |
| Tool admission | Only source-qualified custom tools are exposed. Built-in/MCP runtime tools, discovery, extensions and subagents are excluded. SDK names are mapped to application capabilities; unsupported names fail closed. |
| Effect boundary | Custom handlers use the application broker: exact decision, revalidation, durable intent, bounded dispatch, durable outcome and result ID. Pre-tool hooks additionally deny unrecognized/unidentified native calls. |
| Approval recovery | Cold resume restores callbacks/provider/filters but does not replay abandoned handlers (`continuePendingWork: false`). Expired requests and unknown effects require explicit product reconciliation and fresh decisions. |
| Plan/stop extension | SDK plan read/update RPCs hold the runtime plan; SQLite records the objective/evidence projection. Stop hooks request only bounded verification continuations. Capability use infers domain validators even in the default/general mode. |
| Privacy | Session-specific base/config directory, scrubbed child environment and no real key in runtime state. The runtime initially reported enabled error reporting; the verified `COPILOT_TELEMETRY_LEVEL=off` setting disables it, and startup checks this rather than assuming it. |
| Execution/browser | Application providers, never an SDK host shell. Docker enforces the inspected container boundary; clean Chromium contexts route exact approved requests through protected retrieval. Missing/unproved providers have no fallback. |
| Skills/MCP | Reviewed compiled workflow guidance and explicitly trusted no-auth HTTP MCP share the application policy boundary. No ambient hooks, marketplace installs, personal profiles or authenticated MCP. |

### Concrete acceptance coverage

These are **fixture/integration observations, not a declaration that all release
cases pass**. Tests use synthetic repositories, HTTP/SSE services and sites.
The SDK cases run the actual bundled native runtime, not the MVP OpenAI backend.

| Scenario | Implemented evidence | Remaining release evidence |
|---|---|---|
| A01 | `test\v2\runtime.test.ts`: real SDK/BYOK protocol, streaming, custom tool approval/denial, cold callback restoration, fixed deployment identity, usage and secret-free journals. `resources.test.ts`: admission before network and unknown-usage recovery. One exact Globo news request completed on the configured live `gpt-6-luna` endpoint within 100,000 tokens. | Live invalid-credential/negative-provider cases and production-context auxiliary/compaction behavior remain to be demonstrated. |
| A02 | `providers.test.ts`: genuine failing shell-source arithmetic check, focused patch, genuine passing Docker check, diff inspection, host-conflict rejection, approved selected publication and preservation of unrelated edits. `core.test.ts`: precise/stale/protected/binary/link cases and completion cannot bypass domain checks. | Broader toolchains and representative live-model coding quality remain unverified. Native Windows toolchains are unsupported, not run on the host. |
| A03 | `research.test.ts`: three retrieved sources, two independent network hosts, duplicate-origin detection, conflicting quotes, resolvable report, explicit uncertainty, failed retrieval, redirects/private addresses/body caps and false citation rejection. `integrations.test.ts`: mocked Brave connector contract and pre-dispatch charge admission. | No live Brave account/query or paid search charge validation. Structural citations are not universal fact checking. |
| A04 | `providers.test.ts`: real installed Chromium 156.0.8078.4 with Playwright Core 1.65.0, observation-bound typing/clicks, denied POST with zero effects, approved POST, stale observation rejection, screenshot/quarantined-download provenance, retained same-session cookies and clean second-session cookies. | Personal/enterprise authentication, uploads, scripts and JavaScript sites remain disabled. Physical browser/terminal observations not covered by the fixture are not claimed. |
| A05 | `core.test.ts`, `continuity.test.ts` and `verify:v2:terminal`: asynchronous command exclusion, ownership, stale decisions, approval interruption, explicit reconciliation, cold continuation, no duplicate known external effect and preserved objective/deadline. | Exhaustive process-death injection at every native callback/model/effect boundary is not complete. Divergent native plans stop rather than being silently repaired. |
| A06 | Workspace/link/binary tests; real Docker nonroot/read-only/no-network/secret/socket checks; exact browser transfer denial; DNS/redirect/private-range checks; disabled/unknown dispatch, scoped grants, revoked queued grants and query/export approval tests. | Hard disk quotas for writable bind mounts are not enforced. This is a material resource/isolation release gap; approval does not turn it into an OS guarantee. Comprehensive hostile browser/runtime fuzzing remains outstanding. |
| A07 | `resources.test.ts`, `integrations.test.ts`, `providers.test.ts`: token/currency/request/action/replan admission, real semaphore dispatch, expiry/revocation, missing usage, exact file/workspace/result thresholds, UTF-8 pagination, Docker timeout/output-overflow cleanup and conservative search charging. | Production auxiliary-call billing/compaction and exhaustive provider limit violations remain unverified. Mirror byte limits bound initial input, not a running command's disk allocation. |
| A08 | `continuity.test.ts` and `ui.test.tsx`: actual independent headless processes, conflicting objective rejection, history/input/inspection/approval and byte-identical read-only legacy database. `verify:v2:terminal`: actual PowerShell/ConPTY, separate real SDK children, same-session exclusion, paste/resize/streaming, fresh approval after cold resume and cleanup. `verify:package`: clean install, both APIs/CLIs, real bundled runtime using synthetic BYOK and private-file exclusion. | Physical clipboard selection/paste sources and font rendering remain manual and unobserved. Full V2 release acceptance is not met. |

### Validation commands and release decision

Implementation validation includes `npm run typecheck`, `npm run lint`,
`npm run build`, the full `npm test` regression suite, `npm run verify:v2:terminal`,
and `npm run verify:package` against an archive built into session artifacts.
The native Docker/browser cases were explicitly enabled with a preinstalled,
immutable Linux image ID and the installed browser path/version; no images or
browsers were downloaded to make them pass. Omitting these prerequisites skips
those cases and must not be reported as a full acceptance pass.

The original workspace package archive is not overwritten. Final observations:

| Command/check | Observed result |
|---|---|
| `npm run typecheck`, `npm run lint`, `npm run build` | PASS. Repeated after the final request-owned usage-accounting adjustment. |
| `npm test -- --reporter=dot` with the explicit local Docker/browser fixture settings | PASS: **82 tests in 19 files**, including all 55 MVP regressions and 27 V2 cases; local provider cases enabled, not skipped. |
| Final targeted `resources.test.ts` + `runtime.test.ts` run | PASS: **8 tests** after the last accounting adjustment. |
| `npm run verify:v2:terminal` | PASS: actual Windows PowerShell/ConPTY and real SDK lifecycle using synthetic BYOK. Clipboard/font observations remain manual. |
| `npm run verify:package -- <session-artifact-archive>` | PASS after the final build: clean npm installation, MVP workflow, V2 CLI/API/docs, bundled real SDK/runtime, synthetic BYOK usage and private-file exclusion. |
| `git -c core.whitespace=cr-at-eol diff --check` | PASS. Existing tracked source/docs use CRLF; their convention was preserved, not converted wholesale. |
| Owned Docker-container cleanup | No `harness-v2-*` containers remained after timeout/output-overflow and acceptance checks. |
| Installable archive | `harness-experiment-0.1.0.tgz` in this session's artifacts, separate from the pre-existing workspace archive. |
| Live model/search and physical clipboard/font checks | The configured live model completed the exact Globo news request on 2026-11-15; live search and physical clipboard/font checks remain NOT RUN / NOT OBSERVED. |

**Release gate: blocked.** A runnable and validated preview is available, but
V2-01 through V2-16 are not all release-accepted. Remaining live endpoint/search
cases need explicit destinations/credentials/budgets; native clipboard/font checks
need observation; hard execution disk quotas need a separately proved provider
boundary rather than a claim about a Docker bind mount. Keep the MVP default.

### 2026-11-15: specific tool errors and prior-error inspection

The reported Globo/G1 failures were traced to the session's empty
`network.origins` allowlist; no retrieval request had been sent. SDK handler
exceptions previously became the generic model-facing "Tool execution failed."
The adapter now returns explicit, bounded, redacted SDK failure results with
the application error code and message. Failed actions retain an optional error
code, and `/status` / `work_inspect` expose ten session-scoped recent errors from
earlier objectives without repeating external actions.

`test\v2\runtime.test.ts` reproduces the original masking through the real SDK,
then verifies exact policy details, redaction/truncation, cold prior-error
inspection and exclusion of another session's diagnostics. The related V2
regression selection passed **26 tests in seven files**; typecheck, lint and
build also passed. `docs\V2.md` documents the specific policy error and a minimal
Globo/G1 configuration. No destinations were automatically granted and no
paid model calls or live Globo/G1 retrievals were run for this correction.

### 2026-11-15: opt-in wildcard public reachability

`network.origins: ["*"]` now permits arbitrary public HTTPS origins. The user's
ignored `harness.v2.local.json` explicitly enables it; default and previously
saved session policies remain unchanged. Private/metadata addresses, private
DNS, public HTTP, unscoped loopback fixtures, credentials/fragments, cross-origin
redirects, body/time limits and approval requirements remain enforced. Exact
trusted-read grants remain separate from wildcard reachability. Explicitly
selected search/MCP connectors can use public wildcard reachability without
removing their credential, server-trust or tool-allowlist requirements.

Wildcard/configuration, retrieval, integration, real SDK and continuity tests
passed **21 tests in five files**. Typecheck, lint and build passed, and the local
configuration was verified to load `["*"]` while remaining excluded from Git.
No live model/search calls or public-site retrievals were used for these checks.

### 2026-11-15: usable bounded news-portal retrieval

Authorized public Globo diagnostics confirmed that `https://globo.com/` redirects
to `https://www.globo.com/`, whose HTML was about 2.65 MB while extracted text was
about 29 KB. The default/example and the user's local raw-response cap are now
5 MiB, still bounded by the configurable 10 MiB maximum. Both declared-size and
stream-growth failures include the limit/byte count; response error handling is
registered before rejecting an oversized declared response. Cross-origin
redirects remain blocked pending a separate approved fetch, but their exact
destination is now included in the diagnostic.

Typecheck/lint/build and **20 tests in four relevant V2 files** passed, including
a multi-megabyte fixture that produces a supported cited report, smaller-cap
rejection, declared-length rejection and actionable redirect destinations. A
model-free live check with the local configuration retrieved Globo with HTTP 200,
2,656,784 raw bytes, 29,155 readable bytes and 47 verified readable news-link
texts. No paid model calls were used. Existing saved sessions retain their old
limits; start a new configured session to apply this correction.

### 2026-11-15: conservative incremental token admission

The reported model failures were local `TOKEN_LIMIT` denials, not provider
outages: one failed objective had 29,930 reported tokens used against its
100,000-token cap, but the old reservation counted over 80,000 serialized bytes
for the next request. Admission now reuses confirmed token counts only when the
request settings/model, interaction type and full prior input prefix match
exactly. Newly appended input is bounded by its encoded bytes, with prior output,
next output and framing overhead retained. Changed/compacted inputs or missing
fingerprints use the original full-byte fallback. Only compact hashes/counts
are persisted; runtime conversation history is not copied or rewritten.

The 100,000-token limit and prices were **not increased**. Every reported input
and output is still charged to the objective in full, including cached prefixes.
Missing usage or usage exceeding a reservation still blocks further work.
Local pre-dispatch admission failures return a terminal SDK error without five
pointless retries, and the objective retains the specific actionable reason.

Typecheck/lint/build and the complete current V2 regression selection passed
**63 tests in ten files**, with the local Docker/browser cases enabled. Cases
include a real SDK tool turn whose serialized request exceeds 100,000 bytes,
unchanged token-cap enforcement, changed-frame/prefix/interaction rejection,
restart persistence, no copied prompt text, overshoot recovery and one-attempt
quota refusal. A synthetic endpoint also verified this path using the user's
canonical `gpt-6-luna` model identity. No paid model calls were made for the fix.

### 2026-11-15: exact Globo request completed end to end

Session-log investigation of `error-683` and `error-697` showed correct source
ownership but invalid representation matching: the HTML extractor retained
`&#x27;`, and quote matching rejected newline/escaped-newline formatting. The
HTML5 decoder is now pinned as `entities` 9.0.0; claims resolve formatting-only
differences to exact stored source spans. Changed words/dates still fail.
Homepage fetches return bounded headline evidence IDs and article links so the
model can select evidence rather than retyping it or reading full pages again.
Research guidance makes clear that a concise named-site overview does not
require unrelated sources or article-depth retrieval.

A guarded live verification processed the exact prompt
`what are latest news on globo.com?` with the configured `gpt-6-luna` model.
Outcome: **completed**, one verified report, three supported headline records,
78,437 input + 2,053 output = **80,490 tokens**, zero unknown/reserved usage, and
the original **100,000-token ceiling unchanged**. Verification ran in an empty
workspace and only approved public Globo retrievals. The answer, summary,
source/claim/result evidence and private runtime state are retained under this
session's `files\news-verification\globo-live-KDTSB4` artifacts.

The successful trace exposed two avoidable report-wording/uncertainty retries
and one mistaken plan result ID. Reports now explicitly render canonical
recorded evidence/limitations when a draft omits their exact wording and return
a flat `planResultId`; unknown citations still fail. Plan diagnostics identify
valid current result IDs rather than returning a generic missing-record error.
The exact two failed report drafts from the live trace both validate under the
corrected renderer when replayed without additional model calls.

Final static checks passed. The current V2 regression selection passed
**68 tests in eleven files**, including configured local Docker/browser cases,
numeric entities, canonical whitespace, evidence IDs, report/uncertainty
assembly, unchanged token caps and explicit live-verification authority guards.
`test\v2\news-live-check.ts` / `verify:v2:news` retain an opt-in, bounded exact-goal
verifier; ordinary tests never spend against the live provider.

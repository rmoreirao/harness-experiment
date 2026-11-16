# SDK-first model limits and optional task budgets

Date: 2026-11-16.
Status: implemented for new version-3 sessions. Automated, native-terminal and
clean-package validation passed. The freshly authorized paid Globo acceptance
run also passed: 42,730 reported tokens, eight requests, four supported headline
records and one verified report. Product policy remained uncapped; the run used
separately labeled verifier-only ceilings.

This is the historical SDK-first change record, predating consolidation into the
sole implementation. Source paths and commands below use the promoted names;
the original mixed-runtime test totals/package observations are historical,
not results of a new consolidation or paid verification run.

## Outcome

For new sessions, remove the mandatory 100,000-token objective cap and the
unconditional 32,000-token prompt / 2,048-token response overrides. Let the
Copilot runtime own context handling and compaction. Preserve visible usage,
explicit optional budgets, approvals, isolation, cancellation, timeouts and
action/request limits.

Model capacity is a runtime/provider capability; an objective spending allowance
is a user policy. Do not replace the removed token cap with another implicit cap,
an `Infinity` sentinel, AI Credits, or a hidden default.

## What validation actually established

The pinned SDK is `@github/copilot-sdk` 1.0.34 and its runtime is 1.0.112.
The current Node baseline is 22.14.0.

| Probe | Observation | Consequence |
|---|---|---|
| `gpt-6-luna`, provider prompt/output overrides omitted | Runtime reports a 128,000 prompt allowance and 102,400 compaction threshold; Responses request omits `max_output_tokens`. | Auto mode is supported by this BYOK path. Do not inject a response limit after the SDK constructs the request. |
| `gpt-6.1-sol`, overrides omitted | The same reported prompt allowance and compaction threshold. | These probes do not demonstrate different capacities for these two models. |
| Invented `harness-unknown-model`, overrides omitted | Also reports 128,000; the synthetic request is accepted by the fixture. | A runtime value is not proof of the deployed provider's real model capacity. Label its provenance and retain deployment overrides. |
| `gpt-6-luna`, explicit 32,000 / 2,048 overrides | Runtime reports 32,000 prompt allowance, 25,600 compaction threshold, and sends `max_output_tokens: 2048`. | Numeric overrides work and must remain available when deliberately configured. |
| One SDK tool turn with three synthetic usage reports | Completes with 120,000 reported input and 6,000 output tokens; native usage events agree. | The SDK has no mandatory 100,000-token cumulative cap. This is a protocol fixture, not paid usage or production quota-removal evidence. |
| Pinned `SessionLimitsConfig` contract | Exposes `maxAiCredits`, not a BYOK per-objective token or currency budget. | Do not pretend AI Credits replace an optional BYOK spending policy. |

`metadata.contextInfo` accepts zero prompt/output limits to resolve runtime
defaults; `resolveOutputTokenLimit: false` requests a cached-only measurement
without starting a managed provider. Its result can be unavailable, and its
capacity fields do not establish live deployment capacity.

Evidence: session artifacts `model-limits-probe.mjs` and
`model-limits-probe.json`. Seven model requests used synthetic loopback responses;
no provider key or paid model call was used for those probes.

## Final behavior contract

| Concern | New default | Explicit configuration |
|---|---|---|
| Prompt/context allowance | Omit application provider overrides; let the SDK resolve it. Display runtime-reported value or unavailable, with provenance. | `model.contextTokens` deliberately overrides the runtime prompt allowance. |
| Response allowance | Do not set or rewrite `max_output_tokens`; use SDK/provider behavior. Missing output metadata is displayed as unknown/provider default, not an invented number. | `model.outputTokens` requests a chosen finite response limit through the SDK. It is not necessarily the model's technical maximum. |
| Cumulative task tokens | No task token budget. | A finite `limits.maxTokens` enables an optional admission policy. |
| Currency | Show configured-price estimates or unknown; no implicit currency cap. | A finite `limits.maxCost` requires explicit appropriate input/output prices and accounting for separately charged tools. |
| Model usage | Journal request identity and actual reported usage, including auxiliary work. No speculative token reservation when no token/currency policy is enabled. | Reserve only for an explicitly enabled budget, using a justified bound; fail before dispatch when that bound cannot be established. |
| Non-token controls | Keep current request/action/replan/time/byte/concurrency limits and cancellation. | Changes remain explicit. They constrain execution, not a guaranteed billing ceiling. |

Auto mode means "use the runtime," not "the harness has verified this provider's
published model specifications." Do not create a second model catalog, query a
different provider/account, or silently change the selected model to resolve
metadata. Explicit deployment overrides take precedence. Provider/context
rejections must identify the mismatch without inventing a larger limit.

## Implementation sequence

### 1. Version the new configuration and preserve old sessions

Files: `src\config.ts`, `src\store.ts`, examples and configuration tests.

- Introduce configuration version 3 for new launches. Omitted
  `model.contextTokens`, `model.outputTokens`, `limits.maxTokens` and
  `limits.maxCost` mean SDK default / no task budget respectively.
- Use optional positive safe-integer token fields; do not make zero, `null` or
  unlimited sentinels ambiguously mean disabled.
- Keep the version-2 parser and defaults frozen for historical configurations.
  Existing saved sessions keep their saved policy, counters and config digest.
  Materialized historical `100000` cannot reliably be distinguished from an
  intentionally chosen limit, so do not strip it from databases.
- Document that old-session resume preserves old policy. Use a new version-3
  session for the new defaults; do not enlarge an active objective's budget.
- Upgrade the user's launch-file version deliberately, preserving network,
  skills, endpoints and other explicit settings. Do not read or print secrets
  into the plan or configuration.
- Keep the existing product/data namespace. A configuration-version change alone does not
  require a new SQLite schema or rewriting runtime journals. Add a database
  migration only if an actual SQL representation changes.
- Preserve public exports and make all schema-default/call-site changes
  consistent; do not let parsing a saved configuration inject new defaults
  before checking its historical integrity.

### 2. Delegate context/output behavior to the SDK

Files: `src\runtime.ts`, runtime contracts and SDK/protocol fixtures.

- Supply `maxPromptTokens` / `maxOutputTokens` only when numeric overrides were
  deliberately configured. Remove unconditional rewriting of
  `data.max_output_tokens` in the host transport.
- Keep the explicit canonical identity, wire identity, fixed upstream,
  BYOK-only authentication, tool filters, private namespace and telemetry policy.
- Keep `infiniteSessions` and SDK-owned compaction. Do not introduce a second
  history compactor or edit the runtime's raw conversation items.
- Project supported SDK context/usage events and cached metadata into normalized
  application events. Keep per-call context, per-response output allowance and
  cumulative objective usage separate.
- Store/report provenance such as `explicit override`, `runtime reported`, or
  `provider default/unknown`. Do not label the observed generic 128,000 allowance
  as a verified model-specific maximum.
- Refresh derived metadata on cold resume and invalidate it on model/request
  changes; preserve user-authored configuration rather than hashing mutable
  runtime-derived metadata into its identity.

### 3. Separate request accounting from optional budget admission

Files: `src\resources.ts`, `runtime.ts`, `contracts.ts`, `controller.ts`,
`research.ts` and accounting tests.

- Replace the always-required reservation path with request start/outcome
  accounting plus a conditional budget check.
- With no explicit token/currency cap, do not calculate byte-based token bounds,
  query prior-prefix anchors, require spare reserved tokens, or reject work
  merely because cumulative usage crosses 100,000.
- Continue enforcing real model concurrency, request/action/deadline limits and
  cleanup. Pending requests remain observable even without a token reservation.
- Count reported input/output once per request, including repeated/cached
  context and auxiliary requests. Counter ownership remains bound to the
  original objective, not whichever objective is current when a callback ends.
- Missing usage is visibly unknown, not zero. In uncapped mode, billing
  uncertainty alone must not block an otherwise verified result. An actual model
  failure, pending work or unknown external side effect still prevents false
  completion and retains recovery protections.
- With an explicit budget, preserve fail-closed handling for missing accounting,
  unknown tool charges, insufficient allowance and reservation overshoot.
  Reserve only when a finite output bound is available through the supported
  SDK request contract or a deliberate output override. If unavailable, explain
  what must be configured rather than inventing a 2,048-token default.
- Reuse the existing tested accounting/admission primitive where appropriate;
  do not build a second tokenizer or planner. Keep byte/prefix estimation
  confined to explicit policies, clearly described as admission bounds rather
  than guaranteed provider billing enforcement.
- Review controller completion/reconciliation and separately priced search/MCP
  paths so they do not accidentally require the now-optional token policy.

### 4. Update terminal/headless presentation and documentation

Files: `src\ui.tsx`, `cli.tsx`, API contracts, `docs\GUIDE.md`,
`harness.example.json` and focused UI/headless tests.

- Show cumulative usage with "no task token budget" when uncapped, not
  `used/100000`, `used/undefined` or `used/Infinity`.
- Show current prompt occupancy against SDK-reported prompt allowance separately
  from cumulative work. Show output as explicit / SDK / provider default.
- Preserve clear diagnostics and the error inspector. Budget refusal remains a
  specific non-retryable admission error only when a budget is enabled.
- Document that absent budgets can allow higher spending. Timeouts/actions are
  not money caps. Keep approvals, source evidence checks and isolation intact.

### 5. Migrate the acceptance harness, then validate the exact goal

Files: `test\news-live-check.ts`, its authority tests, resource/runtime/research
tests, package tests and directly related documentation.

- Separate an operator's verification ceiling from product `limits.maxTokens`.
  The previous verifier wrote a 100,000 token value into product configuration;
  that must not become evidence that the new default is uncapped.
- Default tests use synthetic endpoints and deterministic current-news fixtures.
  No paid calls occur without an explicit validation authorization and ceiling.
- A live verifier can impose independent spending/output bounds for its one
  approved run. Record those separately from product policy and model capacity.
  Do not claim a bounded verifier proves unrestricted output behavior.
- Build and typecheck, run focused regression/negative cases, then the full suite
  with installed-provider cases enabled where applicable. Verify clean package
  installation, saved-session/config preservation and owned-process cleanup.

## Required regression matrix

| Case | Expected outcome |
|---|---|
| New version-3 config without token fields | No implicit 100,000 / 32,000 / 2,048 values; no task token/currency policy. |
| Known, alternate and unknown canonical models | Auto override omission is correct; runtime/default provenance is visible; no account or model fallback. |
| Explicit prompt/output numbers | Requested SDK override is restored on cold resume and reflected in wire requests. |
| Metadata missing or a generic runtime fallback | Display unknown/runtime provenance; do not fabricate verified capacity. |
| No task cap, cumulative synthetic usage above 100,000 | Work continues; usage remains correct; no speculative admission calculation. |
| No task cap, missing usage | Usage is unknown; no false zero; verified work is not failed solely for absent billing metadata. |
| Explicit finite token/currency policy | Admission, unknown usage, separately priced tools and overshoot behavior remain explicit and bounded. |
| Pending callbacks / unknown external effects | No blind replay or premature completion, regardless of budget mode. |
| SDK compaction and cold resume | Runtime owns context; original objective/evidence survive; accounting does not reset or double count. |
| Legacy version-2 session | Saved explicit/materialized caps and config integrity remain unchanged. |
| UI/headless API | Context, output and cumulative usage are distinct; uncapped presentation is unambiguous. |
| Model/request settings change | No reuse of another model's accounting assumptions or stale limit metadata. |
| Request/time/action/output-byte denial | Existing independent limits still stop work for the correct reason. |

## Exact Globo acceptance

Prompt: `what are latest news on globo.com?`

The post-implementation default-mode run must:

- Start a fresh version-3 session without a product token/currency budget and
  without prompt/output overrides. Use the existing approved network policy.
- Fetch current public Globo evidence, following cross-origin redirects only
  through the separately approved destination fetch. Do not reuse yesterday's
  homepage as "latest."
- Produce a readable answer, a verified research report and at least three
  distinct supported headline records for this specific acceptance case.
  Use evidence IDs/exact source spans; preserve retrieval time, article links
  and honest homepage-only limitations. Do not invent publication dates.
- Complete its plan with actual result IDs, with no pending requests/effects
  or quota-refusal errors. Cite retrieved support rather than model memory.
- Record model identity, context/output provenance, product budget mode, usage,
  request/tool counts, failures and cleanup. An operator verification ceiling
  must be separately labeled and must not silently become the product default.
- Make no universal three-headline/source rule or exact token/call-count promise.

An explicit-budget negative run must still demonstrate that a user-selected
budget refuses work before dispatch where enforceable. That negative result
must not be confused with default uncapped behavior.

## Validation completed during planning

| Evidence | Actual result | Scope |
|---|---|---|
| SDK contract probes | Four auto/override model cases observed; synthetic three-call turn completed at 126,000 cumulative reported tokens. | Real pinned SDK/runtime, synthetic provider only. Not a production configuration migration or compaction stress test. |
| Historical exact-goal baseline, 2026-11-15 | Completed: 80,490 tokens, 12 calls, three supported headlines under old overrides/cap. | Historical baseline only, not validation of the new design. |
| New isolated live prototype, 2026-11-16 | **Completed: 50,501 tokens, nine calls, one verified report, four supported headlines**, configured `gpt-6-luna`, fresh `https://www.globo.com/` evidence. | SDK prompt override omitted. Independent verifier-only ceilings were 100,000 tokens and 2,048 output tokens; fully automatic output-field behavior was probed synthetically, not paid/unbounded. |
| Redirect handling | `globo.com` produced an explicit redirect diagnostic, then `www.globo.com` was separately approved and fetched. No citation/report/plan failures occurred in this live prototype. | Existing safety/evidence controls preserved; no automatic broadening. |
| Production files/configuration during planning | No runtime implementation or existing user configuration changed by those planning probes. | Historical planning-time state, superseded by the implementation validation below. |

The live comparison is observational, not proof that automatic context alone
reduced usage: page contents, model behavior and workflow improvements differ.
Do not advertise a deterministic cost reduction or a passing implementation
before the regression/migration work is complete.

Retained session artifacts: `model-limits-probe.json`,
`sdk-first-news-validation.json`, the corresponding reproducible probe scripts,
and `sdk-first-news-mnSBYk\answer.md` / `verification.json` with the isolated
product evidence. No credentials are included in this plan or public summaries.

## Implementation validation, 2026-11-16

The version-3 launch example and local launch configuration now omit the product
token budget and provider prompt/output overrides. Version-2 saved configuration
and integrity checks remain intact. No historical session was rewritten.

| Case | Observed result | Scope |
|---|---|---|
| Full regression | **151 tests passed in 23 files**, with the installed Docker and Chromium fixtures enabled. | Repository-wide deterministic suite; no paid model calls. |
| Types, lint and build | `npm run typecheck`, `npm run lint`, and `npm run build` passed. | Final implementation. |
| SDK-first model defaults | Real SDK requests omit `max_output_tokens`; default, unknown-model and unavailable-metadata cases preserve explicit provenance. Deliberate 48,000 / 1,536 overrides survive cold resume. | Synthetic Responses endpoint, pinned real SDK/runtime; no provider-capacity verification claimed. |
| Uncapped accounting | A real SDK tool turn completed at **126,000 cumulative reported tokens**. Direct ledger coverage also confirms no prefix lookup/fingerprinting or token reservation and idempotent settlement. | Synthetic usage, not paid consumption. |
| Exact prompt: `what are latest news on globo.com?` | **Completed through the real SDK:** five requests, **210,000 cumulative reported tokens**, three supported headline records, one cited report and completed plan; no pending work or errors. | Deterministic **synthetic** Globo-style HTML, including a 2.65 MB raw payload. This is not a live news retrieval or live model-quality test. |
| Optional policies | Token/currency denials occur before provider dispatch; missing finite SDK output bounds fail explicitly rather than inventing a default. Verification ceilings are separate from product policy. | Positive and negative fixtures; no implicit spending policy restored. |
| Missing billing/recovery | Uncapped answers retain unknown usage/null cost without failing solely for billing uncertainty. Pending models, unknown external effects and actual model failures remain blocking. Search charges and unknown tool prices survive reconciliation. | Real SDK missing-usage fixtures plus durable recovery and tool-charge tests. |
| Compaction and cold resume | Native background summarization settles before product stop validation; the SDK applies its summary on a later turn. Original objective records and counters survive application and cold resume. Cancellation releases the request ledger and concurrency slot. | Synthetic reported context pressure against the real SDK; not production-load/provider stress coverage. |
| Windows terminal | `npm run verify:terminal` passed in PowerShell/ConPTY, including uncapped display, independent terminals, interrupted approvals, cold resume and owned shutdown. | Real native terminal; physical clipboard/font checks remain manual. |
| Clean package (before consolidation) | Packed installation passed the then-current `verify:package`: both historical entry points, version-3 uncapped defaults and unchanged SDK output omission, native SQLite/locks and private-file exclusion. | Historical clean temporary npm installation; no registry publication. |
| Fresh paid Globo run | **Passed:** `gpt-6-luna`, eight completed requests, **42,730 reported tokens** (41,491 input / 1,239 output), four supported headline records, one verified report and completed plan. | Fresh user authorization; current `https://www.globo.com/` evidence retrieved at **2026-11-16T11:38:24.076Z**. Independent verifier ceilings: 100,000 total tokens / 2,048 output tokens per call; product token/currency budgets and prompt/output overrides remained absent. |
| Live redirect and cleanup | The initial cross-origin redirect was explicitly refused, then the destination was separately approved and retrieved. No citation, model or quota-refusal failures occurred; zero pending requests/decisions and owned cleanup completed. | One expected `REDIRECT` diagnostic, not silent cross-origin access. No retry of the paid acceptance run was needed. |

Compaction validation exposed two timing/cleanup issues and the implementation
was adjusted: SDK idle can precede background summarizer settlement, and an
aborted body reader can itself reject cancellation. The runtime now waits for
`session.compaction_summarized` (or completion), without waiting indefinitely
for later summary application, and settles the stream ledger in `finally`.
The cancellation regression confirms no premature completion or leaked pending
model request.

Post-implementation live evidence is retained in session artifacts
`sdk-first-live-acceptance-20261116\globo-live-S7R5iv\verification.json` and
`answer.md`, alongside the private source/claim/report ledger. The final answer
groups four supported headline records into three readable bullets and notes
that homepage headlines can change; article bodies were not retrieved.

## Delivery/remaining gates

The implementation, local automated validation and freshly authorized bounded
live acceptance are complete. The updated verifier records its independent
ceilings, request/tool counts, failures, uncapped product budget mode and
successful cleanup. It used a fresh version-3 default-mode session without
changing the user's product configuration or historical sessions.

Automatic output-field omission is verified on the synthetic wire, not with
unrestricted paid output. Production-load compaction, exhaustive failure
injection and unrelated product release gates are not declared complete.
No SDK upgrade, new model framework, model/provider fallback, workspace shell
fallback, or unrelated product release work was part of this change.

# SDK-first model limits and optional task budgets

Date: 2026-11-16.
Status: implementation plan, validated with SDK/protocol probes and one isolated
live news prototype. The production refactor is not implemented.

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

Files: `src\v2\config.ts`, `src\v2\store.ts`, examples and configuration tests.

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
- Keep product/data namespace V2. A configuration-version change alone does not
  require a new SQLite schema or rewriting runtime journals. Add a database
  migration only if an actual SQL representation changes.
- Preserve public exports and make all schema-default/call-site changes
  consistent; do not let parsing a saved configuration inject new defaults
  before checking its historical integrity.

### 2. Delegate context/output behavior to the SDK

Files: `src\v2\runtime.ts`, runtime contracts and SDK/protocol fixtures.

- Supply `maxPromptTokens` / `maxOutputTokens` only when numeric overrides were
  deliberately configured. Remove unconditional rewriting of
  `data.max_output_tokens` in the host transport.
- Keep the explicit canonical identity, wire identity, fixed upstream,
  BYOK-only authentication, tool filters, private namespace and telemetry policy.
- Keep `infiniteSessions` and SDK-owned compaction. Do not copy the MVP history
  compactor into V2 or edit the runtime's raw conversation items.
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

Files: `src\v2\resources.ts`, `runtime.ts`, `contracts.ts`, `controller.ts`,
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

Files: `src\v2\ui.tsx`, `cli.tsx`, API contracts, `docs\V2.md`,
`harness.v2.example.json` and focused UI/headless tests.

- Show cumulative usage with "no task token budget" when uncapped, not
  `used/100000`, `used/undefined` or `used/Infinity`.
- Show current prompt occupancy against SDK-reported prompt allowance separately
  from cumulative work. Show output as explicit / SDK / provider default.
- Preserve clear diagnostics and the error inspector. Budget refusal remains a
  specific non-retryable admission error only when a budget is enabled.
- Document that absent budgets can allow higher spending. Timeouts/actions are
  not money caps. Keep approvals, source evidence checks and isolation intact.

### 5. Migrate the acceptance harness, then validate the exact goal

Files: `test\v2\news-live-check.ts`, its authority tests, resource/runtime/research
tests, package tests and directly related documentation.

- Separate an operator's verification ceiling from product `limits.maxTokens`.
  The current verifier writes a 100,000 token value into the legacy configuration;
  that must not become evidence that the new default is uncapped.
- Default tests use synthetic endpoints and deterministic current-news fixtures.
  No paid calls occur without an explicit validation authorization and ceiling.
- A live verifier can impose independent spending/output bounds for its one
  approved run. Record those separately from product policy and model capacity.
  Do not claim a bounded verifier proves unrestricted output behavior.
- Build and typecheck, run focused regression/negative cases, then the full suite
  with installed-provider cases enabled where applicable. Verify clean package
  installation, legacy history/config preservation and owned-process cleanup.

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
| Production files/configuration | No runtime implementation or existing user configuration changed by these planning probes. | The mandatory default cap remains until this plan is implemented. |

The live comparison is observational, not proof that automatic context alone
reduced usage: page contents, model behavior and workflow improvements differ.
Do not advertise a deterministic cost reduction or a passing implementation
before the regression/migration work is complete.

Retained session artifacts: `model-limits-probe.json`,
`sdk-first-news-validation.json`, the corresponding reproducible probe scripts,
and `sdk-first-news-mnSBYk\answer.md` / `verification.json` with the isolated
product evidence. No credentials are included in this plan or public summaries.

## Delivery/remaining gates

The plan is ready to implement; the isolated SDK-first news prototype passed.
Acceptance of the final production change still requires the implementation
steps and regression matrix above. Production uncapped accounting, configuration
migration, new UI behavior, automatic output with a live deployment, and
compaction stress/recovery are not marked passed by the planning experiment.
No SDK upgrade, new model framework, model/provider fallback, workspace shell
fallback, or unrelated V2 release work is part of this change.

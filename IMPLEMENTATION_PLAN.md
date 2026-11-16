# Implementation and acceptance record

The Copilot SDK implementation is the repository's **only implementation**.
The source and test trees, `harness` command and root package API are unversioned.
Full production release acceptance remains incomplete.

## Implemented product

| Area | Implementation and evidence |
|---|---|
| Runtime/BYOK | Pinned SDK 1.0.34 and runtime 1.0.112; controlled Responses transport, exact model identity, streaming, custom tools, telemetry checks and no provider fallback. `test\runtime.test.ts`, `test\integrations.test.ts`. |
| Objectives and planning | One admitted objective, persistent steps/evidence, domain completion checks, bounded replanning and stop-hook validation. `test\core.test.ts`. |
| Source and execution | Filtered source tools, precise hash-bound edits, read-only Git, Docker mirrors and separately approved publication. `test\core.test.ts`, optional `test\providers.test.ts`. |
| Research | Protected retrieval, decoded readable sources, exact evidence, claims, citation-checked reports and explicit uncertainty. `test\research.test.ts`, `test\network.test.ts`. |
| Browser | Reviewed installed Chromium, isolated state, observation-bound actions and artifact provenance. Optional `test\providers.test.ts`. |
| Policy and integrations | Exact approvals, read grants, read-only restriction, explicit approve-all mode, no-auth HTTP MCP and workspace skill snapshots. `test\core.test.ts`, `test\integrations.test.ts`, `test\skills.test.ts`. |
| Continuity and recovery | Independent terminals, exclusive ownership, cold callbacks, reconciliation of unknown effects and no blind replay. `test\continuity.test.ts`, `test\storage.test.ts`. |
| Resources/context | Version-3 uncapped defaults, explicit optional budgets, reported usage, auxiliary accounting and SDK-owned compaction settlement/application. `test\resources.test.ts`, `test\runtime.test.ts`. |
| UI/distribution | Shared input editor, inspection and redacted errors, CLI/headless API, Windows ConPTY and installed-package acceptance. `test\editor.test.ts`, `test\environment.test.ts`, `test\ui.test.tsx`, `test\terminal-check.ts`, `test\package-check.ts`. |

## Consolidation contract

The original OpenAI Agents SDK backend, fake-model mode, custom history
compactor, standalone workflow engine and read-only legacy viewer are removed.
Reusable input, diagnostics, redaction, path containment and native locking
infrastructure remain part of the sole Copilot implementation.

Only `harness` and the root `harness-experiment` API are exposed. The versioned
command/subpath are removed, rather than maintained as alternate entry points.
Builds replace their generated `dist` directory so older backend output cannot
be repackaged accidentally.

Saved Copilot sessions keep configuration formats 2/3, exact defaults/digests,
runtime mapping, usage, SQL schema and ownership identities. Existing `v2`
storage names remain intentionally unchanged. No user database or private
configuration is rewritten. Historical MVP checkpoints are not imported.

## Acceptance requirements

| Scenario | Required evidence and current boundaries |
|---|---|
| A01 Runtime | Actual pinned SDK/native runtime with synthetic Responses, fixed identities, streaming, denial, usage and secret-free journals. Bounded live model evidence exists; it is not universal endpoint/capacity verification. |
| A02 Coding | Failing disposable code check, focused fix, isolated successful check, conflict-aware publication and unrelated-edit preservation. Docker prerequisites must be explicitly installed/configured. |
| A03 Research | Independent fixture sources and a contradiction, exact source support, cited report, honest failure/uncertainty. Fixture source counts are not universal requirements for every question. |
| A04 Browser | Local-site observations/actions, denial without effect, fresh page state and isolated artifacts. JavaScript sites, personal authentication and uploads remain unsupported. |
| A05 Recovery | Approval interruption, cold continuation, exact reconciliation, no duplicate objective/effect and preserved deadlines/evidence. Exhaustive native process-death injection is incomplete. |
| A06 Policy/isolation | Protected path/network boundaries, stale decisions, disabled ambient tools/hooks, constrained containers and no host fallback. These controls are not a general OS sandbox against arbitrary external editors. |
| A07 Resources | Explicit limits, concurrency, time/output bounds, auxiliary usage, unknown billing/effect distinctions and cancellation cleanup. Uncapped mode intentionally is not a spending ceiling. |
| A08 Distribution | Independent processes, same-session exclusion, input/inspection, installed root API/CLI, old-session compatibility and exclusion of obsolete/private files. Physical clipboard/font observations remain manual. |

## Verification commands

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:terminal
npm pack --pack-destination 'D:\harness-verification'
npm run verify:package -- 'D:\harness-verification\harness-experiment-0.1.0.tgz'
```

The archive destination must already exist. Pass the freshly generated archive
explicitly rather than using an unrelated older package. The package check
installs into a temporary directory, imports the installed root API and uses
the bundled real runtime with synthetic loopback responses. It performs no
registry publication or paid inference.

`HARNESS_TEST_DOCKER_IMAGE`, `HARNESS_TEST_BROWSER` and
`HARNESS_TEST_BROWSER_VERSION` enable reviewed installed local-provider fixtures.
Without them those cases are explicitly skipped, not reported as passing.
The separately guarded `verify:news` command is never part of routine CI.

## Historical live evidence and remaining gates

Before consolidation, the SDK-first implementation completed the exact Globo
news request using `gpt-6-luna`: **42,730 reported tokens, eight requests, four
supported headline records and one verified report**. Product budgets remained
absent; the separately authorized verifier imposed a 100,000-token ceiling and
2,048 output tokens per call. This is historical bounded live evidence, not a
new paid run or unrestricted provider-output demonstration.

The [SDK-first limits record](SDK_FIRST_LIMITS_PLAN.md) retains the detailed
resource contract and historical validation. Synthetic runtime cases establish
background compaction settlement, later summary application, cold resume and
cancellation; production-context/provider compaction stress remains unverified.

Live Brave search, exhaustive failure injection, native Windows execution/egress,
browser SPAs/uploads/authentication and physical clipboard/font observations
remain incomplete or deferred. Consolidation does not resolve these gates,
broaden capability permissions or claim production release acceptance.

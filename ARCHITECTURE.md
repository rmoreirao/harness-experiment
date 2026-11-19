# Architecture

## One native runtime

Copilot SDK owns the agent loop, native tools, shell processes, delegation,
conversation and compaction. The harness is a Windows Terminal/PowerShell host,
not an alternative tool engine or subagent scheduler.

Native SDK capabilities are enabled with deliberately scoped configuration.
CLI-equivalent tools do not imply unfiltered personal configuration discovery.
Workspace extensions load only after explicit session trust.

## Ownership

| Layer | Responsibility |
|---|---|
| `src\runtime.ts` and native runtime helpers | SDK initialization, provider integration, native events, worker lifecycle and permission callbacks |
| `src\config.ts`, workspace configuration | Native configuration, supported provider/model identities and workspace source resolution |
| `src\controller.ts` | Session trust, objective admission, evidence requirements, continuation and recovery coordination |
| `src\policy.ts` | Retained domain-tool validation/results and presentation of SDK decisions; not a second approval engine |
| `src\resources.ts` | Supported admission limits, model/worker/tool concurrency and provider-aware accounting |
| `src\store.ts`, contracts | Fresh native operational journal, activity relationships and bounded evidence |
| UI, activity and trace modules | Parent/worker attribution, permissions, task modes and evidence inspection |
| Research/browser modules | Distinctive evidence and controlled-browser capabilities |
| `src\execution.ts`, `src\workspace.ts` | Optional Docker mirror execution and hash-bound publication only |

There is one SDK-managed parent/worker hierarchy per product session. Independent
terminals may own separate sessions; ownership locks prevent concurrent owners of
the same native session. The journal projects SDK operations rather than replaying
them or rewriting SDK conversation history.

## Trust and permissions

Session creation does not authorize workspace code. `/trust`, explicit API
`trusted: true`, or an explicit headless trust decision is required before runtime
startup can activate hooks, MCP processes or native tools.

The selected SDK permission mode is authoritative:

- `manual`: normal permission decisions are presented to the user.
- `assisted`: runtime recommendations accompany the approval flow.
- `allow-all`: automatic permissions where enforced policy permits.

Requests that still require human approval must not be bypassed by the host.
Task modes (`interactive`, `plan`, `autopilot`) are independent of permissions.
Retained custom tools do not ask for a second approval after SDK authorization.

Native execution is unsandboxed. Workspace roots, tool allowlists, environment
filtering and worker assignments do not confine arbitrary shell commands. Domain
network/path validation applies only to tools that implement it.

## Providers and environment

Each session selects Copilot authentication or one BYOK provider. Worker model
overrides stay within that provider; effective identities must be inspectable.
Unavailable required models and unsupported budgets are errors, not an excuse
for silent fallback.

Developer tools receive their normal profile paths and required environment.
Known harness-owned credentials are excluded from automatic inheritance, while
SDK state remains private to the harness. This reduces accidental exposure; it
does not make account-accessible files secret from native commands.

## Evidence, lifecycle and storage

Native actions and workers retain SDK correlation identities. Parent and worker
messages are distinct, and worker text cannot become the parent's final answer.
Accounting uses provider/model identity and must not sum duplicate transport and
SDK observations. Unknown consumption and monetary cost stay explicitly unknown.

Objective completion uses native activity/evidence rather than Docker-only checks
or obsolete custom JSON plan IDs. An unrelated successful command is not proof of
the user's acceptance criteria. Research citation verification still requires
actual evidence-tool records.

Cancellation and shutdown cover objective-owned SDK work and retained domain
tools. Interrupted or unresolved effects require reconciliation; no rollback or
exactly-once execution guarantee is claimed.

Only native configuration/storage is supported: version 4, `native.db`, fresh
native data namespace. No legacy runtime, viewer, migration or fallback is shipped.
Historical data is left untouched. Session history is sensitive and unencrypted.

# Native harness product contract

The product is one extensible Copilot SDK host for local Windows development,
research and configured tool integrations. It exposes native shell and
SDK-managed workers, not an isolated custom-only agent.

## Required behavior

| Area | Contract |
|---|---|
| Startup | Explicit session trust before executable workspace configuration or tools start; headless callers provide an explicit decision |
| Native development | Real checkout, installed toolchains, normal developer profiles and SDK coding/shell tools |
| Agents | Built-in and workspace custom agents with attributable output and SDK-owned delegation |
| Permissions | SDK-authoritative manual, assisted and allow-all modes; allow-all is the trusted-session default |
| Task modes | Interactive default, with plan/autopilot independently selectable |
| Providers | Copilot sign-in or BYOK per session, per-agent models within that provider, no silent fallback |
| Extensions | Trusted workspace instructions, skills, agents, hooks and configured MCP integrations; no personal Copilot discovery |
| Activity | Native/custom successes, failures and command output are inspectable; worker text does not overwrite parent output |
| Accounting | Aggregate parent/worker usage once, identify provider/model, report unknown cost honestly |
| Parallel editing | Coordinate disjoint writer assignments in the shared checkout; surface conflicts and preserve unrelated edits |
| Lifecycle | Observe workers/processes, cancel owned work, and reconcile interrupted effects without blind replay |
| Evidence | Native objective evidence, relevant verification and reviewed changes; distinctive citation/browser evidence retains its own contracts |
| Docker | Optional explicit mirror execution/publication tool, never a native fallback |
| Storage | New-format native sessions only; old configuration/data unsupported and untouched |

## Guarantees not made

Native shell commands are not sandboxed and run with the account's effective
access. Filtered variables do not protect account-readable credential files.
Custom-tool network/path policies do not globally constrain native tools.
Cancellation is not rollback, SDK stop is not proof of objective correctness, and
the operational journal does not establish exactly-once effects.

Live provider/account availability, toolchain installation, optional MCP service
access and Docker prerequisites must be reported honestly. Synthetic fixtures
do not establish live acceptance.

## Not included

Historical compatibility, a restricted alternative mode, cross-provider mixing
within a session, Fleet orchestration, automatic worker worktrees and a new native
sandbox are outside this release.

The detailed implementation and acceptance map is
[NATIVE_SDK_MIGRATION_PLAN.md](NATIVE_SDK_MIGRATION_PLAN.md).

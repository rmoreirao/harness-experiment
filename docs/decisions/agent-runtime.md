# Native Copilot SDK runtime

Date: 2026-11-19.
Status: accepted hard-cutover architecture.

## Decision

Use the Copilot SDK as the sole native agent runtime, including coding tools,
PowerShell execution and SDK-managed delegation. Replace the former custom-only
tool boundary rather than adding a second operating mode.

The harness owns user experience, explicit session trust, provider configuration,
objective/evidence projection, activity inspection and recovery coordination.
SDK permission decisions govern native and retained domain tools.

## Consequences

- Native execution uses the real checkout and normal developer tool profiles.
  It is unsandboxed and does not inherit custom-tool path/network confinement.
- Trusted sessions default to allow-all permissions and interactive task
  progression. Those are independent choices and managed policy still applies.
- Copilot sign-in or BYOK is selected per session; worker models remain within the
  selected provider.
- Configuration discovery is workspace-only. Native capabilities do not imply
  personal Copilot hook/MCP/instruction discovery.
- SDK conversation and agent contexts remain canonical. SQLite is an operational
  journal, not another agent loop or an effect-replay engine.
- Historical configuration/storage is unsupported and untouched. No restricted
  alternative runtime, compatibility adapter or data migration is shipped.
- Docker remains an optional explicit tool, not the only execution provider and
  never a silent fallback.

No additional orchestration framework is needed. The authoritative scope is
[the native hard-cutover plan](../../NATIVE_SDK_MIGRATION_PLAN.md).

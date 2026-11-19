# Native implementation evidence

The current implementation follows
[NATIVE_SDK_MIGRATION_PLAN.md](NATIVE_SDK_MIGRATION_PLAN.md).
The historical custom-only acceptance map is superseded, not a supported mode.

## Architecture

- One SDK-native runtime and SDK-managed parent/worker hierarchy.
- Explicit session trust before executable workspace configuration is activated.
- SDK permissions, separate interactive/plan/autopilot progression and real
  developer workspace/environment.
- Copilot or BYOK per session, configured per-agent models and provider-aware
  usage records.
- Workspace-only instruction/skill/agent/hook/MCP discovery.
- Durable native/custom activity, worker identity, evidence and recovery.
- Optional Docker mirrors/publication, retained research citation and controlled
  browser functionality.
- Fresh configuration/storage, without historical compatibility or fallback.

## Acceptance evidence

Validation on 2026-11-19:

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed |
| Full Vitest suite with JUnit export | 265 passed, 3 explicit opt-in skips; report parsed and all 268 cases accounted for |
| `npm run verify:terminal` | Passed actual Windows PowerShell/ConPTY, native SDK commands, permissions, cold recovery, trace/input/resize and shutdown |
| `npm run verify:package -- <fresh native archive>` | Passed clean installation, bundled SDK, synthetic BYOK/usage, new-format cold resume and obsolete/private-file exclusion |

The full suite includes actual SDK-native PowerShell execution and delegation
to a custom worker using a distinct required model through a synthetic provider.
It also denies a real SDK shell operation and asserts that its marker file was
not written. Fixtures do not use paid model calls.

Integration fixes include parent/worker attribution, canonical SDK permission
decisions, invocation replay prevention, compaction-summary settlement, explicit
output-storage failures, host-only OAuth URL delivery, retryable failed shutdown,
terminal exit rendering, and refusing to treat an unrelated successful command
as recovery from a failed verification command.

The SDK configuration, authentication and MCP contracts have deterministic
coverage. Live Copilot sign-in, paid BYOK models and authenticated external MCP
consent were not exercised. Two Docker acceptance cases and one installed-browser
acceptance case were explicitly skipped because their opt-in prerequisites were
not supplied. Physical clipboard/font behavior remains manual.

Live provider/account model availability, paid requests, authenticated external
MCP services and installed Docker images require explicit opt-in acceptance.
An unavailable prerequisite is not a passed case, and synthetic responses are not
proof that a live provider works.

The native migration plan contains the authoritative requirement matrix.
Implementation completion must be reported with the actual commands/results and
any remaining material limitations, not this document alone.

## Outbound connectivity follow-up

On 2026-11-19, changed the citation-retrieval default and example configuration
from an empty origin list to `network.origins: ["*"]`. Public HTTPS sites no
longer need individual origin entries. Explicit restricted lists and saved
session policies remain intact; private/metadata and unsafe-URL protections are
unchanged. Start a new session after rebuilding to use the new default.

The new regression `defaults citation retrieval to wildcard outbound access
without a per-site allowlist` failed before the change and passed afterward.
The targeted network/research/runtime suite passed all 59 tests; its JUnit report
was parsed with zero failures. Typecheck, lint and build also passed.

Reran the exact user request, `what are the latest news on globo.com?`, through
the actual harness using the configured live BYOK `gpt-6-luna` model and the
production wildcard default, not a verifier-specific origin override. The request
completed with one live Globo.com source, five source-backed headline references,
one citation-verified report, no failed tool calls and no pending work.
It used four model requests (62,630 input and 1,372 output tokens); cleanup
completed. This establishes that live news rerun, not universal model accuracy or
live Copilot/external MCP acceptance.

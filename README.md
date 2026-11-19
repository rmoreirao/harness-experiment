# Harness experiment

A native Copilot SDK host for Windows Terminal/PowerShell, with a React/Ink UI,
headless JSON-lines API, durable activity/evidence and SDK-managed subagents.

**Native commands run with your Windows account's access. This is not a sandbox.**
Every session requires explicit trust before workspace hooks, MCP processes or
tools start. Trusted sessions default to SDK allow-all permissions and interactive
task progression; permissions and task modes are independent.

## Install and run

Use Node.js **22.14.0 x64** on Windows. Native SQLite and file-locking dependencies
may require Visual Studio C++ build tools.

```powershell
npm ci
Copy-Item .\harness.example.json .\harness.local.json
Copy-Item .\.env.example .\.env
# Configure a provider, model, workspace and external data directory.
npm run build
node .\dist\cli.js --config .\harness.local.json
```

In the terminal, `/trust` explicitly enables the native session. For an automated
caller, `--trust-workspace` or a headless `trust` command supplies that decision.
Neither loading configuration nor submitting an objective implicitly grants trust.

## Capabilities

- **Native development:** SDK shell, filesystem, search and editing tools use the
  real checkout and installed toolchains. Normal developer profiles remain usable.
- **Delegation:** built-in specialists and workspace custom agents operate under
  the parent objective with attributable activity and configurable concurrency.
- **Providers:** choose Copilot sign-in or an explicitly configured BYOK provider
  per session. Configure worker models within that provider; there is no
  cross-provider fallback or mixing.
- **Workspace extensions:** discover instructions, skills, agents, hooks and MCP
  servers from trusted workspace sources only, not personal Copilot configuration.
- **Evidence:** inspect stored command/tool output, model usage and worker status.
  Distinctive research citation and controlled-browser tools remain available.
- **Optional Docker:** explicitly run isolated mirror work and separately publish
  exact changes. Docker is a tool, not a second operating mode or native fallback.

Known harness-owned API keys are not automatically inherited by native commands.
This does not prevent unsandboxed commands from reading credentials available to
your account. Custom research/network restrictions do not constrain native shell
commands.

Citation retrieval defaults to `network.origins: ["*"]`, allowing all public HTTPS
origins without a per-site allowlist. Explicit restrictions remain configurable.
Private/metadata addresses, non-HTTP protocols and credential-bearing URLs remain
protected. Native shell networking is unaffected by this tool-specific policy.

## Session controls

```text
/trust
/permissions manual|assisted|allow-all
/mode interactive|plan|autopilot
/auth status|login|advance|cancel
/skills list|reload
/status
/trace on
/cancel
```

`/approve_all` selects SDK allow-all; `/approve_all off` selects manual mode.
Enforced organizational policy still applies. See [the guide](docs/GUIDE.md) for
authentication, configuration, commands, headless use and recovery.

## Native storage and hard cutover

Only configuration **version 4** is supported. New sessions use the native data
namespace and `native.db`. Historical stores/configurations are unsupported,
unconverted and left untouched. Select a fresh data directory; do not point the
new application at historical storage.

```powershell
node .\dist\cli.js sessions
node .\dist\cli.js resume NATIVE_SESSION_ID
```

SQLite is an operational journal, not a second canonical conversation or an
exactly-once execution engine. Cancellation does not undo completed effects.
Interrupted native work must be inspected and reconciled, not blindly replayed.
Local state is sensitive and is not encrypted by the application.

## Development

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:terminal
```

Routine SDK/provider fixtures are synthetic and do not prove live account/model
availability. Live providers, paid calls, authenticated MCP and Docker acceptance
are explicit and opt-in.

See [architecture](ARCHITECTURE.md), [product contract](PRODUCT.md),
[the hard-cutover plan](NATIVE_SDK_MIGRATION_PLAN.md) and
[implementation evidence](IMPLEMENTATION_PLAN.md).

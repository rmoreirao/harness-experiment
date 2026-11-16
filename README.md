# Harness experiment

A local, resumable, approval-first agent harness for **Windows Terminal +
PowerShell**, built with TypeScript/Node.js, React/Ink, SQLite and the pinned
Copilot SDK/runtime. One implementation supports coding, research and isolated
browser workflows; independent terminals can own separate sessions.

The application controls tools, approvals, evidence and recovery. Copilot owns
the agent loop, conversation and compaction. OpenAI-compatible endpoints are
supported through the Responses HTTP/SSE transport, not a second agent runtime.

## Install and run

Use Node.js **22.14.0 x64** on Windows. Native SQLite and file-locking dependencies
may require Visual Studio C++ build tools if compatible prebuilt binaries are
unavailable; there is no in-memory fallback.

```powershell
npm ci
Copy-Item .\.env.example .\.env
Copy-Item .\harness.example.json .\harness.local.json
# Edit .env and harness.local.json before launching.
npm run build
node .\dist\cli.js --config .\harness.local.json
```

Set an existing workspace, an external data directory and your endpoint/model
identities. Replace the example's `YOUR_USER` path. Keep keys in the ignored
`.env` or process environment, never JSON configuration or committed files:

```dotenv
OPENAI_BASE_URL=https://your-endpoint.example/v1
HARNESS_MODEL=your-canonical-model-identifier
HARNESS_WIRE_MODEL=your-deployment-identifier
OPENAI_API_KEY=your-key
```

`HARNESS_WIRE_MODEL` is optional when both identities match. The CLI loads `.env`
from its launch directory, not the workspace; existing process variables take
precedence. Nonempty environment endpoint/model values override JSON.
There is no provider, account, model or transport fallback.

Use `npm run dev -- --config .\harness.local.json` for source development.
The installed command is `harness`. See the [guide](docs/GUIDE.md) for capability
prerequisites, configuration, commands, recovery and the headless protocol.

## Capabilities and controls

- **Coding:** bounded source discovery/reads/search, hash-bound precise edits,
  read-only Git inspection, and separately approved publication from isolated
  Docker execution mirrors. No host-shell fallback or automatic image pulls.
- **Research:** protected HTTPS retrieval, optional explicitly configured Brave
  search, exact source evidence and citation-checked reports.
- **Browser:** a reviewed installed Chromium binary, clean session state,
  observation-bound actions and quarantined artifacts. Personal profiles,
  JavaScript sites, uploads and authenticated connectors are not supported.
- **Oversight:** per-action approvals, explicit trusted-read grants, cancellation,
  inspection and durable reconciliation of unknown effects. `/approve_all`
  deliberately enables session-wide tool approval; restrictions still apply.
- **Skills:** workspace `.github\skills\<name>\SKILL.md` snapshots, inspected and
  refreshed with `/skills list` and `/skills reload`; no ambient executable hooks.

New sessions use configuration **version 3**: SDK/provider prompt/output defaults
and no cumulative token/currency budget unless explicitly configured. Usage,
request/action/time limits and optional spending policies remain visible.
Uncapped workloads can incur higher charges; timeouts are not money caps.

## Sessions and API

```powershell
node .\dist\cli.js sessions
node .\dist\cli.js resume SESSION_ID
node .\dist\cli.js resume SESSION_ID --data-dir 'D:\harness-data\v2'
```

Saved Copilot sessions retain their configuration, model identity, evidence,
usage and runtime mapping. Configuration formats 2 and 3 remain supported;
resuming a format-2 session does not remove its saved budget.

For compatibility, the default data directory remains
`%LOCALAPPDATA%\harness-experiment\v2`, with `product-v2.db` and session-owned
runtime journals. These persisted names do not indicate another implementation.
Existing local configuration filenames still work when passed with `--config`.
The original MVP runtime and legacy-history viewer have been removed; old
databases are left untouched and are not converted into Copilot checkpoints.
Local state is sensitive and is not encrypted by the application.

Import `SessionController`, `parseConfig`, `loadConfig`, `Config` and the
objective/action/runtime contracts from `harness-experiment`. There is no `/v2`
subpath. `--headless` exposes the same controller through bounded JSON lines.
`submit` may wait for a human decision; service callbacks must not auto-approve.

## Development

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:terminal
```

Builds replace only the generated `dist` tree, preventing obsolete runtime
modules from entering packages. `npm run verify:package -- <fresh-archive.tgz>`
checks a clean installed package. The main suite uses synthetic/loopback model
responses through the real pinned SDK; it does not prove live model quality.
Docker/Chromium cases require reviewed local prerequisites and are otherwise
explicitly skipped. The paid `verify:news` verifier is opt-in and never part of
routine tests or CI.

See [product scope](PRODUCT.md), [architecture](ARCHITECTURE.md),
[implementation evidence and limitations](IMPLEMENTATION_PLAN.md), and
[SDK-first resource semantics](SDK_FIRST_LIMITS_PLAN.md). Consolidating the
implementation does not establish full production release acceptance.

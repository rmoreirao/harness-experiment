# Native harness guide

## Prerequisites and first launch

Use Node.js 22.14.0 x64, Windows Terminal and PowerShell. Install dependencies with
`npm ci`; native SQLite/file-locking modules may need Visual Studio C++ build tools.
Build with `npm run build`.

Copy `harness.example.json` to an ignored local configuration. Only native config
version 4 is supported. Select an existing workspace and a fresh data directory
outside it. Keep credentials in the environment or ignored `.env`, not in JSON.

```powershell
node .\dist\cli.js --config .\harness.local.json
```

Loading configuration does not trust the session. Read the native-execution
warning and issue `/trust` before submitting work or loading SDK skills/auth.
Workspace hooks and MCP processes must not start before trust.

For unattended use, `--trust-workspace` is an explicit trust grant for that
session. Do not add it to an unreviewed invocation merely to bypass a warning.

## Providers and model selection

Choose one provider for a session:

- Copilot: `{ "kind": "copilot" }`, using SDK-supported sign-in and model discovery.
- BYOK: `{ "kind": "byok", "baseURL": "https://your-endpoint.example/v1",
  "apiKeyEnv": "OPENAI_API_KEY" }`.

`model.canonical` selects the parent model and `model.wire` identifies its BYOK
deployment where different. Additional configured models allow worker overrides
within the same provider. A required unavailable model is an error; providers are
not mixed or silently substituted.

```text
/auth status
/auth login
/auth advance
/auth cancel
```

Follow the returned SDK browser/device authorization instructions. Do not paste
tokens, passwords or device codes into an ordinary model objective. Login output
is a host interaction, not agent conversation evidence.
Use `/auth login proxima` for the supported enterprise device flow. If the SDK
requests account selection or plaintext-storage consent, supply the explicit
choice with `/auth advance VALUE`; neither choice is made automatically. Headless
`auth` accepts an optional `input` string for the same flow.

The CLI loads `.env` from the launch directory; existing environment variables
take precedence. Native commands use normal developer profiles, but known
harness-owned provider/search keys are not automatically inherited. Commands can
still read files your account can access.

## Permissions and task progression

After explicit trust, the default permission mode is `allow-all`. This permits
native commands, edits and network access without ordinary per-action prompts
where enforced policy allows. It grants no administrator privileges or sandbox.

```text
/permissions manual
/permissions assisted
/permissions allow-all
/approve_all
/approve_all off
```

The final two commands select allow-all and manual respectively. Managed-policy
requests may still require an explicit answer. `/approve` or `/reject` applies to
the displayed live SDK request, not to an arbitrary future command.

Task progression is separate:

```text
/mode interactive
/mode plan
/mode autopilot
```

Interactive is the default. Autopilot does not itself grant tool permissions.

## Workspace configuration and workers

SDK instructions, skills, agents, hooks and MCP sources are limited to trusted
workspace configuration. Personal Copilot instruction/agent/hook/MCP files are not
discovered. Developer tools may still use ordinary Git/npm profiles and account
credential stores.

Workspace roots include `.github\skills`, `.github\agents` and `.github\hooks`
unless explicitly configured otherwise within the workspace. Symlinked or
out-of-workspace discovery roots are not a way to load personal configuration.
Configured SDK MCP servers may be local stdio processes or remote integrations.
Authentication and availability errors are explicit.

```text
/skills list
/skills reload
/mcp list
/mcp status SERVER
/mcp login SERVER
```

Reload restarts SDK discovery while idle. It is not a separate harness snapshot
catalog.
MCP login returns the SDK's authorization URL; open it and complete consent, then
inspect server status. The SDK owns the loopback callback and credential storage.
Only explicitly configured workspace services are eligible. Authorization URLs
are host responses, not model messages or journal evidence.

Built-in specialists and custom agents run under the parent objective. Parent and
worker activity must remain distinguishable. Use non-overlapping file
assignments for concurrent writers; the retained assignment tools detect
conflicting reservations. This is coordination, not filesystem confinement.

## Activity and evidence

Citation retrieval (`harness_web_fetch`) defaults to `network.origins: ["*"]`.
Any public HTTPS origin, including Globo.com and its subdomains, is admitted
without listing individual sites. You can explicitly set `origins: []` or an
exact-origin list to restrict retrieval. Private/metadata destinations and unsafe
URLs remain blocked; this does not impose restrictions on native shell networking.

Existing sessions retain their saved configuration. After rebuilding, start a
new session without an old restrictive configuration, or set
`"network": { "origins": ["*"] }` in your configuration before starting a new one.

```text
/status
/plan
/trace on
/trace expand
/trace older
/trace latest
/trace CALL_ID
/inspect RESULT_ID
/events
/errors
```

`/plan` reads the SDK plan. Trace output shows model/tool activity and workers;
output inspection does not rerun effects. Arguments/results are bounded and
redacted where known. Hidden reasoning and raw authentication secrets are not
product evidence.

Token/monetary caps are optional and only accepted where enforceable. Parent and
worker requests are aggregated without duplicate counting. Copilot consumption
is not automatically equivalent to BYOK prices. Unknown usage/cost is labeled,
not estimated as zero.
These limits cover intercepted model requests and explicitly priced retained
domain requests, not total account or machine spending. Arbitrary native commands
and external MCP services can incur independent charges outside that accounting
boundary. The displayed tracked cost is not a whole-system spending guarantee.
Native defaults allow one hour per objective, five minutes per tool/model
request, 1,000 model requests and 1,000 actions. These remain explicit configurable
limits, not spending caps. Command/model/worker concurrency defaults to four;
configured examples may choose a lower command limit. Increase deadlines for
long builds or deliberately long-running commands as needed.

Coding completion uses native command evidence instead of requiring Docker.
Relevant checks and review of changed files remain part of the task. Native web
retrieval alone does not establish a citation-verified research report; use the
retained evidence/report tools for that contract.

## Cancellation, recovery and sessions

```text
/cancel
/reconcile {"note":"inspected effects","actions":[],"workers":[],"usage":[]}
/continue
/clear
/exit
```

Cancellation stops owned work where supported; completed edits, network requests
and other external effects are not undone. Uncertain actions/workers remain
unresolved until explicitly inspected and reconciled. A restart does not replay
expired approvals or blindly rerun commands.

`/clear` resets SDK conversation context while idle; saved native evidence and
session settings remain. Fresh sessions and supported native resumes use
`native.db`. Historical stores are unsupported and are not converted or deleted.

```powershell
node .\dist\cli.js sessions
node .\dist\cli.js resume NATIVE_SESSION_ID
```

## Headless protocol

Use `--headless` for bounded JSON-lines messages. Request shape:

```json
{"id":"trust-1","operation":"trust","args":{"trusted":true}}
{"id":"permissions-1","operation":"permissions","args":{"mode":"allow-all"}}
{"id":"mode-1","operation":"mode","args":{"mode":"interactive"}}
{"id":"auth-1","operation":"auth","args":{"action":"status"}}
{"id":"submit-1","operation":"submit","args":{"objective":"Inspect this project"}}
```

Responses and asynchronous events are separate. A submitted objective may await
a live user decision; service callbacks must not manufacture one.

Other operations include `inspect`, `skills`, `decide`, `cancel`, `continue`,
`mcp`, `reconcile`, `result`, `events` and `close`. Decisions bind a live
ID/revision/binding; stale or interrupted decisions are rejected. `decide` defaults
to `source: "external"`. A host may label `source: "human_response"` only when it
actually collected that decision from a person; automated answers must not claim
human authority.

## Optional Docker

Docker must be explicitly configured with a pinned, installed Linux image.
Only that tool uses a filtered workspace mirror, no-network container, nonroot
identity and resource limits. Inspection and hash-bound publication remain
separate operations. Native shell commands do not inherit Docker isolation.

The application never silently changes to Docker or a legacy runtime when native
execution/authentication fails.

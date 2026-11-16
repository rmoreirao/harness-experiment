# Harness experiment

A local, approval-first agent harness for **Windows Terminal + PowerShell**.
TypeScript/Node.js, React/Ink, OpenAI Agents SDK, and SQLite. One resumable session
per terminal process; different terminals can run independent sessions.

An **opt-in V2 preview** now uses the pinned Copilot SDK/runtime for broader
coding, research and isolated browser workflows. Configure `harness.v2.local.json`
and run `npm run dev:v2 -- --config .\harness.v2.local.json`; see
[V2 setup, API and limitations](docs/V2.md).
The MVP command and historical data remain unchanged. V2 is not release-accepted
and is not the default.
V2 loads workspace skills from `.github\skills\<name>\SKILL.md` at startup;
use `/skills list` and `/skills reload` to inspect and refresh the loaded set.
In V2, `/approve_all` approves every pending and future tool call for the session,
including after resume; `/approve_all off` restores per-call approvals.
Questions and capability/safety restrictions remain in force.
New V2 sessions use SDK/provider prompt/output defaults and no mandatory
100,000-token task cap. Optional explicit budgets are supported; existing
version-2 sessions keep their saved policy. See the V2 guide before running
uncapped paid workloads.

The offline reference workflow and regression suite use a deterministic fake
model through the real Agents SDK. Fake output is prominently labeled and is
not evidence of language-model quality. The real OpenAI HTTP/SSE client also
has loopback protocol tests. The configured OpenAI-compatible endpoint has
successfully completed a live read/approve/save workflow with `gpt-6-luna`.
Current verification evidence, budget-limit cases, and remaining native
clipboard/display checks are recorded in `MVP_IMPLEMENTATION_PLAN.md`.

## Install and run

The development baseline is Node.js **22.14.0 x64** on Windows. The package pins
dependencies, including the native SQLite and locking libraries. If a compatible
prebuilt native binary is unavailable, installation may require Visual Studio
C++ build tools; an installation failure is not bypassed with in-memory storage.

```powershell
npm ci
npm run build
node .\dist\cli.js --fake --workspace '.\docs'
```

The repository's `docs` folder already exists. Replace `.\docs` with another
existing folder of `.txt` and `.md` files if desired. Enter:

```text
Read documents, summarize them, and save the summary.
```

Approve the explicit read request with `/approve`, then approve the separate
save request. Use `/request` to inspect the complete action and `/reject` to deny
it. The initial workflow creates `summary.md`; it will not silently overwrite
an existing file.

The fake model demonstrates this reference workflow and clarification requests.
It is not a general-purpose local LLM. A live model uses the same controller,
permissions, tools, storage, and UI.

## Model configuration and credentials

Fill in the repository's ignored `.env` file:

```dotenv
OPENAI_BASE_URL=https://your-endpoint.example/v1
HARNESS_MODEL=your-model-identifier
OPENAI_API_KEY=your-api-key
```

These are placeholders, not working credentials or an automatic endpoint
fallback. `.env.example` contains the same settings without secrets and can
be copied to `.env` in a fresh checkout. The CLI loads `.env` from the directory
where you launch it, not from the `--workspace` folder.

After editing `.env`, build and run from the repository directory:

```powershell
npm run build
node .\dist\cli.js --workspace '.\docs'
```

The workspace must already exist. For additional settings such as model
context/output limits, local storage, and budgets, copy `harness.example.json`
to the ignored `harness.local.json`, edit it, and add
`--config .\harness.local.json` to the command. The model and endpoint from the
environment override those in JSON when nonempty.

Keep API keys only in the ignored local `.env` or the launching process
environment, never in JSON configuration, conversations, CLI arguments, or
committed source. `.env` is plaintext: protect it with your Windows account
permissions and do not share it. You can avoid storing the key on disk by
prompting for it without echoing:

```powershell
$secureKey = Read-Host 'OpenAI API key' -AsSecureString
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
node .\dist\cli.js --config .\harness.local.json
Remove-Item Env:\OPENAI_API_KEY
```

Existing process environment variables take precedence over `.env`, including
an explicitly set empty value. Configuration precedence is defaults, explicit
JSON file, nonempty `OPENAI_BASE_URL` and `HARNESS_MODEL` environment overrides,
then CLI workspace/data-directory/fake overrides. Unknown JSON fields are
rejected. Secrets are not part of the stored configuration or SDK runtime
context. Resumed sessions retain their saved endpoint and model; start a new
session to change those settings.

Use the API base URL, not a complete request URL: for example, an endpoint
whose Responses route ends in `/openai/v1/responses` needs a base URL ending in
`/openai/v1/`. The SDK appends `/responses`.

An optional `enabledTools` array in JSON configuration restricts both the tools
shown to the model and direct gateway dispatch. Unknown names fail at startup.
For example, `["read_documents", "write_file", "ask_user"]` limits a session to a
small document workflow. Without the array, the existing built-in tools and
explicitly configured MCP tools remain available.

The initial provider uses the **Responses API**, streamed function calling, and
reported token usage. A custom endpoint must support those contracts. A local
OpenAI-compatible endpoint can be configured explicitly, but its compatibility
is not assumed and the application never switches APIs or falls back to a
remote model automatically. Only loopback endpoints may use plain HTTP.

For currency budgets set all three fields under `limits`:
`maxCost`, `inputPerMillion`, and `outputPerMillion`, in the same currency.
Prices are user configuration, not automatically downloaded pricing.
Without configured prices, remote `usage.cost` is `null`, not a claim of free
inference. Fake-mode inference has no provider charge.

## Sessions and terminal controls

```powershell
node .\dist\cli.js sessions
node .\dist\cli.js resume SESSION_ID
# If the session used a nondefault storage directory:
node .\dist\cli.js resume SESSION_ID --data-dir 'D:\harness-data'
```

An exclusive OS-backed lock prevents two processes from owning the same session.
The lock is released on process termination. Independent sessions share SQLite
but not history, approvals, or per-run budgets. Shared workspace files are **not**
isolated; overlapping active workspaces generate a warning.

| Input | Action |
|---|---|
| Enter | Submit the draft |
| Ctrl+J or Alt+Enter | Insert a newline |
| Bracketed/native multiline paste | Insert a draft without submitting |
| Arrows, Home, End, Backspace, Delete | Edit; Up/Down recall input at multiline boundaries |
| PageUp / PageDown | Scroll the current view |
| Ctrl+C | Interrupt work/pending action, or clear the idle draft |
| Ctrl+D or `/exit` | Save and exit; pending approvals remain resumable |
| `/help`, `/status` | Commands and current session/run configuration |
| `/request`, `/back` | Inspect the entire pending request; return to conversation |
| `/approve`, `/reject` | Decide the displayed current tool call only |
| `/inspect INVOCATION_ID` | Inspect its stored result |
| `/errors [BEFORE_ID]`, `/error ERROR_ID` | List session errors, page through older errors, or inspect one error |
| `/continue` | Continue a compatible persisted SDK checkpoint |
| `/cancel` | Cancel without discarding the conversation |

Questions accept a normal typed answer. Approval decisions cannot be supplied
through document instructions or tool output. The UI captures no mouse events;
native Windows Terminal text selection/copy remains available.

## Tools and approval policy

Built-in tools list document names, read/search approved text, write approved
text, record tasks, and request clarification. Reading includes content access
for search and hashes. Document contents are sent to the configured model only
after a read approval. File writes use `expectedHash: "new"` or the content hash
from an approved read; changed content invalidates an overwrite.

Paths are restricted to the configured workspace. Credential/internal paths,
NTFS alternate streams, symlinks/junctions, multiply linked files, traversal,
and reserved Windows names are rejected. Built-in reads support UTF-8 `.txt`
and `.md`, not arbitrary office/binary formats.

The application coordinates its own concurrent file writers and detects stale
content. It does not claim atomic isolation against arbitrary external editors
or provide a general-purpose sandbox. Arbitrary shell/code/computer tools are
not exposed.

## No-auth MCP

Add explicitly trusted servers and an explicit tool allowlist to `mcp`:

```json
[
  {
    "name": "local",
    "transport": "stdio",
    "command": "node",
    "args": ["D:\\tools\\approved-mcp-server.js"],
    "tools": ["lookup"],
    "trusted": true
  },
  {
    "name": "service",
    "transport": "http",
    "url": "http://127.0.0.1:8080/mcp",
    "tools": ["lookup"],
    "trusted": true
  }
]
```

These are configuration examples, not bundled servers. Starting a stdio server
executes installed software with OS privileges: review it before setting
`trusted`. The server does not inherit the OpenAI API key. Remote HTTP requires
TLS except on loopback. Authentication-required servers fail explicitly:
OAuth, login, and MCP credential forwarding are outside the MVP.

MCP calls require approval regardless of server read-only annotations.
Input schemas are validated locally; outputs are untrusted and bounded for
model display. Tool descriptions cannot authorize actions. Provider-hosted MCP
execution and arbitrary execution tools are not enabled.

## Persistence, interruptions, and privacy

The default data directory is `%LOCALAPPDATA%\harness-experiment`. It contains
`harness.db`, WAL files, stable lock files, and offloaded tool results. This is
local sensitive conversation data: protect it using Windows account/filesystem
permissions. It is not encrypted by this application.

Working model history, the original transcript, task state, and execution
records are separate. Before every SDK model call, extractive working-memory
compaction can summarize older completed exchanges to fit both the context
window and remaining token budget. The latest user request, authoritative
instructions, structured task state, and latest complete tool exchange stay
intact, including complete parallel call/result batches. Pending approvals
cannot be bypassed by rewriting history.

The original transcript and tool results remain inspectable. Summaries are
lossy working memory, not new authoritative instructions. If the irreducible
request and latest exchange cannot fit safely, execution stops explicitly.

Approvals persist the exact action and a compatible SDK checkpoint.
An interrupted side-effecting tool may have completed externally before its
outcome was stored. Such work is marked **unknown**, never automatically
repeated. Inspect the external state first; the application does not undo it.

For an interrupted run, record the reconciliation explicitly:

```text
/reconcile {"note":"Checked the output; the action completed once."}
```

If provider usage is unknown, also supply the input/output tokens attributable
to the unresolved request, after checking provider records:

```text
/reconcile {"note":"Checked action and provider usage.","input":120,"output":40}
```

This closes the interrupted run as partial; it does not replay the tool.
Checkpoint/schema/tool incompatibilities fail closed rather than guessing how
to restore execution. No detached execution is promised.

SDK external tracing is disabled/replaced. Local lifecycle events contain
session/run correlation and trace/span identifiers. Known credentials and
terminal control sequences are removed from diagnostic output. Arbitrary
personal-data recognition is not promised.

Errors display a stable ID such as `error-12`. Use `/errors` for the latest 20
errors in this session, `/error error-12` for its diagnostic details, and the
displayed `/errors BEFORE_ID` command for older entries. History survives resume
and includes earlier runs; inspecting it never retries an action. Details include
the recorded timestamp, run/tool identities, error code, HTTP status and provider
request ID when available, plus bounded, redacted stack/cause information for new
errors. Historical errors retain whatever details were originally recorded.
Diagnostics do not add request bodies, prompts, tool arguments, or response
bodies. Error messages themselves may still contain sensitive document data;
review them before sharing. Commands report explicitly if an error cannot be
saved. This session inspector does not capture failures before a session opens.

## Resource semantics

- `maxIterations` bounds model-loop requests, including across approvals.
- `maxTokens` uses conservative admission reservations and reported input/output
  usage. Reservations use UTF-8/JSON size plus overhead as an upper estimate,
  not an exact tokenizer. A small budget can therefore stop execution before
  the reported token total reaches the cap. `maxOutputTokens` bounds each
  provider request.
- `contextTokens` must reflect the actual configured model. Older completed
  exchanges are compacted during a run as well as between requests; oversized
  irreducible input is rejected. The UI shows the last request's conservative
  context estimate separately from the reported token total.
- `activeTimeoutMs` counts active execution segments across continuations and
  restarts. Time waiting for user decisions or while the application is closed
  is excluded. `modelTimeoutMs` and `toolTimeoutMs` bound individual operations.
- `maxConcurrency` bounds SDK function-tool execution. Currency limits reserve
  for in-flight work and reconcile reported usage; provider accounting can
  still cause overshoot, which is recorded and stops further work.
- Only classified pre-stream HTTP 429 responses are retried, at most twice
  with exponential backoff. Hidden provider-client retries are disabled.
- Custom tools must honor cancellation. If a local custom tool keeps running,
  further execution and ownership release are blocked until it settles.

## Programmatic API

```typescript
import { SessionController, parseConfig } from 'harness-experiment';

const config = parseConfig({
  mode: 'fake',
  workspace: 'D:\\documents',
  dataDir: 'D:\\harness-data',
});
const app = await SessionController.open({ config });
try {
  const unsubscribe = app.subscribe(event => console.log(event));
  await app.submit('Read documents, summarize them, and save.');
  const request = app.inspect().pending[0];
  // Present this request to an actual user. Only after their decision:
  // await app.respond(request.id, request.revision, 'approve');
  unsubscribe();
} finally {
  await app.close();
}
```

`inspect`, `submit`, `respond`, `continueRun`, `cancel`, `reconcile`, and `close`
form the headless controller API. `Store.sessions()` supports discovery.
`OpenOptions.tools` registers trusted application tool definitions through the same gateway.
Read/write/external effects cannot opt out of mandatory approval; only internal
operations and the built-in metadata listing run without it. Effect declarations
are a contract for trusted extension code, not an OS sandbox.
Use `validators` to check final output and artifacts and `hooks` to observe
lifecycle events; hook failures propagate. `outputSchema` optionally validates final JSON.
`executeWorkflow` supplies dependency-aware sequential/conditional/bounded
parallel TypeScript composition without adding another agent loop.

Use `app.store.trace(runId)` for ordered redacted local events. This is a local
trace representation, not a hosted telemetry service or a crash-recovery
substitute.

## Development and verification

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:terminal
npm run eval
npm pack
npm run verify:package
```

Tests use synthetic documents, fake inference, controlled no-auth MCP fixtures,
real SQLite, and real Windows processes. `verify:terminal` exercises the real
Ink CLI through PowerShell/ConPTY, including independent concurrent sessions,
duplicate ownership rejection, paste, resize, approval restart, cancellation,
and subsequent requests.
It is not a substitute for confirming actual Windows Terminal clipboard and
font/display behavior. Native app automation was denied by this environment's
application policy; that check cannot be bypassed through another launch route.
See the implementation evidence in
`MVP_IMPLEMENTATION_PLAN.md` for verified and pending release gates.

No live model calls, model downloads, package-registry publishing, or paid
verification are performed automatically by these commands.

Live verification loads the same `.env` as the CLI. After explicitly authorizing
a currency budget with configured `maxCost` and prices, run:

```powershell
node --import tsx .\test\live-check.ts --live --config .\harness.local.json
```

Alternatively, explicitly authorize a token/request cap without configuring
currency pricing:

```powershell
node --import tsx .\test\live-check.ts --live --max-tokens 20000 --max-requests 10
```

In token-capped mode, currency cost remains unknown. Existing configured
currency limits are still enforced; token flags never disable them.
Caps must accommodate conservative request reservations, not only the expected
reported token total. All live inference is opt-in; routine tests exercise the
same verifier against controlled loopback fixtures without paid calls.

This uses fresh synthetic documents and storage, disables configured MCP
servers, exposes only read/write/clarification tools, and exercises separate
read/save approvals through the controller. Up to two clarification questions
receive the fixed synthetic source/output instructions; unexpected actions
are not approved. Reports include usage and stop reasons for failed runs.
It never uses your configured document folder. It checks the resulting summary
for the synthetic fact and source reference; it is not a general model-quality
benchmark. It is not run by the default tests or CI.

### Native Windows Terminal checklist

The user has confirmed native startup with the configured model. For the
remaining physical clipboard/display check, use a disposable document folder:

1. Paste a multiline prompt and confirm it stays a draft until Enter.
2. Select/copy transcript text using Windows Terminal and confirm it matches.
3. Resize the window and confirm the draft, transcript, and pending action remain usable.
4. Exit at a read or save approval, resume the listed session, and confirm the same action is pending.
5. Cancel a pending action with Ctrl+C, then submit another request.

The process/approval portions are also automated by `verify:terminal`.
Clipboard selection and font/display fidelity are manual checks, not inferred
from the headless terminal results. Do not copy API keys into the conversation.

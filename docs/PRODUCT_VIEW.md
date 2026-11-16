# Product View: General-Purpose Agent Harness

Research date: 2026-11-13
Product direction updated: 2026-11-14

A modern agent harness should make agents **controllable, recoverable, observable, and extensible**, not simply run an LLM in a loop. Advanced multi-agent collaboration is valuable, but reliable execution should come first.

This product view targets a **developer-facing, production-capable general-purpose agent runtime and orchestration harness**. The priorities below are product recommendations, rather than a claim that every framework implements every capability.

## Product direction

The product should let a user delegate meaningful **coding, research, and browser work** from a terminal. A powerful harness combines useful tools with planning, evidence-based completion, permissions, and recovery; it is not simply a larger tool catalog.

The repository contains one implementation for coding, research and controlled
browser work. Its scope, architecture and acceptance evidence are documented in
`PRODUCT.md`, `ARCHITECTURE.md` and `IMPLEMENTATION_PLAN.md`.

The product retains TypeScript, Node.js, Ink, Windows Terminal with PowerShell,
and one active session per terminal. **Copilot SDK is the single agent execution
backend**. LangGraph and Deep Agents are comparison references, not additional
orchestration dependencies.

The runtime decision is recorded in `docs\decisions\agent-runtime.md`.

General file tools, precise editing, isolated process execution, search/retrieval,
browser interaction, task evidence and local skills are in product scope.
The nice-to-have table below describes the broader product landscape;
`PRODUCT.md` decides mandatory requirements. This research view is not a claim
that all acceptance gates have passed.

The same user experience should support three outcomes:

- Investigate a code issue, make a focused change, run relevant checks, and present a reviewable diff.
- Research a question, inspect sources, identify conflicting evidence, and produce a cited report.
- Navigate a website and complete an approved task while retaining control over sensitive actions.

Approval-first remains the default. Scoped trusted-read grants are an explicit opt-in; adopting a runtime with broader default tools does not authorize broader access. Command isolation and browser controls must be enforced outside the model.

## Research Basis

The research reviewed official documentation for:

- [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
- [Microsoft Agent Framework Harness](https://learn.microsoft.com/en-us/agent-framework/concepts/harness)
- [LangGraph Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers)
- [AWS AgentCore Harness](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html)
- [Copilot SDK](https://github.com/github/copilot-sdk), including its [SDK/CLI compatibility reference](https://github.com/github/copilot-sdk/blob/main/docs/troubleshooting/compatibility.md)
- [Microsoft Copilot harness announcement](https://aka.ms/copilot-harness/announce)
- [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview), as a capability reference rather than a selected dependency
- [Playwright MCP](https://github.com/microsoft/playwright-mcp), as a browser integration option

## Must-Have: Production Baseline

| Capability | Minimum product requirement |
|---|---|
| **Agent configuration** | Define instructions, model settings, available tools, permissions, and expected output. Keep model integration behind an adapter rather than coupling the runtime to one provider. |
| **Controlled execution loop** | Manage model calls, tool execution, results, and completion. Expose explicit states such as running, awaiting input, completed, failed, and cancelled. |
| **Tool integration** | Support custom tools and an **MCP client**, with schema validation, timeouts, structured errors, and explicit authentication. |
| **Sessions and persistent state** | Preserve conversation history, task progress, and tool results across interactions. Keep sessions and their data appropriately isolated. |
| **Context management** | Track context usage; compact, summarize, or offload large results before overflow. Preserve authoritative instructions and structured task state separately from lossy summaries. |
| **Planning and basic orchestration** | Track tasks and progress; compose sequential steps, conditional branches, and bounded parallel work. Developers must be able to constrain execution paths. |
| **Recovery and failure handling** | Checkpoint progress, resume interrupted runs, and retry transient failures with bounded backoff. Handle uncertain external side effects explicitly rather than blindly repeating actions. |
| **Human oversight** | Pause for clarification or approval, show the proposed action and arguments, accept rejection or correction, and resume later. Support cancellation. |
| **Enforced security boundaries** | Apply least-privilege tool access and protect credentials. Treat retrieved content as untrusted. If executing code or shell commands, enforce filesystem, process, and network isolation outside the model. |
| **Resource controls** | Limit iterations, tokens, elapsed time, and concurrency. Track spending and enforce budget policies with documented limits on in-flight overshoot. |
| **Results and artifacts** | Return structured outputs and files associated with the run. Distinguish successful completion, partial results, and failure; support application-defined completion validators. |
| **Observability and auditability** | Stream progress and record model/tool activity, errors, approvals, latency, and usage. Provide correlated traces, preferably OpenTelemetry-compatible, with sensitive-data redaction. |
| **Developer integration and regression evaluation** | Provide a documented API or SDK for starting, inspecting, streaming, resuming, and cancelling runs; lifecycle hooks; versioned configurations; and a way to evaluate changes against representative tasks. |

### Important Research Findings

**Compaction alone is insufficient for long-running work.** Persistent progress, clear completion criteria, and verification are also needed, as Anthropic's [long-running harness research](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents) illustrates.

**Approval must be an execution mechanism, not a prompt instruction.** OpenAI's [human-in-the-loop implementation](https://openai.github.io/openai-agents-python/human_in_the_loop/) demonstrates pausing, persisting, approving or rejecting, and resuming a run.

## Nice-to-Have: Expansion and Differentiation

| Capability | Value beyond the baseline |
|---|---|
| **Advanced multi-agent orchestration** | Specialist delegation, supervisors, handoffs, dynamic teams, and coordinated background agents with separate contexts. |
| **Long-term memory** | Remember useful information across sessions, with provenance, correction, expiry, and deletion controls. Distinct from essential session persistence. |
| **Intelligent model routing** | Choose models by task, cost, latency, or capability; support carefully controlled provider failover. |
| **Skills and reusable packages** | Package instructions, tools, workflows, and supporting resources; discover and load capabilities on demand. |
| **Scheduling and event triggers** | Start work from schedules, webhooks, queues, or external events rather than only direct requests. |
| **Built-in execution tools** | Ready-made browsing, search, code execution, document processing, and filesystem tools. The extension interface is essential; every built-in connector is not. |
| **Visual operations interface** | Inspect runs, manage approvals, explore traces, and author workflows without writing code. |
| **Checkpoint branching and debugging** | Fork saved state to investigate alternative approaches or debug failures. Re-execution should not imply identical model output. |
| **Cross-runtime interoperability** | Expose agents through protocols such as A2A or publish capabilities as an MCP server. Separate from consuming MCP tools. |
| **Advanced platform operations** | Distributed workers, autoscaling, enterprise SSO/SCIM, administration dashboards, automated evaluations, and controlled A/B rollouts. |

## Conditional Priorities

- **Shared hosted service:** Authenticated access, tenant isolation, and per-tenant quotas become must-haves.
- **Proactive automation product:** Scheduling becomes a must-have.
- **Persistent personalization:** Long-term memory becomes a must-have if personalization is the central product promise.

## Recommended implementation boundary

Support one model provider, one durable storage backend, custom tools plus MCP, simple workflow composition, approvals, resource limits, traces, and artifact delivery. Build autonomous agent teams afterward.

## Critical Design Constraints

- Checkpoints do not guarantee exactly-once external actions.
- Cancellation does not undo completed actions.
- [MCP support does not itself provide a security boundary](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices).

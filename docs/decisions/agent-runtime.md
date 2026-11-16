# Agent runtime

Date: 2026-11-14.
Status: accepted and implemented as the sole runtime; full release acceptance pending.

## Decision

Use **Copilot SDK** as the only execution backend. Keep TypeScript/Node.js and Ink,
and retain useful application-level configuration, policy, evidence, artifacts
and storage. The retired MVP is available only through Git history.

Implement a clean runtime adapter rather than layering Copilot on top of OpenAI Agents SDK. Do not add LangGraph, Deep Agents, or Microsoft Agent Framework merely to connect the SDK.

`IMPLEMENTATION_PLAN.md` records SDK compatibility evidence and remaining gates.

## Context

The original MVP established a document-focused terminal product with an
OpenAI-specific controller, history adapter, checkpoints and budget/context
logic. The selected implementation supports broader coding, research, browser
work and reusable capabilities; that earlier runtime has been removed.

The user's priority is useful general-purpose work rather than inventing every low-level execution primitive. The existing application is worth reusing, but its SDK coupling means migration is not a change of package imports.

## Alternatives

| Alternative | Strength | Decision |
|---|---|---|
| Extend OpenAI Agents SDK | Continuity with the original code and explicit application control. | Rejected; the retired implementation is not shipped alongside Copilot. |
| Copilot SDK | Existing coding-oriented runtime, tools, sessions, skills, hooks, and MCP support. | Selected, with deliberate application controls and no assumption that every CLI feature is exposed through the SDK. |
| LangGraph | Explicit state/control flow, durable checkpointers, interrupts, and custom workflow composition. | Appropriate if the product's main requirement becomes owning a custom workflow engine; not necessary for the current tool-driven terminal product. |
| Deep Agents over LangGraph | A closer ready-made harness alternative than bare LangGraph. | Relevant comparison reference, but not an additional dependency alongside the chosen runtime. |
| Rewrite the whole application | Freedom to discard unsuitable boundaries. | No evidence justifies losing the useful UI, policy concepts, artifacts, and acceptance scenarios. Rebuild the runtime-facing layer selectively. |

## Ownership Consequences

- Copilot owns the model/tool loop, model-facing conversation state, and runtime compaction.
- The application owns the user experience, capability policy, domain plan/evidence, artifact catalog, verification, and session mapping.
- SQLite is not a second store that rewrites the runtime's raw conversation items.
- Existing OpenAI `RunState` snapshots are not Copilot checkpoints. Old data is
  left untouched, but the legacy-history viewer is removed. Existing Copilot
  sessions retain their saved configuration, runtime mapping and data namespace.
- The normal SDK transport introduces an owned runtime child process. The application remains one terminal client per active product session, not a centralized service.
- Availability of built-in shell/file tools does not authorize them. Configure explicit tool filtering and deny-by-default permission handling before enabling capabilities.
- Keep uncontrolled host execution and ambient hook/config discovery disabled. Model-specific tool choices must still satisfy application policy.

## First Implementation Checks

Verify the pinned TypeScript SDK/runtime combination with the supplied endpoint/model and BYOK configuration; exact model/deployment identity may affect editing tool selection.

Exercise streaming, custom and first-party tool filtering, permission denial, exact request identity, cancellation, and persisted session resume. Check which callbacks can record intent before every controlled side effect and what survives a permission-wait restart.

Verify usage and enforcement controls, including compaction/auxiliary calls, BYOK cost accounting, tool concurrency, and cancellation of owned processes. Copilot AI Credits limits are not automatically equivalent to application token/currency limits, and a provider parallel-tool hint is not an execution semaphore.

Demonstrate the supported isolated process/browser integration and confirm that keys do not appear in runtime storage, hook payload exports, diagnostics, or execution environments.

If a check exposes an incompatibility, fix the integration or identify the exact unsatisfied requirement and escalate the concrete design change. Do not silently drop a requirement, enable unrestricted tools, or switch frameworks. Continue independent safe work while resolving the issue.

## Known Distinctions

The SDK is transitioning from GitHub Copilot SDK to Microsoft Copilot SDK. Package names such as `@github/copilot-sdk` remain in use during that transition; pin the actual published SDK and compatible runtime rather than assuming a namespace.

The shared Microsoft/GitHub harness is not evidence that every Microsoft product directly calls the public SDK.

The SDK does not automatically supply every interactive CLI workflow. In
particular, CLI `/research` is not an SDK research product; source retrieval,
evidence handling, browser integration and completion verification remain
application responsibilities.

## Primary References

- [Copilot SDK and architecture](https://github.com/github/copilot-sdk)
- [Microsoft Copilot harness announcement](https://aka.ms/copilot-harness/announce)
- [SDK transition announcement](https://github.blog/changelog/2026-10-28-github-copilot-sdk-is-becoming-microsoft-copilot-sdk/)
- [BYOK](https://github.com/github/copilot-sdk/blob/main/docs/auth/byok.md)
- [SDK/CLI compatibility](https://github.com/github/copilot-sdk/blob/main/docs/troubleshooting/compatibility.md)
- [Runtime loop and auxiliary model calls](https://github.com/github/copilot-sdk/blob/main/docs/features/agent-loop.md)
- [Session persistence](https://github.com/github/copilot-sdk/blob/main/docs/features/session-persistence.md)
- [Session limits](https://github.com/github/copilot-sdk/blob/main/docs/features/session-limits.md)
- [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview)
- [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview)

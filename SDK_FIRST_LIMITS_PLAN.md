# Native SDK resource semantics

The native hard cutover supersedes the custom-only limits design.

- SDK owns native execution and delegated work. Harness limits must be connected
  to supported SDK admission/lifecycle interfaces, not merely enforced around
  retained custom tools.
- Model requests, workers and tool/command execution have distinct concurrency
  concerns. A parallel-tool provider hint is not an execution semaphore.
- Token/currency budgets are optional. Reject a requested hard cap if the selected
  provider/integration cannot enforce it; never relabel retrospective reporting
  as admission control.
- Aggregate parent and worker usage once. Transport and SDK events may observe
  the same request; they are not independently billable requests.
- Model-specific BYOK rates apply only to that model. Copilot allowances and
  unknown external tool charges must not be converted into invented prices.
- A request budget covers intercepted model requests and explicitly priced
  retained domain calls. It does not cap total account/machine spending from
  arbitrary native commands or external MCP services. Display tracked cost as
  such, never as a complete external-spending total.
- Unknown consumption remains unknown. With a configured enforceable budget,
  unresolved usage requires reconciliation before further admission.
- Time/output controls and bounded durable results still matter even when there
  is no spending cap. Cancellation is not rollback.

See [the native plan](NATIVE_SDK_MIGRATION_PLAN.md) and
[the guide](docs/GUIDE.md) for current scope and operational behavior.

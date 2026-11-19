# Native product view

The harness is a local Windows Terminal/PowerShell host for Copilot SDK-native
tools and subagents. Trust a session explicitly, select Copilot or BYOK, then work
with native shell/coding tools, workspace specialists and configured extensions.

Trusted sessions default to allow-all permissions and interactive task
progression. Manual/assisted permissions and plan/autopilot progression remain
independently selectable. Organizational policy still applies.

The UI/headless API shows objective state, worker attribution, native tool output,
provider/model usage and pending decisions. Recovery preserves uncertainty rather
than blindly replaying side effects. Optional Docker execution retains separate
mirror/publication behavior; native commands are unsandboxed.

Only native configuration/storage is supported. Historical data is not converted
or deleted. There is no custom-only alternative mode or compatibility viewer.

See [the guide](GUIDE.md), [product contract](../PRODUCT.md) and
[native cutover plan](../NATIVE_SDK_MIGRATION_PLAN.md).

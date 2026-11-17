# DEFERRED_TASKS — the builder kit

> Maintainer-only; not shipped. One row per piece of work the kit knowingly does not do yet. The accounts plan
> (https://claude.ai/artifact/FLZ6L6YJqhq8Jd3uV3pvdJ, "Deferred tasks") is the source of the first rows.

| Id | Task | Why deferred | Comes back when |
|---|---|---|---|
| KIT-D1 | A remote-lane daemon, relay, pairing flow, live terminal or phone approvals | D58: breaks zero dependencies and the file-state design | Never in this kit |
| KIT-D2 | Automatic placement of lanes over machines | D58: no demand evidence; one machine per lane, placed by hand | After EXPERIMENTS §18 has two measured runs |
| KIT-D3 | Features for regulated or client-facing shops | D54: not a 2.0.0 target | When one client asks |
| KIT-D4 | Transcript checkpoints in a ref namespace | A public repository would publish prompts | After REQ-915 trailers exist and a project asks |
| KIT-D5 | Antigravity as a headless account | No API-key auth; soft-denied tools exit 0 | After M11, after a tool-calling smoke test |
| KIT-D6 | Keychain key store (`--store keychain`) | D42: locked or absent over SSH and in headless runs | A project asks; the helper seam exists |
| KIT-D7 | Reading an API key's credit balance | No CLI exposes it | A provider prints it, or a project supplies a `balanceCommand` |
| KIT-D8 | Reading Claude subscription usage from the CLI | No headless surface prints a percentage | A documented usage command exists |
| KIT-D9 | Per-account cost on the live page and in cost-window | costAccounting reads Claude Code transcripts only | A second transcript reader exists |
| KIT-D10 | Account-level concurrency cap | Lane count is capacity-measured per batch | After M3 has run on two real batches |
| KIT-D11 | An alias layer that keeps 1.0 `seats` profiles loading | Dropped by Q1 (a) | Only if a project cannot migrate |
| KIT-D12 | Gateway machine provisioning | D21 | Never in this kit |
| KIT-D13 | Desktop-app registration of the free-model MCP server | Rule 10: the kit prints the block | Only if the rule changes |

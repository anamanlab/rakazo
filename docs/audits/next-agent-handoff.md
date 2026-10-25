# Next-agent handoff log

**Updated:** 2026-10-25
**Workstream:** Rakazo production audit, recovery plan, and fork finalization.

## Changelog

- Added [`rakazo-production-audit.md`](rakazo-production-audit.md): read-only source, deployment, provider, database, security, upstream, capability, and cost findings, with a CEO summary.
- Added [`rakazo-stabilization-plan.md`](../plans/rakazo-stabilization-plan.md): P0–P3 small-PR sequence, dependencies, likely modules, risks, rollback, tests, and release-blocking criteria.
- Added [`rakazo-release-checklist.md`](../plans/rakazo-release-checklist.md): environment checks, reproducible smoke-test matrix, backup/restore, deployment, rollback, and go/no-go gates.
- No application behavior, production configuration, billing, schema, or deployment was changed. No tests were run for the audit. The new documents were whitespace-checked and scanned for private hostnames and secret-like values.

## Current verified state

- Fork snapshot: `main` at `4dda60d28b5b48bd2f754922ff02088c6bc688dd`. Current upstream snapshot used in the audit: `b89c3e7123481d81b07fbca978c64f3639b7d61e`. Divergence at audit time: 13 commits ahead, 213 behind. No open fork PRs were found.
- CI on the audited HEAD passed the main code/test jobs, but edge and production deploy jobs were skipped. The live Worker version could not be tied to a source SHA; API and worker image revisions remain unknown.
- The audited source already has the Workers AI quota retry fix (`79c32a7`), but deployment of that fix is unverified. Model-plan eligibility, the Gateway 402 route, independent fallback health, and Groq 413 handling still need focused fixes and evidence.
- The API has database-aware `/ready`, but the edge and web origin do not route it; public `/ready` and `/internal/health` returned the SPA shell with HTTP 200. Worker readiness is not checked in managed Compose.
- Managed Neon is on Free with a fixed 0.25 CU compute. Graphile Worker uses a persistent listener and frequent polling, which may prevent autosuspend; measure actual active CU-hours before concluding. Existing backup scripts target local Postgres, and no Neon restore drill was verified.
- Managed Compose defaults `SANDBOX_PROVIDER=none`; browser/terminal/login functionality must be considered unavailable unless the live override and security boundary are proven.
- Current source contains bot, delegation, memory, skills, integration, scheduled job, approval, and task-history code. Production end-to-end behavior for these business-team workflows is unverified.
- Dependency review found a critical DOMPurify advisory and high-risk MCP/SSRF items. See the audit for package versions, upstream commits, and acceptance evidence.

## Next actions if the user authorizes implementation

1. Start with P0.1–P0.4: revision/readiness proof, dependency/security backports, SSRF and credential scoping, then provider quota/eligibility/fallback behavior.
2. Implement P0.5 provider budgets and Groq 413 handling; keep tool/run limits finite and make errors visible.
3. Establish Neon-specific encrypted backup and isolated restore before expanding scheduled or external side effects.
4. Stabilize worker health and job recovery, then validate auth/RLS, approvals, integrations, and one business-team canary.
5. Enable browser/computer only if its provider and isolation are explicitly selected and pass the P2 gate.
6. Use the release checklist for staging, controlled rollout, monitoring, and rollback proof.

Request only redacted operational metadata when needed: source SHAs and image digests, provider/model names and billing route, Neon endpoint mode and active-CU history, auth/signup policy, sandbox provider state, and restore-drill result. Never request or print secrets, database URLs, production prompts, user records, private hostnames, or raw logs.

## Authorization boundary

The active assignment authorizes a **read-only audit and these documentation deliverables only**. Stop before application changes, production configuration changes, billing changes, schema changes, deployments, or merges until the user explicitly approves implementation. Continue to follow the repository `AGENTS.md` rules; in particular, all tracked content is public and must not contain real credentials, customer data, private URLs, or production identifiers.

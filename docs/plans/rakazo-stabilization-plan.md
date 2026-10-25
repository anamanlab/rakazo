# Rakazo stabilization plan

**Status:** proposed; this audit did not implement application or infrastructure changes.
**Basis:** [production audit](../audits/rakazo-production-audit.md), fork commit `4dda60d28b5b48bd2f754922ff02088c6bc688dd`, upstream snapshot `b89c3e7123481d81b07fbca978c64f3639b7d61e`.

The work is ordered as small, reviewable PRs. Each PR should name the production problem, contain deterministic offline tests, keep migrations compatible with the previous release, and record the evidence required before rollout. No production configuration, billing, or deployment changes are included in this plan; those require a separate approved release action.

## Release objective

Ship a reliable minimum product for persistent assistants: authenticated chat, saved specialist bots, bounded coordinator delegation, task history/memory, one working read-only connection, one approved external write, and a scheduled canary. Do not make browser automation a launch requirement; keep it unavailable until its provider and security boundary pass the P2 gate.

## Sequence and dependencies

| Order | Phase | PR | Outcome | Dependency | Complexity |
|---:|---|---|---|---|---|
| 1 | P0 | P0.1 Runtime provenance and readiness | Every release identifies edge/API/worker revisions; health gates measure readiness. | None | M |
| 2 | P0 | P0.2 Dependency security updates | Remove critical DOMPurify and high MCP dependency findings from shipped graph. | None | S–M |
| 3 | P0 | P0.3 SSRF and credential boundary | Prevent unsafe address forms and cross-site browser credential use. | None; required before remote MCP/browser use | M |
| 4 | P0 | P0.4 Provider quota, eligibility, and billing errors | Stop repeated quota attempts; make 403/402 outcomes actionable; prove the backup route. | P0.1 revision parity for production verification | M |
| 5 | P0 | P0.5 Provider budgets and Groq 413 | Bound context and output by provider request limits, with one controlled shrink retry. | P0.4 error taxonomy | M |
| 6 | P0 | P0.6 Neon backup and restore | Recover business data independently of the short instant-restore window. | Operator storage/retention choice | M |
| 7 | P0 | P0.7 Runtime budgets and secret-safe telemetry | Bound tool loops and produce useful, payload-safe operational signals. | P0.4; monitoring destination selected | M |
| 8 | P1 | P1.1 Worker and scheduled-job recovery | Prove job liveness, retries, reconciliation, and schedule execution. | P0.1 and P0.6 | M |
| 9 | P1 | P1.2 Auth, tenant isolation, memory, and approvals | Prove user/Space boundaries and protected external side effects. | P0.2/P0.3, P0.7 | L |
| 10 | P1 | P1.3 Integration and team canary | Verify coordinator, Marketing/Sales/Operations specialists, and one real workflow. | P1.1/P1.2; named test integration | M |
| 11 | P2 | P2.1 Browser/computer capability | Enable one isolated sandbox and authenticated browser only if business need and provider are approved. | P0.3, P0.7, provider/sandbox owner decision | L |
| 12 | P2 | P2.2 Reusable team workflows | Package the proven canary as a versioned team/skill with safe defaults. | P1.3; P2.1 only for browser workflows | M |
| 13 | P3 | P3.1 Staging regression and controlled release | Prove all release gates, recovery, cost bounds, rollback, and operator handoff. | P0–P2 scope accepted | M |

S = small, M = medium, L = large. Complexity reflects integration and acceptance burden, not elapsed calendar time.

## P0 — Restore reliability

### P0.1 — Runtime provenance and readiness

- **Issue and evidence:** Production edge deployment and production origin deploy jobs were skipped; the live Worker has no source SHA and API/worker image revisions are unknown. The API implements database-aware `/ready`, but edge and Vite route only `/health`; live `/ready` and `/internal/health` returned the SPA shell with HTTP 200. Managed Compose does not health-check the worker.
- **Root cause and impact:** Deploy artifacts are not tied to an immutable release identity, and the public edge never routes the API’s readiness check. Operators can mistake a static HTML response or constant liveness response for a ready API/worker. Severity: **High / release blocker**.
- **Likely files/modules:** `apps/web-edge/src/index.ts`, `apps/web-edge/cloudflare.config.ts`, `apps/web/vite.config.ts`, `apps/api/src/health.ts`, `apps/api/src/health.test.ts`, `infra/compose/docker-compose.managed.yml`, `.github/workflows/*deploy*` and image build workflow.
- **Proposed solution:** Give the trusted deploy runner a private API readiness path that reaches the API rather than the SPA fallback. Keep `/internal/health` private and do not expose database/worker details through the public Worker. Public health paths must either return a deliberately safe status or an explicit non-success response, never SPA HTML. Add API/worker readiness signals without exposing secrets or topology. Inject the source SHA into the immutable Worker version and origin image; record image digest and release SHA. Gate deploy on API `/ready`, worker job loop/heartbeat, DB connection, and edge route smoke checks. Make health-check failure visible to the orchestrator.
- **Alternative:** Keep readiness private and have the deploy controller probe API/container directly, while still reporting the verified revision in release metadata. Do not publish internal details to public clients.
- **Dependencies and complexity:** None; requires choosing a safe operator-only status surface. **M**.
- **Risks and rollback:** A new readiness gate may block rollout if checks are too strict or the DB is waking from autosuspend. Use bounded timeouts and distinguish temporary warm-up from failure. Roll back the routing/health-check change if it falsely removes healthy instances; source SHA must remain in deployment metadata. No schema changes.
- **Tests and acceptance:** Extend `apps/api/src/health.test.ts`; add offline Worker/Vite route tests for private readiness, static paths, public health behavior, `/internal/health` privacy, and errors. Acceptance: healthy API/DB returns readiness JSON through the trusted operator path; DB/API failure returns non-200; public HTML fallback never passes a readiness check; worker readiness becomes false when the worker stops claiming/heartbeating. Every deploy artifact has a verifiable SHA/digest matching the approved source.
- **Blocks release:** **Yes.**

### P0.2 — Patch vulnerable production dependencies

- **Issue and evidence:** `pnpm audit --prod` reports a critical DOMPurify advisory (lockfile resolves `3.4.13`; upstream fixes at `3.4.17`) and high advisories including remote MCP SDK `1.30.0` (fixed line `>=1.31.0`).
- **Root cause and impact:** The dependency lockfile includes vulnerable release lines used by the production graph. Remote MCP and rendered/sanitized content expose attacker-controlled inputs. Severity: **Critical/High / release blocker**, subject to reachability review.
- **Likely files/modules:** root `package.json`, `pnpm-lock.yaml`, `packages/adapters/package.json`, transitive package policy/overrides if needed; relevant UI sanitizer and `packages/adapters/src/remote-mcp.ts` call paths.
- **Proposed solution:** Upgrade direct dependencies to fixed compatible releases; pin the transitive DOMPurify fix through the existing package-manager override mechanism if needed. Re-run the dependency audit and inspect production bundles. Patch any additional reachable critical/high direct dependency separately rather than bulk-updating the entire tree.
- **Alternative:** If a major dependency update is incompatible, isolate the affected feature behind a disabled gate while a compatible patch is prepared. Do not silently suppress advisories.
- **Dependencies and complexity:** None. **S–M**.
- **Risks and rollback:** API/SDK behavior can change on dependency update. Roll forward with a narrow compatibility fix; a rollback to vulnerable versions is only an emergency with the affected feature disabled and documented owner approval.
- **Tests and acceptance:** Lockfile integrity, existing sanitizer/MCP transport tests, deterministic malformed-content and remote MCP conformance tests. Acceptance: no known critical or reachable high advisory in the shipped production graph; exact affected packages and any non-reachable exceptions recorded in the private review record.
- **Blocks release:** **Yes.**

### P0.3 — Close SSRF and browser credential scope gaps

- **Issue and evidence:** `packages/adapters/src/network-address.ts` lacks normalization/protection for some link-local, metadata, and IPv4-mapped IPv6 forms. Upstream `bb08548b` covers these classes. Upstream `822b8797` scopes browser credential requests to the site of the page rather than allowing a broader target.
- **Root cause and impact:** URL policy and credential site checks do not normalize all equivalent address/site forms before authorization. Remote fetch, MCP, and future browser actions could reach internal services or disclose credentials across sites. Severity: **Critical / launch blocker for user-controlled fetch/MCP/browser egress**.
- **Likely files/modules:** `packages/adapters/src/network-address.ts`, `network-address.test.ts`, `remote-mcp.ts`, browser credential/page login modules (`browser-tools.ts`, `page-browser-session.ts`, and related tests), plus shared URL policy utilities.
- **Proposed solution:** Backport the upstream address normalization and site-scoping behavior with a single shared validation path. Re-resolve and validate at connection time to reduce DNS rebinding risk. Keep private-address exceptions opt-in and restricted to deployment-owner-controlled connections.
- **Alternative:** Disable user-supplied remote MCP endpoints and browser credential handoff until the complete policy is tested. This is the safe temporary default.
- **Dependencies and complexity:** Needed before P2 browser enablement and any user-configurable remote MCP endpoint. **M**.
- **Risks and rollback:** Strict normalization may block legitimate private development endpoints. Keep explicit deployment-owner-only exceptions with audit events. Roll back feature enablement, not the protection; no database migration expected.
- **Tests and acceptance:** Offline cases for IPv4, IPv6, mapped IPv4, loopback, link-local, metadata IPs, DNS changes/rebinding, redirects, internationalized hostnames, and same-site credential scope. Acceptance: forbidden destinations are rejected before connection; credentials are sent only to the approved page origin; tests require no live network.
- **Blocks release:** **Yes** for remote URL/MCP or browser credential capability; otherwise those capabilities must remain disabled.

### P0.4 — Make quota, eligibility, and billing failures bounded and actionable

- **Issue and evidence:** The fork includes commit `79c32a7`, which disables nested Cloudflare SDK retries and marks exhausted daily quota non-transient. Existing `pi-runtime-fallback.test.ts` covers the behavior. Historical failures predate that fix, but the deployed API SHA is unknown. Model-plan 403 is not a general failover category. A historical AI Gateway 402 was logged for OpenAI; zero Unified Billing balance was reported, but the current Gateway metadata is postpaid and does not prove that historical billing route.
- **Root cause and impact:** Provider errors are not classified with enough provider-specific detail, and configured backup does not prove independent credentials, eligibility, quota, or billing. Retrying a depleted quota wastes time and may add cost; silent fallback can disguise a broken connection. Severity: **High / release blocker**.
- **Likely files/modules:** `packages/adapters/src/cloudflare-ai-gateway.ts`, `packages/adapter-kit/src/model-errors.ts`, `packages/adapters/src/pi-runtime.ts`, `packages/adapters/src/pi-runtime-fallback.test.ts`, `packages/adapters/src/cloudflare-ai-gateway.test.ts`, provider connection validation and model catalog modules.
- **Proposed solution:** First prove the deployed API includes `79c32a7`. Classify Cloudflare quota using status plus structured provider message/known internal codes (historical `4006`, current docs `3036`) rather than one brittle code. Treat quota and billing failures as terminal for that route; add a narrow typed model-entitlement error for Cloudflare `5035`; keep credential/policy 403 terminal. Add provider/model eligibility checks where metadata exists. Require an explicit independent backup connection; show the actual provider/model and actionable cause in the run result. Trace the Gateway request path before changing billing configuration.
- **Alternative:** Configure one provider only and present quota/billing failures directly until a separate backup is proven. This is preferable to a nominal backup that shares the exhausted account or unpaid route.
- **Dependencies and complexity:** P0.1 for production revision proof; P0.7 for durable metrics. **M**.
- **Risks and rollback:** Overbroad 403 failover can mask bad credentials or policy denials; narrowly classify only known plan eligibility errors. Do not alter billing. Roll back a new classifier while preserving the existing quota no-retry change; fallback remains disabled if unsafe.
- **Tests and acceptance:** Simulate daily quota (both known error signatures), transient capacity, ineligible model, invalid credential, provider 402, and independent backup outcomes. Assert one primary attempt on non-retryable errors, no same-model retry, exactly one qualified backup attempt, and a failed—not successful—run if no route works. Acceptance includes an application-level failure with user-actionable text and a sanitized usage/error event.
- **Blocks release:** **Yes.**

### P0.5 — Bound provider context and handle Groq 413 once

- **Issue and evidence:** Current context budgeting uses serialized bytes plus framing rather than each provider’s token accounting. Generic 413 is not reduced/retried. Upstream `7fb9beef` adds Groq request-window budgeting, output reservation, and one bounded context shrink while retaining tool history; `fcc86da6` improves token-budget estimates; `0dead70e` normalizes chat-completions request/tool formats.
- **Root cause and impact:** Generic estimates and request shape do not account for provider-specific TPM/request limits or tool schema compatibility. Large histories, skills, and schemas can cause 413s or unusable fallback requests. Severity: **High / core chat reliability**.
- **Likely files/modules:** `packages/adapters/src/context-selection.ts`, `context-selection.test.ts`, `packages/adapters/src/pi-runtime-limits.ts`, `pi-runtime.ts`, provider request normalization/compatibility modules, `pi-runtime-fallback.test.ts`.
- **Proposed solution:** Adapt the upstream provider budget logic behind current shared model capabilities. Reserve output/reasoning tokens, count schemas and current tool results, use the provider window where known, and apply at most one bounded context shrink for Groq 413/TPM responses. Preserve tool-call/result pairs and annotate what context was truncated. Keep unknown limits conservative and return a clear error when a safe request cannot fit.
- **Alternative:** Disable Groq as an eligible connection and use a qualified provider with explicit context metadata until the implementation is tested.
- **Dependencies and complexity:** P0.4 error classification. **M**.
- **Risks and rollback:** Incorrect token estimates can either truncate useful evidence or still exceed the provider limit. A feature flag/provider capability can disable auto-shrink while preserving clear errors. Avoid speculative tokenizer dependencies unless provider contracts require them.
- **Tests and acceptance:** Deterministic near-limit tests for user history, system/developer messages, tool definitions/results, output reservation, multi-step tool history, provider 413, and second 413. Acceptance: the request remains within the declared budget with at most one shrink retry; tool-call structure remains valid; a repeated failure is surfaced with no loop.
- **Blocks release:** **Yes** if Groq is a supported production primary/backup; otherwise mark Groq unsupported until passed.

### P0.6 — Establish Neon backup and restore

- **Issue and evidence:** Existing backup scripts and timer target local Postgres Compose, not the managed Neon topology. Neon Free instant restore is only a six-hour window; no Neon-specific encrypted backup or restore drill was evidenced.
- **Root cause and impact:** The deployed managed database does not have a verified independent recovery path and tested RPO/RTO. Loss/corruption could lose long-running agent records and customer data. Severity: **Critical / release blocker**.
- **Likely files/modules:** `infra/compose/backup-prod.sh`, `infra/compose/backup-drill.sh`, `scripts/backup.sh`, `scripts/restore.sh`, `infra/systemd/*backup*`, `docs/deployment/cloudflare-neon.md`, and a new managed-Neon backup runbook/script only if the existing tools cannot be safely parameterized.
- **Proposed solution:** Add a managed-Neon logical dump path using least-privilege credentials, encrypted before transfer to a separate storage target, with retention, checksum, failure alert, and restore to an isolated Neon branch/project. Preserve local Postgres backup support. Record RPO/RTO targets and test them. Do not commit credentials.
- **Alternative:** Use a Neon plan with longer recovery retention plus scheduled logical exports operated by an existing approved backup service. Choose based on restore time and data loss objectives; provider PITR alone is not the long-retention backup.
- **Dependencies and complexity:** Operator selects approved storage, encryption recipient, retention, and RPO/RTO. **M**.
- **Risks and rollback:** A backup dump can expose business data or saturate the DB. Restrict permissions, encrypt, schedule off-peak, monitor size/duration, and prevent restore writes to production. Roll back the backup job if it causes load; keep provider PITR enabled and re-run after correcting. No schema changes.
- **Tests and acceptance:** Offline script tests, sanitized backup artifact checks, isolated restore test, row-count/schema consistency assertions without real customer data in logs, and a timed recovery drill. Acceptance: a separately retained encrypted dump restores to isolation, keys can be recovered by an authorized operator, alerting fires on failed backup, and documented RPO/RTO are met.
- **Blocks release:** **Yes.**

### P0.7 — Bound runs and make observability safe/useful

- **Issue and evidence:** `MAX_TOOL_CALLS_PER_TURN` is unset by default in managed Compose; there is no identified hard per-run/provider/team spend budget. Cloudflare AI Gateway logging is enabled, and official docs say logs can contain prompts and responses. Error sink and alert routing were not verified.
- **Root cause and impact:** A persistent agent can loop through tools without a finite operational cap, while traces/logging may retain sensitive prompt material or fail to alert operators. Severity: **High / cost and privacy blocker**.
- **Likely files/modules:** `packages/adapters/src/pi-runtime.ts`, `pi-runtime-limits.ts`, usage accounting and run status modules, `infra/compose/docker-compose.managed.yml`, provider adapters, logging/telemetry package, `docs/ai-data-sharing-review.md`.
- **Proposed solution:** Set a conservative finite tool-call cap through generic runtime configuration, enforce a server-side per-run ceiling even if environment is missing, and emit an explicit interrupted/budget-exhausted state. Add or verify per-user/Space cost limits using existing usage records. Disable raw AI Gateway payload capture (`cf-aig-collect-log-payload: false` or gateway default off); retain minimal metadata and redact credentials. Wire one existing error sink and alert on failed jobs, provider errors, backup failures, and readiness loss.
- **Alternative:** Keep AI Gateway logging disabled and rely on provider-neutral internal metadata while sinks are chosen; do not store prompt/response bodies merely to gain observability.
- **Dependencies and complexity:** Provider error schema from P0.4; monitoring destination selected by owner. **M**.
- **Risks and rollback:** A too-low cap may interrupt legitimate long workflows; initial limits should be adjustable per generic capability and reviewed from staging. Telemetry can expose secrets if request bodies are captured. Roll back only the threshold with an audit trail; never roll back to raw payload collection without an explicit privacy review.
- **Tests and acceptance:** Deterministic loop-ceiling, cancellation, budget-exhaustion, secret-redaction, and provider-error event tests. Acceptance: no unset configuration means unlimited calls; the run ends in a visible bounded state, sanitized alert reaches the chosen sink, and no prompt/credential payload is present in Gateway logs.
- **Blocks release:** **Yes** for unrestricted multi-step agents; at minimum a hard server-side cap is mandatory.

## P1 — Stabilize core operations

### P1.1 — Prove Graphile worker health, retry, and schedule recovery

- **Issue and evidence:** API/worker are separate origin services. The worker has no Compose healthcheck. Graphile uses a long-lived LISTEN connection, a 500 ms default poll interval, and reconciliation logic. Production worker revision and scheduled execution are unverified; persistent DB activity may prevent Neon autosuspend.
- **Root cause and impact:** A live API can accept work while the queue worker is stopped or stale; retries/recovery and DB activity are not visible at release level. Severity: **High / scheduled work blocker**.
- **Likely files/modules:** `apps/worker/src/index.ts`, `packages/adapters/src/wakeup.ts`, `packages/adapters/src/job-reconciler.ts`, corresponding tests, `infra/compose/docker-compose.managed.yml`, `apps/api/src/routine-runs.ts`.
- **Proposed solution:** Add worker liveness/heartbeat and bounded queue-age metrics; health-check worker availability, not just process existence. Test API enqueue → worker claim → side effect/result → recovery after process restart. Measure Neon CU-hours/connection activity for at least one representative week; adjust polling only if queues remain timely and lock/notification correctness is preserved.
- **Alternative:** Keep persistent Graphile polling for correctness and budget the Neon compute as always active if measured CU-hours show it is more reliable and still economical.
- **Dependencies and complexity:** P0.1 readiness; P0.6 backup before job load. **M**.
- **Risks and rollback:** Aggressive polling reduction can delay jobs; tighter health checks can restart a worker during DB wake-up. Roll back poll tuning independently; keep reconciliation and dedupe guarantees. No schema change unless an additive heartbeat is necessary.
- **Tests and acceptance:** Existing worker/Graphile/reconciler tests plus deterministic restart, duplicate enqueue, stale lease, and scheduled canary tests. Acceptance: a schedule fires once, failed work retries within policy, a worker restart recovers queued work, duplicates are idempotent, and queue age/last success are observable.
- **Blocks release:** **Yes** if scheduled routines are in release scope.

### P1.2 — Prove authentication, RLS tenant isolation, memory boundaries, and approvals

- **Issue and evidence:** Runtime DB role is not superuser and has RLS bypass disabled, but only some tables have RLS; production signup/account recovery settings and live tenant-isolation/user flows were not tested. Approval and audit code exists, but parallel approvals and continuation were not verified. Upstream `85c16047` fixes continuation of approved calls when parallel calls require approval.
- **Root cause and impact:** Role configuration alone cannot prove tenant/Space isolation through API and worker paths; lost approval continuation or missing action checks could leak records or perform unapproved writes. Severity: **Critical / launch blocker for multi-user or external writes**.
- **Likely files/modules:** `packages/db/src/row-security.ts`, `row-security.postgres.test.ts`, RLS migrations under `packages/db/prisma/migrations`, API auth/RPC guards, `packages/adapters/src/approval-ask.ts`, `approval-effect.ts`, executor approval tests, memory providers and API test fixtures.
- **Proposed solution:** Inventory tenant-scoped tables and access paths; add RLS/policy or explicit app authorization where required. Use the migration owner only for migrations; preserve side-by-side previous-release policies. Backport approval continuation. Verify registration, recovery, session expiry, Space membership, background jobs, child bots, memory retrieval, and external write approvals. Do not enable “run without asking” globally.
- **Alternative:** Keep launch single-tenant and restrict account creation to named users until full multi-tenant evidence passes; still require approval for external writes.
- **Dependencies and complexity:** P0.2/0.3 security; P0.7 events. **L**.
- **Risks and rollback:** Policy changes may block legitimate old API queries. Use additive compatibility migrations, staging with previous API version, and roll forward rather than dropping policies. Feature-disable affected external actions if approval state is uncertain.
- **Tests and acceptance:** Postgres integration tests with separate users/Spaces, parent/child bots, worker jobs, and RLS-on/off paths; approval continuation for mixed parallel actions; auth recovery/session tests. Acceptance: cross-tenant reads/writes fail, owner/operator paths are explicit, no external write occurs without a valid approval, and denial/revocation is recorded.
- **Blocks release:** **Yes** for public multi-user use and all external writes.

### P1.3 — Run one representative business-team canary

- **Issue and evidence:** The code supports bot CRUD, child bots, memory, skills, integrations, schedules, approvals, and history, but no production end-to-end workflow or active connection/scopes were verified. No one-click business team template was evidenced.
- **Root cause and impact:** Capability breadth has outpaced proof that a user can complete a useful task from setup to outcome. Severity: **High / product readiness**.
- **Likely files/modules:** Existing bot/Space APIs and team-chat runtime, memory provider factory, skills and routines modules, `packages/adapters/src/child-bots.ts`, integration adapters, task-history UI, tests in related packages. Prefer existing reusable package contracts; do not place orchestration in frontend code.
- **Proposed solution:** In staging, create Coordinator, Marketing, Sales, and Operations bots with minimal scoped permissions. Test research and qualification through read-only tools first. Add one approved CRM/calendar write only after P1.2. Record output, source links, approval, task status, retry and final outcome. Use deterministic code for scheduling and record updates; use LLMs for judgment/research.
- **Alternative:** Ship chat and saved bots first, defer team delegation until the coordinator can reliably return partial failure and recover child work.
- **Dependencies and complexity:** P1.1 and P1.2; an approved test integration account and owner-approved test data. **M**.
- **Risks and rollback:** A partially configured real integration could write to customer systems. Use staging/sandbox credentials, allowlisted records, least scopes, and approval on every write. Disable the integration/skill without affecting chat if the canary fails.
- **Tests and acceptance:** Offline delegation contract tests plus staging human-run acceptance. Acceptance: coordinator delegates to at least two specialists, aggregates evidence with provenance, reports partial failure honestly, persists history/memory within Space boundaries, performs no external write before approval, and the approved test write is idempotent.
- **Blocks release:** **Yes** for the advertised AI-team scope; chat-only release may defer it explicitly.

## P2 — Complete essential agent capabilities

### P2.1 — Enable one sandbox and authenticated browser path, if selected

- **Issue and evidence:** Managed Compose defaults `SANDBOX_PROVIDER=none`; production provider, egress rules, persistent browser session, credential handoff and MFA behavior are unverified. Browser/computer code and `/novnc` proxy exist but do not prove operation.
- **Root cause and impact:** Computer support is an optional provider-backed capability, not automatically provided by Cloudflare. Enabling it without boundary controls could expose credentials or origin services. Severity: **High / launch blocker for any browser/terminal claim**.
- **Likely files/modules:** `packages/adapters/src/browser-provider-factory.ts`, `computer-browser.ts`, `browser-tools.ts`, `page-browser-session.ts`, sandbox provider adapters and conformance tests, `infra/compose/docker-compose.managed.yml`, computer/sandbox supervisor configuration, `docs/deployment/cloudflare-neon.md`.
- **Proposed solution:** Choose one supported provider and test a disposable browser first. Require per-user/Space sandbox ownership, isolated storage, outbound host policy, command restrictions, resource/time limits, session expiry, encrypted credential handoff, MFA user handoff, action approvals, and cleanup. If provider credentials/config are missing, keep `none` and present a clear unavailable capability state.
- **Alternative:** Keep browser/computer out of minimum release; offer connected-app APIs for controlled workflows.
- **Dependencies and complexity:** P0.3, P0.7, vendor/provider and owner security decision. **L**.
- **Risks and rollback:** Sandbox escape, SSRF, persistent login compromise, and account lockout. Roll back by disabling provider capability and revoking sessions/credentials; do not fall back to host-shell execution.
- **Tests and acceptance:** Offline sandbox contract tests plus isolated staging login test covering session persistence, MFA handoff, secret redaction, forbidden egress, approval before write, cancellation, cleanup, and credential revocation. Acceptance: no host/root access, no cross-user browser state, and a failed action reports uncertain side effects accurately.
- **Blocks release:** Only if browser/computer is included in public release scope.

### P2.2 — Turn the proven canary into reusable skills/team defaults

- **Issue and evidence:** Skills and teach-recording code exist, but no reviewed business-team package or safe demonstrated workflow was verified.
- **Root cause and impact:** Teams need repeatable handoffs and playbooks; unreviewed demonstration capture can encode unsafe steps or inaccurate assumptions. Severity: **Medium / differentiation, not core reliability**.
- **Likely files/modules:** Shared skill/workflow contracts and adapters, bot/team setup API, existing skill persistence/runtime, permission and approval policy modules, web/mobile UI only where configuration must be exposed.
- **Proposed solution:** Version the P1.3 coordinator, Marketing, Sales, and Operations prompts/skills as reusable artifacts with explicit inputs, deterministic steps, tool permissions, source requirements, escalation conditions, and approval boundaries. Capture teach-by-demonstration only after redaction and owner review. Keep team templates progressively disclosed in the UI.
- **Alternative:** Document manual bot setup and defer productized team templates until usage feedback establishes the exact workflow.
- **Dependencies and complexity:** P1.3; P2.1 only if browser steps are included. **M**.
- **Risks and rollback:** A stale skill can produce repeated business errors. Version artifacts, allow rollback to prior skill version, and require review before promotion.
- **Tests and acceptance:** Contract tests for required inputs, tool allowlists, structured output and approvals; versioned human-reviewed rubric for free-form quality. Acceptance: team can be instantiated from the reusable package, has no implicit external-write permission, and skill changes are traceable and reversible.
- **Blocks release:** No, unless templates are the launch promise.

## P3 — Release readiness

### P3.1 — Stage, observe, restore, and release with a controlled rollout

- **Issue and evidence:** No proof currently binds live code to a release, the current edge deploy gate is disabled, error sink and alerts are unverified, and no Neon restore drill is documented.
- **Root cause and impact:** Operational acceptance is not an explicit release gate. A code-green pipeline could still deploy mismatched services or leave a broken API/worker unnoticed. Severity: **Critical / release blocker**.
- **Likely files/modules:** `.github/workflows/*`, deployment metadata/build workflow, `docs/deployment/cloudflare-neon.md`, this release checklist, `docs/operations/*` (if an ops runbook is added), API/worker readiness and structured logging modules.
- **Proposed solution:** Add a staging environment gate with migration compatibility, full smoke/conformance run, backup restore proof, fault injection, alert test, cost budget check, and user-visible error review. Deploy the same immutable artifact to production, confirm edge/API/worker SHAs, canary one controlled team, observe queue/provider/readiness metrics, and then expand. Define rollback per component; use forward-compatible database changes.
- **Alternative:** Release only chat/bot configuration as a limited single-tenant preview, with schedules/integrations/browser disabled and explicit operator support, if a narrower safe scope is valuable.
- **Dependencies and complexity:** All release-scoped P0/P1 tasks; P2 only when included in marketing/release claim. **M**.
- **Risks and rollback:** Edge/API/worker skew and forward-only migrations can complicate rollback. Keep previous immutable artifacts available, stop new work before rollback if schema compatibility is uncertain, and roll forward with a compatible fix. Restore DB only under the documented recovery decision and approval.
- **Tests and acceptance:** Run the CI suite on the release candidate and the checklist smoke matrix in staging; verify alerting, backup/restore, and rollback in a controlled drill. Acceptance: every release gate is green with captured redacted evidence, no pending migration incompatibility, and the canary completes without unhandled provider or job errors.
- **Blocks release:** **Yes.**

## Regression and acceptance matrix

All tests should be deterministic/offline by default. Provider live tests belong only in an explicitly budgeted staging qualification run using test credentials and no sensitive prompts. Tests do not replace human approval for external effects.

| Area | Required proof |
|---|---|
| Ordinary chat and context | Round trip, multi-turn, context near limit, output reservation and meaningful truncation. |
| Provider behavior | Tool schema compatibility, reasoning/tool call, timeout, cancellation, transient failure, quota exhaustion, ineligible model, billing failure, Groq 413, independent fallback. |
| Delegation | Coordinator to specialists, hop cap, partial failure, cancellation, result aggregation and non-duplicated child effects. |
| Interrupted effects | Kill client/worker after dispatch; task status says pending/uncertain; retry is idempotent or requires human resolution. |
| Database/auth | Previous-release migration compatibility, RLS for two users/Spaces, application vs migration role, auth recovery/session expiration. |
| Background work | Scheduled canary, queue restart, failed job retry, stuck job reconciliation, dedupe and observable queue age. |
| Integrations | Least-scope read, approval-gated write, denied action, OAuth refresh rotation, secret redaction and revocation. |
| Browser/sandbox | Only if enabled: isolation, forbidden egress, login/MFA handoff, credential scope, expiry, cancellation and cleanup. |
| Operations | Revision parity, `/ready` dependency failure, worker down, alert delivery, encrypted Neon restore, rollback and usage budget. |

## Implementation and release discipline

- Use one PR per task above; split dependency/security changes further if review surface grows.
- Each PR states the product failure, implementation, deterministic tests, deployment/rollback impact, and any necessary user-facing copy. Keep user-facing copy minimal and reveal technical detail only when a failure occurs.
- Do not combine upstream changes with unrelated UI or architecture work. Record upstream commit SHA and adaptation reason for each backport.
- Do not change billing or production provider settings as a code fix. Prepare the proposed setting change and cost/test evidence for explicit owner approval.
- Do not add a migration unless required. Migrations must be additive and work with both current and previous API revisions during rollout.
- Keep new providers behind the shared connection/model capability contract; no provider-specific environment variable if shared connection settings can represent it.
- Use the existing Cloudflare edge + origin + Neon deployment during stabilization. Revisit architecture only after measuring failure rates, Neon compute activity, origin availability, and monthly spend.

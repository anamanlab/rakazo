# Rakazo release checklist

Use this checklist for a staging candidate and again for the approved production release. A checked item needs a link or redacted artifact in the internal release record. Do not paste credentials, database URLs, prompts, customer records, private hostnames, or raw provider logs into the record or this repository.

**Release SHA:** `<approved-git-sha>`
**Edge version:** `<immutable-worker-version-and-sha>`
**API image:** `<immutable-image-digest-and-sha>`
**Worker image:** `<immutable-image-digest-and-sha>`
**Release owner:** `<role>`
**Date/window:** `<approved-window>`

## 1. Scope and release gates

- [ ] Release scope is stated: chat, bots, memory, delegation, integrations, schedules, browser/computer, and write actions are individually marked enabled or disabled.
- [ ] Any disabled capability has a safe UI/API response; it cannot report a successful run when the provider is absent.
- [ ] Production deployment/configuration/billing changes are separately approved. This checklist alone does not authorize them.
- [ ] P0 launch blockers from the [audit](../audits/rakazo-production-audit.md) are closed or the release is deliberately narrowed to exclude the affected feature.
- [ ] No open security issue enables unapproved data access, credential disclosure, remote code execution, tenant crossover, or unapproved external writes.
- [ ] CI is green for the exact candidate commit. A passing branch build or a previously published image is not release evidence.
- [ ] Automated review is complete; all actionable review issues are resolved.

## 2. Required runtime configuration

Verify values in the secret manager/deployment console without copying values into this checklist. The table names settings only; use placeholders for evidence.

| Setting | Required state |
|---|---|
| `NODE_ENV` | `production` for API/worker. |
| `DATABASE_URL` | Neon TLS endpoint using the non-owner runtime login; confirm direct/session-capable endpoint mode. Record endpoint mode only, never host or credentials. |
| `REALTIME_DATABASE_URL` | If set separately, confirm it supports the app’s listeners/session context; otherwise the app may use `DATABASE_URL`. Do not use transaction pooling for session-bound behavior. |
| `DATABASE_MIGRATION_URL` | Owner/migration login is available only to the migration step. Confirm it is removed from the long-running API environment. |
| `BETTER_AUTH_SECRET` | Unique production secret with required length; unrelated to database encryption and sandbox secrets. |
| `ENCRYPTION_KEY` / `ENCRYPTION_MASTER_KEYS` | Stable encryption key material available to every process that must read encrypted credentials. Confirm recovery/rotation keys are escrowed in the approved secret manager. Never regenerate casually. |
| `SECRET_STORE` | Explicitly select encrypted storage or the approved external secret store. Confirm all required API/worker credentials are scoped to the process that needs them. |
| `SIGNUPS_ENABLED` | Explicitly set according to the approved access policy; test registration and recovery behavior before exposing the service. |
| Release identity | Set/record source SHA and immutable API/worker image digests; Worker version/metadata must identify the same release SHA. Do not rely on a mutable `latest` tag. |
| Model connections | Configure through shared connection settings. Record provider, model, credential ownership class (BYOK or Gateway), and fallback order without recording key material. Primary and backup must be separately tested and have independent billing/quota where claimed. |
| `MAX_TOOL_CALLS_PER_TURN` | Set a finite, reviewed production value; verify server-side default is also finite if configuration is missing. |
| `MODEL_STREAM_MAX_RETRIES` | Explicitly reviewed. Provider adapters must be able to override retries for non-transient quota/billing errors. |
| `SANDBOX_PROVIDER` | `none` unless the P2 sandbox gate passed. If enabled, configure the matching isolated provider and egress/credential boundary. Never select a host-shell/development provider in production. |
| `SANDBOX_SUPERVISOR_URL` / `SANDBOX_SUPERVISOR_TOKEN` | Required only for the selected supervisor deployment. Validate reachability and authentication without exposing token values. |
| `BROWSER_PROVIDER` | Leave unset unless P2 browser tests, credential scope, MFA handoff, and session cleanup passed. |
| `MCP_STDIO_ENABLED` / `MCP_STDIO_ALLOWED_COMMANDS` | Keep `false` unless a reviewed server-side command allowlist and sandbox are deployed. Prefer remote MCP over arbitrary local process launch only when its URL/SSRF policy is verified. |
| `SENTRY_DSN`, `AXIOM_TOKEN` / `AXIOM_DATASET`, OTLP settings | Optional; if enabled, confirm they receive sanitized events and that alert routing has an owner. Never enable content capture for convenience. |
| `OTEL_CAPTURE_CONTENT` | `false` unless a separately approved privacy review authorizes it with a trusted collector and retention policy. |
| Cloudflare AI Gateway payload logging | Disable prompt/response payload storage or send `cf-aig-collect-log-payload: false`; retain only necessary metadata. Verify setting/header behavior with a synthetic prompt. |

Do not introduce provider/model-specific environment variables when the shared connection settings express the same configuration. Existing deployment variables are listed here to verify current behavior, not to encourage a second provider configuration mechanism.

## 3. Pre-deploy checks

### Source and artifact identity

- [ ] `git status` is clean for the release candidate and the commit is reachable from the approved branch.
- [ ] Fork/upstream backports in the candidate are listed by upstream SHA and reviewed for Cloudflare/Neon assumptions.
- [ ] CI unit, typecheck, lint, production build, database journey, Web E2E and applicable native jobs passed on the exact SHA.
- [ ] Trusted screenshot/report publishing completed or its failure is understood and does not mask test status.
- [ ] Built API/worker images are immutable and match the release SHA. Capture their digests in the internal release record.
- [ ] Cloudflare Worker bundle is built from the same SHA; deployment workflow is enabled only for this approved release. Capture the immutable version.
- [ ] Previous Worker version and API/worker image digests remain available for rollback.

### Dependency and security checks

- [ ] Production dependency audit has no known critical or reachable high advisory; exceptions include reachability and compensating-control evidence.
- [ ] DOMPurify resolves to the fixed release; remote MCP SDK resolves to an advisory-fixed version.
- [ ] SSRF tests reject loopback, private, link-local, metadata, IPv4-mapped IPv6, redirect, and DNS-rebinding cases.
- [ ] Browser credential requests are scoped to the approved site; OAuth token rotation persists safely.
- [ ] Public signup, account recovery, session expiry, admin access and invitation policy match the approved access model.
- [ ] Tenant-isolation tests cover API, database, background jobs, child agents, memory, MCP and integration credentials.
- [ ] Every external write has an authorization check and approval policy. No broad “run without asking” mode is enabled.
- [ ] Logs and error events redact provider keys, OAuth tokens, browser credentials, cookies, prompts and customer payloads.

### Database and migration checks

- [ ] Neon migration status matches the candidate; failed, pending, or unknown migrations are investigated.
- [ ] Migration runs using the migration owner; API and worker start with the runtime role only.
- [ ] Migration is additive/previous-release-compatible: old API code remains valid during the side-by-side deployment window.
- [ ] Previous-release API and new API can both read/write during staging migration validation. Drops/renames are deferred to a later release.
- [ ] Runtime role is not superuser, has `BYPASSRLS=false`, and is not the owner of tenant tables protected by RLS.
- [ ] Direct/session-capable Neon connection mode is confirmed for `LISTEN`, advisory locks, and transaction-local RLS context.
- [ ] Neon compute size, autosuspend behavior, connections, active CU-hours, storage, and plan headroom are reviewed against the observed workload.
- [ ] Free plan unit and compute assumptions are stated correctly: 100 CU-hours is not 100 wall-clock hours; at 0.25 CU it is 400 active hours.

### Backup and recovery checks

- [ ] A Neon-specific logical backup has completed; its encrypted artifact is stored separately from the production database/origin.
- [ ] Backup checksum, age, size, encryption, retention, and offsite copy status are verified without recording secrets.
- [ ] Encryption-key recovery/rotation procedure is available to the authorized on-call role.
- [ ] Backup restores to an isolated Neon branch/project. Application migrations and a minimal read-only integrity check succeed there.
- [ ] Measured RPO/RTO meet the owner-approved targets; a six-hour provider restore window alone is not accepted as the only backup.
- [ ] Backup failure alert has been tested. The backup does not send production data to an unapproved sink.

## 4. Reproducible smoke tests

Run against staging first with test accounts, synthetic data, and test integration credentials. Save pass/fail and sanitized run IDs in the private release record; do not save prompts or raw logs in the repository.

### Edge, API, and database health

The public liveness request verifies only that a Worker/origin path responds:

```sh
curl --fail --silent --show-error "$APP_BASE_URL/health"
```

The trusted deploy runner must check the API’s database-aware readiness endpoint through its private/operator path. It must validate JSON, not only HTTP 200 (the SPA fallback can otherwise look healthy):

```sh
curl --fail --silent --show-error "$API_HEALTH_BASE_URL/ready" \
  | jq -e '.ok == true and .degraded == false'
```

Confirm all of the following:

- [ ] Public edge serves the expected build and SPA route; static assets do not traverse the origin.
- [ ] API/RPC/MCP paths reach the origin; request body streaming, cookies, and authenticated session handling work.
- [ ] `/ready` returns API JSON and fails when the DB/API dependency is unavailable; an HTML response fails the gate.
- [ ] `/internal/health` details are available only through the approved operator path and are not exposed publicly through SPA fallback.
- [ ] Worker reports ready only when it can connect, claim work, and publish a heartbeat.
- [ ] Tunnel connector, origin route, Vite web proxy, API, and worker all identify the expected release revision.
- [ ] Authenticated SSE and WebSocket/screen paths reconnect or fail visibly on disconnect; no run is shown as successful after interruption.

### Model and agent smoke matrix

Use a staging provider connection with a strict spend cap. Repeat the relevant matrix after changing provider, model, tool schema, or fallback order.

- [ ] **Ordinary chat:** send a short non-sensitive request; verify one assistant response, persisted history, usage metadata, and no duplicate run.
- [ ] **Multi-step reasoning:** execute a reviewed structured task; evaluate quality using the versioned judge rubric with cost separated from product inference. A judge error is unqualified, not a pass.
- [ ] **Tool execution:** call one deterministic read-only tool; verify validated arguments, scoped authorization, tool result, and final response.
- [ ] **Agent delegation:** coordinator assigns one task to two specialists; verify hop limits, per-agent model/provider settings, isolated credentials, combined result, child history, and clear partial failure.
- [ ] **Provider failure:** simulate a transient 5xx/timeout; verify bounded retry and a tested alternate only if configured.
- [ ] **Quota exhaustion:** simulate Cloudflare daily quota and provider quota; verify no repeat to the depleted primary, no false success, and either one independent backup or clear quota guidance.
- [ ] **Plan-ineligible model:** simulate Workers AI 5035; verify model is rejected or one explicitly eligible independent backup is used. Invalid credential 403 remains actionable and is not hidden.
- [ ] **Billing error:** simulate 402; verify the actual failed route/provider is named without retrying it and no billing/configuration change happens automatically.
- [ ] **Near context cap:** include representative history, system/developer messages, tool definitions/results and output reservation; verify request stays within provider limits or returns a clear preflight error.
- [ ] **Groq 413:** cause one controlled oversized staging request; verify one context shrink at most, tool history remains valid, and a second failure is surfaced without looping.
- [ ] **Interrupted side effect:** interrupt after dispatch but before acknowledgement; verify the action is marked uncertain/pending, the UI does not say success, and replay cannot duplicate the external effect without an idempotency key or renewed approval.
- [ ] **Cancellation/stream timeout:** abort a client stream and simulate provider timeout; verify cancellation propagates and no orphan run continues consuming tools indefinitely.
- [ ] **Budgets:** verify tool-call, time, context and spend limits terminate an over-budget run with explicit state and audit event.

### Product workflows

- [ ] Create, edit, archive and run a bot; verify model/connection settings persist.
- [ ] Create coordinator, Marketing, Sales and Operations bots with scoped roles. Verify delegated task and a partial failure report.
- [ ] Verify memory is shared only within its configured bot/Space scope and deletion/retention works.
- [ ] Save, version and execute a skill; validate structured inputs/outputs and required approvals.
- [ ] Connect an MCP/app integration using test credentials; verify least-scope read, OAuth refresh, revocation and secret redaction.
- [ ] Attempt a write action without approval; verify it is denied. Approve once; verify exactly one idempotent write and audit record.
- [ ] Create a scheduled routine; verify one execution, visible history, failed-job alert, retry policy, and recovery after worker restart.
- [ ] Confirm unsupported browser/computer capability is shown as unavailable if sandbox provider is `none`.
- [ ] If computer/browser is in scope, complete the isolated login/MFA, persistent session, forbidden-egress, credential-scope, approval, cancellation and cleanup checks in P2.1.

## 5. Deploy procedure

1. [ ] Announce release scope and freeze the immutable release SHA/artifacts.
2. [ ] Confirm current backup and recovery gates immediately before migration.
3. [ ] Deploy additive migrations using the migration owner. Verify success before starting new API code.
4. [ ] Start the new API and worker revisions alongside the previous release for the configured overlap. Verify both are compatible with the schema.
5. [ ] Deploy the Cloudflare Worker from the same SHA; verify route/binding configuration without exposing the `ORIGIN` value.
6. [ ] Run health/readiness, login, model, tool, queue, schedule, and approval smoke tests.
7. [ ] Start with the staging-equivalent canary user/team and low concurrency. Monitor readiness, provider error categories, run failures, queue age, Neon CU-hours, and spend.
8. [ ] Expand only after the canary completes a full scheduled cycle and all gates pass.
9. [ ] Record exact edge version, API/worker image digests, schema migration heads, smoke-test results, approver, and time in the internal release record.

Do not drop or rename database columns/tables in the same release that stops old code from reading them. Schedule later cleanup only after the compatibility window is over and old revisions are absent.

## 6. Monitoring during and after release

- [ ] Alert on API readiness failure, worker heartbeat loss, queue age, repeated run failures, failed scheduled canary, backup failure, and Neon/storage/compute limit approach.
- [ ] Alert on provider error category/model/provider and retry counts without logging prompt or response payloads.
- [ ] Track per-run/provider usage, tool count, timeout, cancellation, quota, and fallback. Ensure a fallback event is visible and not recorded as primary success without attribution.
- [ ] Check Cloudflare Worker invocation errors, origin/Tunnel errors, 5xx rates, and deploy revision parity.
- [ ] Review Neon active hours/CU usage, suspend/wake frequency, connection count, and latency after one representative quiet period and one busy period.
- [ ] Verify error sink receives a synthetic failure alert, with secret/prompt redaction.
- [ ] Observe one scheduled run and one approved external write from creation through final persisted outcome.
- [ ] Keep a named on-call owner and exact rollback artifacts available for the observation window.

## 7. Rollback and recovery

### Application rollback

- [ ] Identify the prior immutable Cloudflare Worker version and confirm it can be restored.
- [ ] Identify prior API and worker image digests; confirm they are retained and compatible with current additive schema.
- [ ] On edge-only failure, restore the prior Worker version and recheck API health.
- [ ] On API/worker failure, stop new scheduled work if needed, return to prior compatible images, then verify queued jobs reconcile and no external action is duplicated.
- [ ] Keep backward-compatible routes/config through the overlap window. Do not delete current credentials, sessions, or encryption keys during rollback.
- [ ] If a database migration introduced a problem, prefer a forward-compatible repair. Restore data only after the incident owner confirms the recovery point and accepts the data-loss window; restore into isolation first.

### Recovery drill record

- [ ] Incident trigger and detection time: `<redacted reference>`
- [ ] Backup snapshot date and verification: `<redacted reference>`
- [ ] Restore target: `<isolated branch/project reference>`
- [ ] RPO achieved: `<duration>`
- [ ] RTO achieved: `<duration>`
- [ ] Application schema/data checks: `<pass/fail summary>`
- [ ] Encryption-key recovery validated: `<yes/no; no key value>`
- [ ] Follow-up issues assigned: `<internal ticket references>`

## 8. Release go/no-go

**Go** only when all are true:

- [ ] Production revisions are proven to match the approved release SHA.
- [ ] Critical/high reachable security findings are fixed or affected capabilities are disabled.
- [ ] Primary model and any claimed fallback pass the conformance matrix; quota, billing, 403 and 413 failures are bounded and actionable.
- [ ] Tool/run budgets are finite; interruption cannot be reported as successful or silently duplicate an external effect.
- [ ] API, database and worker readiness are distinct and accurately gated.
- [ ] Authentication, tenant isolation, approvals, and secret handling pass the scoped tests.
- [ ] Scheduled jobs recover; integrations have least-scope credentials and tested token refresh.
- [ ] Neon backup/restore and rollback are rehearsed; RPO/RTO are accepted.
- [ ] Monitoring alerts fire and retain no prompt/credential payloads without explicit approval.
- [ ] Cost envelope, compute activity, provider spend limit, and origin/backup costs are understood and approved.
- [ ] Release owner and rollback operator are available during the rollout window.

If one gate fails, narrow the release scope or stop. Do not turn an operational failure into a successful HTTP response or generic completed task.

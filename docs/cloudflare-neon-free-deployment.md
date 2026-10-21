# Cloudflare + Neon free-plan deployment plan

Scope: put Rakazo behind Cloudflare's free plan (DNS, CDN, WAF, Pages, Workers, Tunnel, R2) and
Neon's free plan (Postgres), without a paid tier. The Node.js API, the background worker and the
computer sandboxes stay on a machine you control.

This document is a plan, not a record of work. Nothing in it has been deployed.

---

## 1. Audit summary

### 1.1 Tooling present on this machine

| Tool | Version | State |
| --- | --- | --- |
| `cf` (Cloudflare CLI) | 1.0.0-beta.17 | Authenticated (OAuth), one account |
| `neon` (Neon CLI) | 8.3.5 | Authenticated (OAuth), one org on the Free plan |
| Cloudflare MCP server | — | Connected (API tools + 21 skills) |
| Neon MCP server | — | Connected (API tools + 9 skills) |
| `wrangler` | — | Not installed |
| `pnpm` / `node` / `psql` / `docker` | — | Present |

The repo has no `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml`, so per the project
`AGENTS.md` the `cf` CLI is the tool to use, and the new edge project should carry a typed
`cloudflare.config.ts`.

### 1.2 Current account state

The Cloudflare account holds several unrelated zones and Workers from other projects.
**`rakazo.com` is not in this account.** Today `www.rakazo.com` is on Vercel and
`app.rakazo.com` is a VM behind Caddy (`infra/compose/Caddyfile.prod`).

The Neon org (Free) already holds several unrelated projects across `aws-us-east-1`,
`aws-us-east-2` and `aws-sa-east-1`. There is no Rakazo project. `aws-sa-east-1` (São Paulo) is the
closest region to the likely host, so it is the default choice.

### 1.3 What changed on Cloudflare recently (checked against the live changelog)

- **Cloudflare Containers are Workers Paid plan only** ($5/mo minimum). Free tier: N/A.
- `cf` 1.0.0-beta.16+ ships `cf cli search` and `cf docs search`; generated command names are
  now kebab-case (`cf accounts billing getCredits` → `get-credits`).
- `cf deploy` and `wrangler deploy` (≥ 4.150.0) now upload source maps by default.
- The Cloudflare API MCP server now supports step-up authorization, so an agent can be granted
  minimal scopes and request more on demand.
- `createAI` replaces `workers-ai-provider` and `ai-gateway-provider` in the Agents SDK (both
  deprecated); `Think` moved from `@cloudflare/shell` to `@cloudflare/computer`.
- New this month: Clairic extraction model on Workers AI, DeepSeek V4.1 Flash (paid plan only),
  full-transaction WAF (request correlated with response), Precursor Monitor mode, Cloud Workload
  Security beta, Gateway + Workers public beta, Logpush Transformers, `tsrs`.

### 1.4 Why the whole application cannot run on Cloudflare Workers (free or paid)

| Component | Blocker |
| --- | --- |
| `apps/api` | Hono on `@hono/node-server` with an inbound TCP listener (`apps/api/src/index.ts:17`), `node:net` socket tracking, `node:crypto` (`createHash`/`createHmac`/`timingSafeEqual`/`randomBytes`), `node:fs`, `node:dns`, `node:os`, `node:module` (runtime `require.resolve("mermaid/dist/mermaid.min.js")`, `apps/api/src/diagram-script.ts:2`), `node:child_process`, `@hono/node-server/conninfo`, artifacts and bot homes on local disk, Telegram long-poll, Prisma over TCP |
| `apps/worker` | graphile-worker's continuous runner with a dedicated `LISTEN` connection (`packages/adapters/src/wakeup.ts:174`), Postgres `LISTEN/NOTIFY` fanout (`packages/adapters/src/realtime.ts:124`), a **process-lifetime session advisory lock** (`packages/adapters/src/job-reconciler.ts:64`), a 30 s reconciler whose cursors live in process memory (`job-reconciler.ts:409`), SIGTERM drain, native `koffi` and `sharp`, MCP servers spawned as child processes |
| `packages/db` | Prisma 7 + `@prisma/adapter-pg` + `pg` over TCP; row-level security driven by `current_setting` per connection (`packages/db/src/row-security.ts:150`); advisory locks; `LISTEN/NOTIFY`; `jsonb_path_query_array`; `to_tsvector` + GIN; `FOR UPDATE`; the `graphile_worker` schema. **D1 is not an option** — it is SQLite and supports none of this |
| Sandboxes | The supervisor drives a real Docker daemon (`dockerode`); the computer image is X11/xvfb/x11vnc/novnc/chromium plus a compiled X11 shared object. Cloudflare Containers is the only Cloudflare-native answer and it is paid-only |

`packages/contracts` and the Hono app object itself are framework-neutral, but neither is the
deployable unit.

### 1.5 Neon free-plan facts that shape the design

| Limit | Free plan |
| --- | --- |
| Compute | 100 CU-hours per project per month |
| Storage | 1 GB Postgres per project (20 GB across the account) |
| Public network transfer | 5 GB per project per month |
| Branches | 10 per project |
| Autoscaling | up to 2 CU |
| Scale to zero | after 5 minutes (cannot be disabled on Free) |
| History window | 6 hours |
| Snapshots | 1 manual |
| IP allow list / VPC | **Scale plan only** |

**Two Neon details are load-bearing for this codebase.**

1. **Use direct (non-pooled) connections.** Neon's PgBouncer runs in transaction mode, where
   `SET`, `LISTEN`/`NOTIFY`, temp tables and session-level advisory locks are all unsupported.
   Rakazo needs all four. More seriously, `packages/db/src/row-security.ts:150` sets the tenant
   context with `set_config('app.space_id', …, false)` — the `false` means *session* scope. Under
   transaction pooling the session belongs to whichever server connection PgBouncer hands out
   next, so **one tenant's context would leak into another tenant's queries.** The app login
   therefore must connect to the direct endpoint (no `-pooler` suffix).

2. **Let the migration create the app login, not the Neon CLI.** Roles created through the Neon
   Console, CLI or API automatically receive `neon_superuser` membership, which carries
   `BYPASSRLS`. Roles created with plain SQL do not. The row-level security check in
   `packages/db/src/database-access.ts:91` reads the role's *direct* `rolbypassrls` attribute, so
   inherited `BYPASSRLS` from `neon_superuser` slips past it. Creating `rakazo_app` through
   `neon roles create` would therefore leave the database without tenant isolation. Run
   `pnpm db:migrate` with the owner connection and let `provisionRuntimeRole` issue
   `CREATE ROLE … LOGIN …` in SQL instead.

### 1.6 Cloudflare free-plan limits that shape the design

| Limit | Free |
| --- | --- |
| Workers requests | 100,000/day |
| Workers CPU | 10 ms per invocation |
| Workers memory / bundle | 128 MB / 64 MiB |
| Subrequests | 50 per request |
| Cron Triggers | 5 per account |
| Static asset files | 20,000 per Worker version, 25 MiB each |
| Pages builds | 500/month, 1 concurrent, 20-minute timeout |
| Pages projects | 100 |
| R2 | 10 GB storage, 1M Class A, 10M Class B, free egress |

**Static asset requests are free and unlimited** on Workers. Only the proxied API traffic counts
against the 100,000/day ceiling.

---

## 2. Target topology

```
Web · Mobile · Desktop clients
        │  HTTPS
        ▼
┌─ Cloudflare free plan ──────────────────────────────────────────┐
│ www.rakazo.com     → Pages project (apps/www, static Astro)      │
│ app.rakazo.com     → Worker "rakazo-web"                         │
│                      ├ static assets: apps/web/dist (free, ∞)    │
│                      └ /rpc /api/* /mcp/* /.well-known/* → API   │
│ app.rakazo.com/novnc/* → Tunnel (raw WebSocket/TCP screen proxy) │
│ DNS · CDN · WAF · Cache · Turnstile · Tunnel · R2 (all free)     │
└──────────────────────────────┬───────────────────────────────────┘
                               │ Cloudflare Tunnel (outbound only)
                               ▼
┌─ Node host (existing VM or a free-tier VM) ─────────────────────┐
│ api        :3100   Hono + Prisma + SSE                           │
│ worker             graphile-worker + reconcilers                 │
│ novnc-proxy :5173  screen proxy only (reuses today's vite plugin) │
│ supervisor + computer   optional; or a remote sandbox provider   │
│ /data                persistent volume for artifacts and homes   │
└──────────────────────────────┬───────────────────────────────────┘
                               │ direct (non-pooled) TLS
                               ▼
┌─ Neon free plan ────────────────────────────────────────────────┐
│ project "rakazo" · aws-sa-east-1 · branch "production"          │
│ 0.25–0.5 CU · scale to zero after 300 s                         │
│ owner role (migrations) + rakazo_app (RLS, no BYPASSRLS)        │
└──────────────────────────────────────────────────────────────────┘
```

The only moving parts that are not free-tier Cloudflare or Neon are the Node host and the model
provider (OpenRouter or equivalent), which is a real recurring cost either way.

---

## 3. Work plan

### Phase 0 — Decisions (blocking)

1. **Domain.** Add `rakazo.com` to the Cloudflare account (full zone, point the registrar's nameservers
   at Cloudflare), or add `app.rakazo.com` as a delegated subdomain zone to avoid touching the apex.
   The subdomain zone is lower risk; the full zone is simpler long-term.
2. **Node host.** Where does `api` and `worker` run?
   - The machine already deploying to `app.rakazo.com` (zero cost, but it is also the dev box), or
   - A free-tier VM (Oracle Cloud Always Free ARM gives 4 OCPU / 24 GB), or
   - A ~$5/mo VM if a guaranteed home is preferred.
   Whichever it is, it needs Docker, ~2 GB RAM for `api` + `worker`, and a persistent `/data`
   volume.
3. **Computers.** `SANDBOX_PROVIDER` decides whether agent computers exist:
   - `none` — free, computers disabled, agents still chat and use tools.
   - `docker` — free but needs ~4 GB RAM and the `computer` image on the host.
   - `e2b` / `daytona` — remote, each with its own free allowance, no host cost.
   Start with `none` or a remote provider; add local Docker later.

### Phase 1 — Neon

1. `neon projects create --name rakazo --region-id aws-sa-east-1`
2. Create the `production` branch with a compute at `autoscaling_limit_min_cu=0.25`,
   `autoscaling_limit_max_cu=0.5`, `suspend_timeout_seconds=300`.
3. Copy the **direct** (non-`-pooler`) connection strings:
   - `DATABASE_MIGRATION_URL` → branch owner role, used only by migrations.
   - `DATABASE_URL` → the app login, created by the migration (see 1.5.2). Do not pre-create it
     with `neon roles create`.
   - `REALTIME_DATABASE_URL` → a login with `LISTEN` rights on `rakazo_events`.
4. Run migrations once from the host:
   `pnpm --filter @rakazo/api db:migrate`
   then confirm row-level security is actually enforced:
   `pnpm --filter @rakazo/api` → the startup log line from `describeRowSecurity`. A warning here
   means the app login bypasses RLS and must be fixed before anything else.
5. Connection budget. At 0.25 CU, `max_connections` is 104 with 7 reserved by Neon, so 97 are
   available. Budget roughly: API Prisma pool 4–6, API job pool 2, API realtime `LISTEN` 1, API
   advisory-lock client 1, worker equivalents 10, migrations and admin a few. Set `DB_POOL_MAX=4`
   and keep it there.
6. Storage and egress. 1 GB and 5 GB are the hard ceilings.
   - Schedule a monthly `pg_dump` to R2 (free tier, 10 GB) using the existing
     `infra/systemd/rakazo-backup.service` pattern.
   - Watch `packages/db/src/history-retrieval.ts` for `SELECT *` over the `jsonb` history blob; that
     is the most likely source of egress growth.

### Phase 2 — Cloudflare Worker for `apps/web`

New package `apps/web-edge/` with `cloudflare.config.ts` and a small `src/index.ts`.

- **Static asset binding** pointing at `apps/web/dist`, so the SPA is served from Cloudflare's
  edge and its requests are free and unmetered.
- **`fetch` handler** that proxies the API surface to the API origin over the Tunnel:
  `/rpc/*`, `/api/*`, `/mcp/oauth/callback`, `/.well-known/*`. Everything else falls through to
  the asset binding.
- **SPA fallback**: `/* /index.html 200` for navigation requests only. The current
  `rakazo-missing-asset-404` plugin makes stale hashed chunks 404 instead of returning HTML; keep
  that behaviour by only falling back when the request accepts `text/html` and the path is not an
  `/assets/` file.
- **Streaming**: `/rpc` carries an endless SSE stream (`apps/api/src/router.ts:2445`). Pass the
  upstream body straight through — `new Response(upstream.body, …)` — and never buffer it.
- **CSP**: today it is emitted by the vite preview server plugin. Move it to the Worker, importing
  the shared source at `packages/contracts/src/content-security-policy.ts` so there is one
  definition, and set `content-security-policy` plus `reporting-endpoints` on HTML responses.
  Also set `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` and HSTS, matching
  `infra/compose/Caddyfile.prod`.
- **Client IP**: forward `CF-Connecting-IP` as `X-Forwarded-For`.
- **Route**: `app.rakazo.com/*` → the Worker. Carve out `app.rakazo.com/novnc/*` to the Tunnel
  origin so the screen proxy keeps its raw WebSocket/TCP behaviour without reimplementing it in
  the Worker.
- **API-side trust**: set `CLIENT_IP_HEADER=cf-connecting-ip` and `TRUSTED_PROXIES` to
  Cloudflare's published ranges. `infra/compose/Caddyfile.cloudflare.example` is the reference for
  this pattern.

### Phase 3 — Cloudflare Pages for `apps/www`

`apps/www` is already `output: "static"` with every route prerendered, so `apps/www/dist` uploads
directly. Three files are Vercel-specific and must be ported:

| Vercel file | Pages equivalent |
| --- | --- |
| `apps/www/middleware.ts` (Edge Middleware, `next()` from `@vercel/functions`) | `functions/_middleware.ts` using `context.next()` |
| `apps/www/api/download.ts` (file-based edge route) | `functions/api/download.ts` using `onRequestGet` |
| `apps/www/vercel.json` (redirect rules) | `public/_redirects` |

Drop the `@vercel/functions` dependency afterwards.

Commands: `cf pages create rakazo-www`, then `cf pages deploy apps/www/dist --project-name rakazo-www`.

### Phase 4 — Node host

Start from `infra/compose/docker-compose.prod.yml` and change it:

- **Remove** the `postgres` service (Neon replaces it) and the `web` service (Cloudflare serves it).
- **Keep** a `novnc-proxy` service. The screen proxy lives in the vite preview server today
  (`apps/web/vite.config.ts`); with the SPA on Cloudflare that proxy has to live somewhere on the
  host. Keeping it as a small service that serves `/novnc/*` and nothing else is the lowest-risk
  move.
- **Replace** Caddy with a Cloudflare Tunnel, or keep Caddy and add the Tunnel in front. The Tunnel
  is preferred: no public ports, no Cloudflare-IP allowlist file to keep in sync.
- **Environment changes**:
  - `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `REALTIME_DATABASE_URL` → the Neon direct strings.
  - `DB_POOL_MAX=4`
  - `DATA_DIR=/data` on a persistent volume
  - `RAKAZO_HOST=app.rakazo.com`, `WEB_ORIGIN`, `API_URL`, `BETTER_AUTH_URL` all
    `https://app.rakazo.com`
  - `CLIENT_IP_HEADER=cf-connecting-ip`, `TRUSTED_PROXIES=<Cloudflare ranges>`
  - `SANDBOX_PROVIDER` per the Phase 0 decision
  - Keep `ENCRYPTION_KEY` byte-identical across deploys. It wraps stored content keys; changing it
    orphans every stored secret and every encrypted artifact. `infra/railway/README.md` calls this
    out explicitly.

### Phase 5 — Edge hardening

- WAF free managed ruleset is on by default for proxied zones. The October 2026 "anomalous
  execution" rules apply to both the Managed and Free rulesets.
- Consider Turnstile on `/sign-in` if automated sign-up attempts appear.
- **Neon on the Free plan has no IP allow list** (it is a Scale-plan feature), so the database is
  reachable from the public internet. The mitigations are a 32+ character random password on both
  roles, the app login holding `NOBYPASSRLS` and no `CREATEDB`, and RLS verified as enforced at
  startup. `--block-public-connections` at project creation would close this properly but then
  only a VPC endpoint can reach the database, and VPC is Scale-only — so it is not available here.

### Phase 6 — CI/CD

- New workflow `.github/workflows/deploy-edge.yml`: build `apps/web` and `apps/www`, then
  `cf deploy` and `cf pages deploy` with a `CLOUDFLARE_API_TOKEN` secret. The CLI's own auth is
  OAuth for a human; CI needs a token (`cf` supports `CLOUDFLARE_API_TOKEN`).
- Keep the existing `deploy-production` job in `.github/workflows/ci.yml` for the host. It already
  gates on `vars.PRODUCTION_DEPLOY_ENABLED` and runs `deploy-main $GITHUB_SHA` over SSH.
- Migrations keep running on the host before the API starts, as they do today.

### Phase 7 — Cutover

1. Create the Neon project and run migrations; seed an owner account with
   `pnpm --filter @rakazo/api exec tsx src/cli/bootstrap-owner.ts`.
2. Deploy `apps/www` to Pages and verify `www.rakazo.com`.
3. Deploy the Worker with the Tunnel pointing at a host that is already running `api` and `worker`
   against Neon.
4. Verify, in order: `/rpc/health`, sign-in, a chat turn, a live SSE update, a computer screen
   over `/novnc`, a file upload, and mobile deep-link sign-in.
5. Move the DNS record, keep the old VM serving as the fallback for a week.
6. Rollback: point the DNS back at the VM. The Neon data is the source of truth from the cutover
   onwards, so a rollback must not write to the old Postgres.

---

## 4. Risks, ordered by how likely they are to hurt

1. **Neon's 100 CU-hour ceiling is the binding constraint.** The background worker polls
   graphile-worker's queue every 500 ms, so the database is never idle and never scales to zero. At
   the 0.25 CU minimum, 100 CU-hours is 400 hours — about 16.6 days of continuous runtime per
   month. After that the compute suspends and the app stops until the next billing period. Options,
   in order of preference: raise the graphile poll interval so the database can idle; schedule the
   worker to run only part of the day; or accept roughly 17 days of uptime and add a monthly
   suspend/resume job. A Cron Trigger cannot replace the worker: the reconciler cursors are
   in-process state, so a stateless cron would rescan from the beginning on every fire.
2. **1 GB of Postgres storage blocks writes when exceeded.** Message and event history is the
   growth path. Needs a retention or archival policy for old rows plus monthly `pg_dump` to R2.
3. **5 GB of egress per project.** SSE frames and history reads count. Audit the history queries
   before real users arrive.
4. **The database is publicly reachable on the Free plan** (see Phase 5).
5. **The pooled endpoint would break tenant isolation.** Using the direct endpoint is not optional.
6. **100,000 Workers requests/day.** Every API call routed through the Worker counts; static assets
   do not. Fine for a demo, tight for a busy product.
7. **`rakazo.com` is not in the Cloudflare account** — the DNS work in Phase 0 is a prerequisite.
8. **The screen proxy must stay on the host** or be reimplemented in the Worker.
9. **`DATA_DIR` must be a persistent volume**, or artifacts and bot homes disappear on restart.

---

## 5. When to stop using the free tiers

The topology above is identical to the paid one; only configuration changes. The upgrade triggers
are concrete:

| Trigger | Change |
| --- | --- |
| Neon compute hours exhausted, or the app must stay up 24/7 | Neon Launch, pay-as-you-go at $0.106/CU-hour |
| Database must not be reachable from the public internet | Neon Scale for IP allow lists and VPC |
| Storage above 1 GB | Neon Launch ($0.35/GB-month) |
| More than 100,000 API requests/day | Workers Paid ($5/mo) |
| Bot computers must run with a real filesystem and native libraries | Cloudflare Containers, or keep Docker on the host |

For a public demo, the free plan is workable. For a real deployment with real users, Neon Launch
plus Workers Paid removes risks 1 through 6 for a few dollars a month, and the LLM provider bill
will dwarf both.

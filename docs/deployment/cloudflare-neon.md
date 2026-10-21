# Running Rakazo on Cloudflare and managed Postgres

This is the runbook for the deployment that serves the app from Cloudflare's edge and
keeps its data in a managed Postgres service. The reasoning for the shape is in
[cloudflare-neon-free-deployment.md](../cloudflare-neon-free-deployment.md); this
document is how to operate it.

The hostnames below are placeholders. The deployment's own values live outside the
repository, in the operator's environment.

---

## 1. The shape

```
web · mobile · desktop
      │  HTTPS
      ▼
Cloudflare
├── app host      → Worker "rakazo-web"    static SPA + API proxy
├── www host      → Worker "rakazo-www"   static marketing site + negotiation
└── origin host   → Tunnel                the app origin
      │
      ▼
Tunnel connector (on the host)
      │  http://127.0.0.1:5173
      ▼
app host
├── api    :3100   Hono + Prisma + server-sent events
├── worker         graphile-worker + reconcilers
└── web    :5173   static shell, screen proxy, API proxy
      │
      ▼
managed Postgres (direct endpoint)
```

Three things are worth knowing before changing anything.

**The app is same-origin.** The web app builds every API URL from `window.location`,
so the document and the API must answer on one hostname. That is why the edge Worker
proxies the API paths back to the origin instead of the app calling a second host.

**The Worker cannot proxy to its own hostname.** A request from the Worker to the app
host would match the Worker's own route and loop. The origin host is a separate
proxied DNS record that points at the tunnel and carries no Worker route.

**The database is reached over a direct connection.** The managed service pools
connections through a transaction-mode proxy that does not carry `LISTEN`/`NOTIFY` or
session-level advisory locks, and that would let one tenant's row-level security
context leak into another tenant's query. Use the direct endpoint, never the pooled
one. See [docs/self-host.md](../self-host.md#database-roles).

---

## 2. The pieces

### Edge workers

| Worker | Package | Serves |
| --- | --- | --- |
| `rakazo-web` | `apps/web-edge` | The app: the SPA's static assets, and the API paths proxied to the origin |
| `rakazo-www` | `apps/www-edge` | The marketing site: the Astro build, plus content negotiation and the download route |

Each has a `cloudflare.config.ts` (the runtime behaviour) and a `wrangler.config.ts`
(the build behaviour). The hostnames come from the environment, so the repository
does not name the deployment:

| Variable | Meaning |
| --- | --- |
| `RAKAZO_EDGE_HOST` | The hostname the app answers on |
| `RAKAZO_EDGE_ZONE` | The Cloudflare zone that hostname belongs to |
| `RAKAZO_EDGE_ORIGIN` | The origin the app worker proxies to |
| `RAKAZO_WWW_EDGE_HOST` | The hostname the marketing site answers on |

The asset behaviour matters for cost. A request the asset worker answers directly is
free and unmetered; a request that runs the Worker is counted against the account's
daily request allowance. The app worker therefore routes only the API paths to
itself (`runWorkerFirst` lists them) and lets the asset worker answer the rest. The
marketing worker runs first for every request, because the content negotiation has to
see the `Accept` header of the document requests; that site is small enough for the
allowance to hold.

### Tunnel

A remotely managed tunnel carries the origin. Its ingress rules live in the
Cloudflare API, not in a file on the host:

| Hostname | Origin |
| --- | --- |
| app host | `http://127.0.0.1:5173` |
| origin host | `http://127.0.0.1:5173` |
| anything else | `http_status:404` |

The connector runs on the host as a systemd unit (`infra/systemd/rakazo-cloudflared.service`)
and reads its token from a root-only file outside the repository. The token is the
credential that lets the host claim the tunnel; it is not a user credential.

### The host

`infra/compose/docker-compose.managed.yml` runs the API, the worker and the web
shell. It is the single-VM shape from `docker-compose.prod.yml` with the database and
the TLS terminator removed: the database is managed and the terminator is the tunnel.
The `web` service still runs because it owns the screen proxy and the API proxy; the
SPA it serves is only the fallback for a request that misses the edge.

The `app` network has a fixed subnet. The API trusts that subnet, because the tunnel
connector and the web shell are the only peers it ever sees.

### The database

One project, one branch, one read-write endpoint that autoscales between the minimum
and the maximum compute size. Two logins:

| Login | Used by | Rights |
| --- | --- | --- |
| the owner | migrations only | Owns the schema |
| `rakazo_app` | the API and the worker | Row-level security applies |

The runtime login is created by the migration, in SQL, not through the provider's
console or CLI. A login created through the provider is granted membership in the
provider's administrator role, which bypasses row-level security, and the check that
guards against that reads only the login's own attributes. Let the migration create
it.

---

## 3. Operating it

### Redeploying the edge

```bash
pnpm --filter @rakazo/web build
pnpm --filter @rakazo/www build
pnpm --filter @rakazo/web-edge exec cf deploy
pnpm --filter @rakazo/www-edge exec cf deploy
```

The push workflow does this on `main` once the `EDGE_DEPLOY_ENABLED` repository
variable is set. It needs a `CLOUDFLARE_API_TOKEN` secret and the hostname
variables as repository variables.

### Redeploying the host

```bash
docker build -f infra/compose/Dockerfile -t rakazo/app:local .
docker compose --env-file .env -f infra/compose/docker-compose.managed.yml up -d
```

The API container applies pending migrations before it starts serving. Keep
`ENCRYPTION_KEY` unchanged across deploys: it wraps the stored content keys, so
changing it makes every stored secret and every encrypted artifact unreadable.

### Reading the logs

```bash
docker compose --env-file .env -f infra/compose/docker-compose.managed.yml logs -f api worker
sudo journalctl -u rakazo-cloudflared.service -f
```

### Rotating a secret

Change it in the environment file and restart. The runtime login's password is the
exception: it is set by the migration, so changing it in the environment file and
restarting the API applies it on the next deploy.

---

## 4. The ceilings

Every one of these is a hard limit of a free plan. They are listed with what
happens when the limit is reached, because none of them fail loudly.

| Limit | Ceiling | What happens |
| --- | --- | --- |
| Database compute | 100 hours per project per month | The compute suspends and the app stops until the next billing period. The background worker polls its queue continuously, so the database is never idle enough to scale to zero on its own. At the minimum compute size this is about sixteen days of running time per month. |
| Database storage | 1 GB per project | Writes are blocked. Take a dump and archive old rows before it fills. |
| Database egress | 5 GB per project per month | Queries that read the whole history blob are the usual cause. |
| Edge requests | 100,000 per day | Requests over the allowance fail. Static asset requests answered by the asset worker do not count. |
| Database reachability | Public | The free plan has no address allow list, so the database answers anyone who has the credentials. The password, the row-level security and the absence of superuser rights are what protect it. |

The compute ceiling is the one that bites first, and it is a scheduling problem
rather than a capacity problem: the work is there, the hours are not. Either stop the
background worker when there is nothing to do, or move to a paid plan where the
compute is billed by the hour it is used.

The free plan has no spending notifications, so the usage is worth watching directly:

```bash
neon api /projects/<project-id> | jq '.project | {compute_time_seconds, active_time_seconds, data_transfer_bytes}'
```

`compute_time_seconds` divided by `active_time_seconds` is the size the compute is
running at. Multiply it by the seconds of running time you need and compare the
result against the monthly allowance to see how long the month has to fit in.

---

## 5. Checking the deployment

```bash
# The document comes from the edge and is cached there.
curl -sI https://<app-host>/ | grep -iE "cf-cache-status|content-security-policy"

# The API answers through the edge.
curl -s https://<app-host>/health
curl -s -X POST https://<app-host>/rpc/health -H 'content-type: application/json' -d '{}'

# The marketing site negotiates its representation.
curl -s https://<www-host>/ -H 'Accept: text/markdown' | head -1

# The database enforces its row-level security.
psql "$DATABASE_URL" -c "SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'rakazo_app'"
```

The last one must report `rolbypassrls` as false. If it reports true, the runtime
login can read every tenant's rows and the deployment is not safe to open.

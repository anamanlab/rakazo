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

## 3. What is not switched on

Three things are off until an operator turns them on, because each one costs money
or a provider account and none of them is needed to serve the app.

**Agent computers.** The sandbox provider is `none`, so agents have no computer.
Pick a provider and set it with its key: `e2b`, `daytona`, `boat` or `createos` for a
remote computer, or `docker` to run the computer image on the host. The host needs
about four gigabytes of memory for the image.

**The model provider.** The deployment serves the app but starts without a model, so a
conversation has nothing to answer with. The owner connects one in Settings → Models.
A connection is a key plus the settings that provider needs, and the space's default
model follows the connection. Cloudflare's AI Gateway reaches Workers AI with one
token: the account id, the gateway id, and a token that may invoke Workers AI
models. Workers AI has a shared daily free allowance and request rate limits. AI
Gateway's free routing and caching features do not make upstream paid models free.
See [free model setup and troubleshooting](#free-model-setup-and-troubleshooting).

**Email.** Without `SMTP_URL` and `EMAIL_FROM` there is no way to deliver a
verification or recovery message, and no owner can be created by the bootstrap
command.

The first account is created by the bootstrap command, which needs an address and a
password of at least sixteen characters. The credentials it is given are written
outside the repository, and the address is the one the owner signs in with.

---

## 4. Operating it

### Redeploying the edge

The build bakes the Content-Security-Policy into the asset worker's `_headers`. A zone
that runs Cloudflare Web Analytics has its beacon injected into every HTML response,
so the build has to allow that origin, or the console reports a blocked script:

```bash
RAKAZO_CSP_SCRIPT_SRC=https://static.cloudflareinsights.com \
RAKAZO_CSP_CONNECT_SRC=https://cloudflareinsights.com \
  pnpm --filter @rakazo/web build
pnpm --filter @rakazo/www build
pnpm --filter @rakazo/web-edge exec cf deploy
pnpm --filter @rakazo/www-edge exec cf deploy
```

Turning the zone's automatic Web Analytics injection off removes the need for both
origins. The push workflow passes `RAKAZO_CSP_SCRIPT_SRC` and
`RAKAZO_CSP_CONNECT_SRC` from repository variables.

The push workflow does this on `main` once the `EDGE_DEPLOY_ENABLED` repository
variable is set. It needs a `CLOUDFLARE_API_TOKEN` secret and the hostname
variables as repository variables.

The edge packages build their Worker from the assets the two site builds produce, so
those have to run first. `pnpm --filter @rakazo/web-edge bundle` builds the Worker
without uploading it, which is the way to check a change locally.

### Redeploying the host

```bash
docker build -f infra/compose/Dockerfile -t rakazo/app:local .
docker compose --env-file .env -f infra/compose/docker-compose.managed.yml up -d
```

The API container applies pending migrations before it starts serving. Keep
`ENCRYPTION_KEY` unchanged across deploys: it wraps the stored content keys, so
changing it makes every stored secret and every encrypted artifact unreadable.

### The plugin catalog

The Plugins panel lists the apps a deployment can connect. With `INTEGRATIONS_CATALOG_URL`
pointing at a catalog service, the panel searches that catalog by domain and installs
the surfaces it finds as app sources; without it, the panel shows only the sources
added by hand. A deployment that connects apps through a managed provider is
configured in the integration setup, which only the owner can open.

### Accounts and sign-ups

The first account is the deployment owner: it opens the deployment settings, the
integration setup and the computer settings. Sign-ups stay closed until the owner
opens them, either for everyone or for a list of addresses. A deployment that is
meant to stay private keeps them closed.

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

### Free model setup and troubleshooting

Use Settings → Models to save the connection and its default model. Token limits
belong to that connection; no provider-specific environment variables are needed.
Web, desktop, and mobile use the same backend configuration. A bot with its own
model overrides the space default, so check its model selection too.

**Groq.** Test the key and choose a model returned by the live model list. A model
name copied from an older guide can return `404 model_not_found` even with a valid
key. `openai/gpt-oss-20b` supports tools and low reasoning effort. For an account
with a 1,000 output-token-per-minute limit, start with a maximum output of 900 and
low thinking. Thinking consumes the output budget too. These settings do not
remove input-token or daily limits: Rakazo sends instructions and tool schemas as
well as the conversation. A fresh conversation can help with accumulated history;
even a fresh turn can exceed a small input allowance. Use the account's actual
limits rather than the model's much larger context window.

**Cloudflare Workers AI directly.** Select Cloudflare Workers AI, enter the account
ID and a token permitted to invoke Workers AI, and select
`@cf/zai-org/glm-4.7-flash`. Start with a maximum output of 2,048. No gateway,
prepaid credits, custom endpoint, or new deployment environment variable is needed.
This model supports tool calls, has a 131,072-token context window, and remains
available on Workers Free. Existing AI Gateway connections remain supported: they
also require a gateway ID and use the model ID
`workers-ai/@cf/zai-org/glm-4.7-flash`. Selecting an upstream paid provider model
through the gateway can require prepaid credits instead. The output cap bounds
each completion, not the whole conversation or a sequence of tool calls.

Workers AI includes **10,000 neurons per account per day**, shared across models
and applications. The allocation resets at **00:00 UTC**. Error `4006` means that
allowance is exhausted; changing models or calling Workers AI directly does not
refresh it. On Workers Free, wait for the reset. Keep the free plan to retain its
hard daily stop; upgrading permits charges beyond the allowance. Some models
require payment even before that allowance is exhausted.

| Failure | Meaning | Next step |
| --- | --- | --- |
| `401` or an authentication error | The credential was rejected | Check or replace the key in the connection |
| Groq `404 model_not_found` | That model is unavailable to the key | Test the key and select a returned model ID |
| Groq `413` / `429` saying the requested input exceeds the limit | A single prompt exceeds an input allowance | Reduce conversation context; waiting cannot make an oversized prompt fit |
| Groq `429` after earlier successful calls | The current rate allowance is consumed | Respect the retry delay; a tool loop sends the context again on each call |
| Groq `429` mentioning OTPM or output tokens | Output exceeds the account's allowance | Lower maximum output and thinking; respect the retry delay for consumed capacity |
| Workers AI `429`, code `4006` | Shared daily free allocation exhausted | Wait until 00:00 UTC |
| Gateway `402`, code `2021` | Unified billing has no credits | Select a Workers AI model eligible for the free plan |
| Workers AI `403`, code `5035` | The chosen model requires payment | Select a model available on Workers Free |
| `Required context exceeds the model context budget` | Required instructions, tools, or the current request do not fit | Choose a larger-context model or reduce the offered tools/current request |

Free AI Gateway caching only reuses identical requests. Chat history and tool
results change between turns, so it is not a replacement for an inference allowance.
Do not cache tool execution itself.

Checked against the official documentation on October 22, 2026:
[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/),
[rate limits](https://developers.cloudflare.com/workers-ai/platform/limits/),
[GLM-4.7-Flash](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/),
[paid-model changes](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/),
[Chat Completions and tool-call fixes](https://developers.cloudflare.com/workers-ai/changelog/),
[AI Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/),
and [Groq rate limits](https://console.groq.com/docs/rate-limits).

## 5. The ceilings

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

### Backup and Disaster Recovery

For automated encrypted logical backups, point-in-time branch restores, and recovery rehearsal drills, follow the runbook in [neon-disaster-recovery.md](./neon-disaster-recovery.md).

---

## 6. Checking the deployment

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

# The plugin catalog answers from the API container.
docker compose --env-file .env -f infra/compose/docker-compose.managed.yml exec api \
  curl -sS -o /dev/null -w '%{http_code}\n' "$INTEGRATIONS_CATALOG_URL/api/search?q=notion"

# The space has a default model, so a conversation has something to answer with.
psql "$DATABASE_URL" -c 'SELECT c.provider, p."modelId" FROM space_model_preferences p JOIN user_model_credentials c ON c.id = p."credentialId" WHERE p."isDefault"'
```

The last one must report `rolbypassrls` as false. If it reports true, the runtime
login can read every tenant's rows and the deployment is not safe to open.

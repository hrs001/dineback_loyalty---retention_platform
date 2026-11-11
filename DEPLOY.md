# Deploying Loop for free

Four free-tier services, chosen for what this app actually needs — a replica-set
Mongo (Change Streams require one, even on Slice 0), Redis (BullMQ), and three
always-running Node processes (API, consumer, agent-worker), not just a static
frontend:

| Component | Provider | Free tier |
|---|---|---|
| MongoDB | [Atlas](https://www.mongodb.com/cloud/atlas/register) (M0) | Forever-free, and always a real replica set |
| Redis | [Upstash](https://console.upstash.com) | Forever-free, request-count capped |
| API + consumer + agent-worker | [Fly.io](https://fly.io) | Free allowance: 3 shared-cpu-1x 256MB VMs |
| Dashboard (Next.js) | [Vercel](https://vercel.com) | Forever-free for this traffic level |

All account creation and browser sign-in below is yours to do — these steps
can't be automated for you.

## 1. MongoDB Atlas

1. Create a free account, then a free **M0** cluster (any region).
2. Database Access → add a user with a generated password.
3. Network Access → allow access from anywhere (`0.0.0.0/0`) — fine for a
   demo with no real user data; tighten later if this becomes more than that.
4. Get the connection string (Connect → Drivers): it looks like
   `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/loop?retryWrites=true&w=majority`.
   Keep this — it's `MONGO_URI` below. Atlas clusters are always a replica
   set, so no `?replicaSet=rs0` needed, unlike local dev.

## 2. Upstash Redis

1. Create a free account, then a new Redis database (any region — pick one
   close to wherever Fly runs the compute, from step 3).
2. Copy the **TLS** connection URL (starts with `rediss://`, not `redis://`).
   This is `REDIS_URL` below.

## 3. Fly.io — API, consumer, agent-worker

`api/fly.toml` is already set up: one app, three process groups
(`api`/`consumer`/`agent-worker`) sharing `api/Dockerfile`'s image, mirroring
`docker-compose.yml`'s existing split. Only `api` is exposed over HTTP.

```bash
# Install the CLI, then sign in (opens a browser)
curl -L https://fly.io/install.sh | sh
fly auth login

cd api

# Claim the app name from fly.toml (skip if "loop-api" is taken — edit
# fly.toml's `app =` line to something unique first)
fly apps create loop-api-femimeduna

# Secrets are shared across all three process groups in this app
fly secrets set \
  MONGO_URI="mongodb+srv://<user>:<password>@<cluster>.mongodb.net/loop?retryWrites=true&w=majority" \
  REDIS_URL="rediss://<your-upstash-url>" \
  TENANT_STOREFRONT_KEYS="dev-storefront-key:rest_demo" \
  MARKETPLACE_WEBHOOK_SECRETS="rest_demo:dev-marketplace-secret" \
  TENANT_ADMIN_KEYS="dev-admin-key:rest_demo" \
  GEMINI_API_KEY="<your Gemini key>" \
  GEMINI_MODEL="gemini-flash-lite-latest" \
  PAGESPEED_API_KEY="<your PageSpeed Insights key>"

fly deploy

# fly deploy only starts the `api` process group by default (it's the one
# with a [[services]] block) — explicitly scale the other two to 1 machine each
fly scale count api=1 consumer=1 agent-worker=1
```

The `dev-*` key values above match what's hardcoded in the dashboard
(`dashboard/app/page.tsx`'s `STOREFRONT_KEY`/`ADMIN_KEY`) — this is Locked
Contract #9's documented Slice-0 stand-in for real auth, not a real secret,
so keeping the same values in both places is intentional, not a shortcut.

Check it's alive: `curl https://loop-api-femimeduna.fly.dev/health` should return
`{"status":"ok"}`. `fly logs` shows all three process groups interleaved —
`fly logs -a loop-api-femimeduna --process consumer` (or `agent-worker`) filters to one.

## 4. Vercel — dashboard

```bash
cd dashboard
npx vercel --prod
```

When prompted for environment variables (or after, in the Vercel dashboard's
Project Settings → Environment Variables), set:

```
NEXT_PUBLIC_API_URL=https://loop-api-femimeduna.fly.dev
```

Redeploy after setting it if you added it after the first deploy
(`npx vercel --prod` again).

## 5. Verify end-to-end

1. Open the Vercel URL. The top bar should show `rest_demo · live` (not
   stuck on `connecting`) — that's the dashboard's WebSocket reaching the
   Fly-hosted API.
2. Click "Place a demo order" — confirm it appears in the Order thread table
   and a real Gemini decision shows up in the Agent activity tooltip.
3. `fly logs -a loop-api-femimeduna --process consumer` should show `outbox-write` and
   `outbox event processed` lines for that order.

## Known limits at this tier

- Gemini's free tier is 500 requests/day per key — shared across whichever
  environment (local or deployed) makes the most recent calls, since it's
  keyed to the API key, not the host.
- PageSpeed Insights' anonymous quota is low; `PAGESPEED_API_KEY` (already
  wired above) raises it.
- Upstash's free tier is request-count capped, not unlimited.
- This is "good enough for a recruiter to click a link," not a production
  deploy — see README.md's "What I'd do differently at 10x scale" for the
  honest list of what's cut for demo scale.

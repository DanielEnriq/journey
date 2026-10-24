# DigitalOcean handoff: Vowe cloud API

Deploy the cloud API (`server/`) to DigitalOcean App Platform. Only the API runs on DigitalOcean. Electron, SQLite, Git and coding-agent execution stay on users' machines, and Supabase keeps auth, Postgres and Realtime. Do not migrate those.

## Source

| | |
|---|---|
| GitHub repository | `DanielEnriq/journey` |
| Deployment branch | `main` (`deploy_on_push: true`) |
| App spec | `.do/app.yaml` |
| Component | service `api`, built from `server/Dockerfile` with the repo root as build context |
| Port / health | `8080`, `GET /health` |

## Build and start

App Platform builds the Dockerfile. It doesn't use a buildpack, because the workspace root is the Electron app and its `postinstall` (electron-rebuild) must not run on the server.

```sh
# What the image does (from the repo root)
pnpm install --frozen-lockfile --filter vowe-api --ignore-scripts
pnpm --filter vowe-api build          # tsc → server/dist
node server/dist/index.js             # binds 0.0.0.0:$PORT

# Reproduce locally
docker build -f server/Dockerfile -t vowe-api .
docker run --rm -p 8080:8080 --env-file .env vowe-api
# or, without Docker
pnpm install && pnpm api:start
```

## Environment variables

All are `RUN_TIME`. Names are declared in `.do/app.yaml`. Values are never committed, so set them in the control panel. See `server/.env.example`.

| Name | Type | Source |
|---|---|---|
| `PORT` | plain (`8080`, already in spec) | |
| `SUPABASE_URL` | plain | Supabase → Settings → API |
| `SUPABASE_PUBLISHABLE_KEY` | plain | Supabase → Settings → API Keys (publishable, **not** secret/service_role) |
| `LIVEKIT_URL` | plain | `wss://<project>.livekit.cloud` |
| `LIVEKIT_API_KEY` | **SECRET** | LiveKit Cloud → Settings → API Keys |
| `LIVEKIT_API_SECRET` | **SECRET** | same |
| `ELEVENLABS_API_KEY` | **SECRET** | elevenlabs.io → Settings → API Keys |
| `ELEVENLABS_AGENT_ID` | plain | elevenlabs.io → Agents → agent page |

Use the same LiveKit project as the existing Supabase `livekit-token` Edge Function, so tokens from either source join the same rooms.

## DigitalOcean setup

1. Give DigitalOcean's GitHub app access to `DanielEnriq/journey` (Apps → Create → GitHub → manage access).
2. Create the app from the spec: `doctl apps create --spec .do/app.yaml`, or in the control panel, Create App → import `.do/app.yaml`.
3. Under App → Settings → `api` → Environment Variables, fill in every value above and mark the SECRET ones as Encrypt. Save, which redeploys.
4. Optional: change `region` / `instance_size_slug` in the spec, or add a custom domain under Settings → Domains.

Nothing else is required: no database, no Spaces, no workers.

## Verify

```sh
APP=https://<app>.ondigitalocean.app

curl -s $APP/health
# → {"status":"ok","livekit":true,"elevenlabs":true}   both true once the env vars are set

curl -s -o /dev/null -w '%{http_code}\n' -X POST $APP/livekit/token
# → 401  (auth is enforced; a real call needs a Supabase session)
```

Then end to end: in the desktop app's `.env`, set `VOWE_API_URL=$APP` (no trailing slash) and run `pnpm start`. Startup logs `[voice] ElevenLabs agent ready`. Then join a room's call: the token now comes from the API. Check the API's Runtime Logs for errors.

Rollback for the app: unset `VOWE_API_URL`. Calls fall back to the Supabase Edge Function.

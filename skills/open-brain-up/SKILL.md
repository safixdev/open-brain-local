---
name: open-brain-up
description: >-
  Install and start the dockerized Open Brain memory stack (Artifactory-as-SOT)
  for a team. Use when someone says "set up open brain", "open brain up", "start
  open brain", "deploy the memory server", "bring up the brain", or needs to
  stand up the MCP memory service against their own Artifactory. The team
  provides their Artifactory URL, access token, and memories repo name.
---

# Open Brain — Up (install & startup)

Bring the dockerized Open Brain stack online for a team. Artifactory is the
source of truth; Postgres+pgvector is a rebuildable search index synced from it.
The only model is the embedding model — **metadata comes from the calling agent**,
not a local chat model.

## Inputs the team MUST provide

Ask for these before doing anything (do not guess):

| Input | Example | Used for |
|---|---|---|
| `ARTIFACTORY_URL` | `https://acme.jfrog.io` | `jf` CLI server config |
| `ACCESS_TOKEN` | (identity token / API key) | `jf` auth (never commit) |
| `JF_SERVER_ID` | `acme` | which `jf` server to use |
| `RT_REPO` | `open-brain-memories` | generic-local repo holding memories |
| `GIT_USER` | `acme-platform` | fallback pusher identity on memories |

> The `RT_REPO` must already exist in Artifactory as a **generic local** repo.
> If it does not, the team must create it first.

## Prerequisites

- Docker Desktop or Rancher Desktop with Compose v2
- ~10 GB free disk (embedding model ~1.5 GB + images + DB), ~3 GB RAM
- Behind a TLS-intercepting corporate proxy? Have the corp CA PEM ready.

## 0. Already running? (idempotent check — do this first)

```bash
cd <repo>/docker
docker compose ps --status running | grep -q openbrain-server && echo "UP" || echo "DOWN"
```

If **UP**, hit the health check (step 5) and stop — do not rebuild.

## 1. Point the server at the team's Artifactory

The server reads the `jf` CLI config mounted from `docker/jfrog-config/`
(git-ignored). Generate it from the team's inputs:

```bash
cd <repo>/docker
JFROG_CLI_HOME_DIR="$PWD/jfrog-config" jf config add "$JF_SERVER_ID" \
  --url="$ARTIFACTORY_URL" --access-token="$ACCESS_TOKEN" --interactive=false
JFROG_CLI_HOME_DIR="$PWD/jfrog-config" jf config use "$JF_SERVER_ID"
# sanity: list the (empty) repo
JFROG_CLI_HOME_DIR="$PWD/jfrog-config" jf rt search "$RT_REPO/thoughts/*.json" --server-id "$JF_SERVER_ID"
```

## 2. Config files

```bash
cp .env.example .env
cp .env.secrets.example .env.secrets
# secrets:
openssl rand -hex 32   # -> MCP_ACCESS_KEY in .env.secrets
openssl rand -hex 32   # -> POSTGRES_PASSWORD in .env.secrets
```

Edit `.env` and set `JF_SERVER_ID`, `RT_REPO`, `GIT_USER`, and `PORT` (default
`8787`) to match the inputs above. `.env` / `.env.secrets` / `jfrog-config/` are
git-ignored — never commit them.

## 3. Corporate proxy (only if behind one)

Place the corp CA so the build can verify TLS to `registry.npmjs.org` /
`releases.jfrog.io`:

```bash
cp /path/to/corp-ca.pem docker/corp-ca.pem   # git-ignored (docker/*.pem)
```

## 4. Build & start

```bash
# With corp CA (proxy):
CA_CERT_FILE=./corp-ca.pem docker compose build server
# OR clean network:
docker compose build server

docker compose up -d
```

First run pulls the embedding model (~1.5 GB); the `server` waits for
`ollama-pull` to finish. Run the build/up step with a generous timeout
(`block_until_ms` ~180000) and watch:

```bash
docker compose logs -f ollama-pull
docker compose logs -f server   # expect: "Listening on http://0.0.0.0:8000/"
```

## 5. Verify (health + round trip)

```bash
KEY=$(grep MCP_ACCESS_KEY .env.secrets | cut -d= -f2)
PORT=$(grep -E '^PORT=' .env | cut -d= -f2); PORT=${PORT:-8787}
BASE="http://localhost:${PORT}"

# capture (agent supplies metadata)
curl -s -X POST "$BASE/" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H "x-brain-key: $KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"capture_thought","arguments":{"content":"open-brain-up smoke test","type":"observation","topics":["smoke-test"],"source":"user"}}}'

# search it back
curl -s -X POST "$BASE/" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H "x-brain-key: $KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_thoughts","arguments":{"query":"smoke test"}}}'
```

Expect `Captured as observation — smoke-test` then the thought returned by search.
Inspect what's in Artifactory at any time with the bundled helper:

```bash
RT_SERVER_ID=$JF_SERVER_ID RT_REPO=$RT_REPO bash skills/open-brain-up/list_rt_memories.sh
```

Clean up the smoke-test memory with the `delete_thought` tool (it tombstones for
an audit trail).

## 6. Wire up an MCP client

Point the client at `http://localhost:<PORT>/` with header `x-brain-key: <MCP_ACCESS_KEY>`.
The six tools appear: `capture_thought`, `delete_thought`, `search_thoughts`,
`search`, `fetch`, `list_thoughts`, `thought_stats`, `trigger_sync`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `build` hangs on `deno install`/`deno cache` | TLS proxy — rebuild with `CA_CERT_FILE=./corp-ca.pem` (step 3) |
| `jf` 401 / unauthorized in server logs | Bad/expired `ACCESS_TOKEN` — redo step 1, restart server |
| `[artifactory] base url : <unknown>` | Cosmetic only (probe regex) — ignore if capture works |
| `expected 1024 dimensions` | Wrong `EMBED_MODEL` — must be `mxbai-embed-large` |
| Memories not searchable after capture | Check `docker compose logs server` for `[autosync]` errors |
| Port already in use | Set a free `PORT=` in `.env`, `docker compose up -d` |

## Common ops

```bash
docker compose up -d            # start
docker compose down             # stop (keep data)
docker compose down -v          # stop + wipe pgvector (RT is still SOT; re-sync rebuilds)
docker compose logs -f server   # logs
```

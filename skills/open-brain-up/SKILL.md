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
The only model is the embedding model, served by **HuggingFace TEI** (a ~343 MB
Rust CPU server, OpenAI-compatible) — **metadata comes from the calling agent**,
not a local chat model.

Stack = 3 containers: `db` (pgvector), `tei` (embeddings), `server` (MCP).

## Fastest path — install from a prebuilt bundle (2 args)

If your `jf` CLI is already configured for the **same** Artifactory that holds the
bundle and the shared memories, use the bundled script — it needs only two
arguments and derives everything else (server, token, git user) from your jf
config and git:

```bash
./install_from_bundle.sh <BUNDLE_RT_PATH> <MEMORIES_REPO>
# e.g.
./install_from_bundle.sh generic-local/openbrain/openbrain-bundle-arm64.tar.gz open-brain-memories
```

It will: create `<MEMORIES_REPO>` (generic local) if missing → download + load the
image → generate the one-line `.env` (only `RT_REPO` + derived) → reuse your jf credentials for the container →
pre-fetch the embedding model if the CDN is blocked → `docker compose up -d
--no-build` → wait for health. Skip the manual steps below in this case.

## Inputs the team MUST provide (manual path)

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
- ~2 GB free disk: TEI image ~0.35 GB + embedding model ~0.67 GB + pgvector
  ~0.46 GB + server ~0.35 GB. Memories are tiny — ~10 MB per 1000. ~2 GB RAM.
- Behind a TLS-intercepting corporate proxy? Have the corp CA PEM ready, and
  note the **model pre-fetch** step below (proxies often block HF's CDN).
- Apple Silicon / arm64: set `TEI_IMAGE` to the `cpu-arm64-latest` tag in `.env`.

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
JFROG_CLI_HOME_DIR="$PWD/jfrog-config" jf rt search "$RT_REPO/*/thoughts/*.json" --server-id "$JF_SERVER_ID"
```

## 2. Config (one value — no `.env` templates, no `.env.secrets`)

The stack is self-contained: `docker-compose.yml` hardcodes every plumbing var
(`DB_*`, `LLM_*`, `EMBED_MODEL`, `DB_DRIVER`, …). The **only** real input is your
memories repo. Drop a one-line `.env` (compose auto-loads it for interpolation):

```bash
echo "RT_REPO=$RT_REPO" > .env
# only if your default jf server isn't 'intro':
echo "JF_SERVER_ID=$JF_SERVER_ID" >> .env
```

> The MCP endpoint has no auth and is bound to `127.0.0.1` only — it's a private
> per-developer service. Shared-memory access control lives in Artifactory (RT
> repo permissions + the access token), not on this port.

There is **no `.env.secrets`** and **no Postgres password**: the loopback-only DB
runs with trust auth (its port is never published; only the tei/server containers can
reach it). Optional overrides you may add to `.env`: `PORT` (default `8787`),
`GIT_USER` (provenance fallback), `OPENBRAIN_IMAGE` (prebuilt server ref), `TEI_IMAGE`
(arm64 tag). `.env` and `jfrog-config/` are git-ignored — never commit them.

## 3. Corporate proxy (only if behind one)

Place the corp CA so the build can verify TLS to `registry.npmjs.org` /
`releases.jfrog.io`:

```bash
cp /path/to/corp-ca.pem docker/corp-ca.pem   # git-ignored (docker/*.pem)
```

### 3a. Pre-fetch the embedding model (air-gapped / CDN-blocked networks)

TEI downloads the model from HuggingFace on first boot. Many corp proxies reach
`huggingface.co` but **block its CDN** (`*.hf.co` / `xethub`), so the in-container
download fails. If so, fetch the model on the host (which has the proxy + CA) and
mount it. From `docker/`:

```bash
mkdir -p tei-model/1_Pooling
BASE="https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1/resolve/main"
for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json \
         vocab.txt sentence_bert_config.json config_sentence_transformers.json \
         modules.json 1_Pooling/config.json model.safetensors; do
  curl -sSL -o "tei-model/$f" "$BASE/$f"
done
```

Then set `EMBED_MODEL=/model` in `.env` (the compose file mounts `tei-model/` at
`/model`). On open networks skip this and leave `EMBED_MODEL` as the HF id.

## 4. Start the server

Pick ONE of two distribution paths.

### Option B — prebuilt image (recommended)

The maintainer publishes the server image to your registry (see *Publishing*
below). Consumers never build or need the corp CA. In `.env` set:

```bash
OPENBRAIN_IMAGE=acme.jfrog.io/openbrain-docker/openbrain-mcp-server:v1.0.0
```

Then pull + start:

```bash
docker compose pull server
docker compose up -d --no-build
```

### Option A — build from source

Leave `OPENBRAIN_IMAGE` unset (image tags as `openbrain-mcp-server:local`):

```bash
# With corp CA (proxy):
CA_CERT_FILE=./corp-ca.pem docker compose build server
# OR clean network:
docker compose build server

docker compose up -d
```

On first run `tei` loads the embedding model (auto-downloaded, or from the
pre-fetched `tei-model/` mount). The `server` waits until `tei` is healthy. Watch:

```bash
docker compose logs -f tei      # expect: "Ready" and health → healthy
docker compose logs -f server   # expect: "Listening on http://0.0.0.0:8000/"
```

## 5. Verify (health + round trip)

```bash
PORT=$(grep -E '^PORT=' .env | cut -d= -f2); PORT=${PORT:-8787}
BASE="http://localhost:${PORT}"

# liveness
curl -s "$BASE/health"   # -> {"status":"ok"}

# capture (agent supplies metadata; endpoint has no auth, localhost-only)
curl -s -X POST "$BASE/" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"capture_memory","arguments":{"content":"open-brain-up smoke test","type":"observation","topics":["smoke-test"],"source":"user"}}}'

# search it back
curl -s -X POST "$BASE/" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_memories","arguments":{"query":"smoke test"}}}'
```

Expect `Captured as observation — smoke-test` then the thought returned by search.
Inspect what's in Artifactory at any time with the bundled helper:

```bash
RT_SERVER_ID=$JF_SERVER_ID RT_REPO=$RT_REPO bash skills/open-brain-up/list_rt_memories.sh
```

Clean up the smoke-test memory with the `delete_memory` tool (it tombstones for
an audit trail).

## 6. Wire up an MCP client

Point the client at `http://localhost:<PORT>/` (no auth header needed — the
endpoint is loopback-only). Four tools appear: `capture_memory`,
`search_memories`, `list_memories`, `delete_memory`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `build` hangs on `deno install`/`deno cache` | TLS proxy — rebuild with `CA_CERT_FILE=./corp-ca.pem` (step 3) |
| `tei` unhealthy, logs show CDN/`xethub` download error | Proxy blocks HF's CDN — pre-fetch the model (step 3a), set `EMBED_MODEL=/model` |
| `tei` `manifest unknown` on pull | arm64 host — set `TEI_IMAGE=...:cpu-arm64-latest` in `.env` |
| `jf` 401 / unauthorized in server logs | Bad/expired `ACCESS_TOKEN` — redo step 1, restart server |
| `[artifactory] base url : <unknown>` | Cosmetic only (probe regex) — ignore if capture works |
| `expected 1024 dimensions` | Wrong `EMBED_MODEL` — must be a 1024-dim model (mxbai-embed-large-v1) |
| Memories not searchable after capture | Check `docker compose logs server` for `[autosync]` errors |
| Port already in use | Set a free `PORT=` in `.env`, `docker compose up -d` |

## Common ops

```bash
docker compose up -d            # start
docker compose down             # stop (keep data)
docker compose down -v          # stop + wipe pgvector (RT is still SOT; re-sync rebuilds)
docker compose logs -f server   # logs
```

## Publishing (maintainer — option B, do once per release)

Build a multiarch server image and push it to the team's Artifactory Docker repo.
Consumers then only need `OPENBRAIN_IMAGE` (step 4, option B).

```bash
# one-time: a multiarch builder
docker buildx create --use --name obx --platform linux/amd64,linux/arm64

# log the Docker client into the registry (Artifactory Docker repo)
docker login acme.jfrog.io

# build + push (CA_CERT only needed behind a TLS proxy)
CA_CERT=corp-ca.pem \
IMAGE=acme.jfrog.io/openbrain-docker/openbrain-mcp-server TAG=v1.0.0 \
  docker buildx bake -f docker/docker-bake.hcl --push
```

Only the `server` image ships this way. `db` (pgvector/pgvector:pg16) and `tei`
(text-embeddings-inference) are public images compose pulls directly (or via your
mirror). Tag releases with a real version (`vN`), not `latest`, so deployments are
reproducible.

## Publishing (maintainer — offline bundle, for proxy/air-gapped teams)

When teammates are behind a TLS proxy that blocks the HF CDN (or are fully
air-gapped), ship a **fully offline bundle** instead: it `docker save`s all three
images and includes the embedding model weights, so the target host needs zero
registry/CDN egress at `up`.

```bash
cd docker
# prefetch the model once (host has the CA/proxy) into ./tei-model, then:
./build_bundle.sh                 # → dist/openbrain-bundle-offline-<arch>.tar.gz (~945 MB arm64)
jf rt upload dist/openbrain-bundle-offline-arm64.tar.gz \
  generic-local/openbrain/openbrain-bundle-offline-arm64.tar.gz --flat=true
# Ship the installer to the SAME global path so consumers don't need this repo cloned:
jf rt upload ../skills/open-brain-up/install_from_bundle.sh \
  generic-local/openbrain/install_from_bundle.sh --flat=true
```

These RT paths (bundle + installer) are **global, not per-git-repo** — one shared
location everyone pulls from. Memories live in one shared RT repo (`RT_REPO`) but are
**foldered per git repo**: `RT_REPO/<repo>/thoughts/<sha>.json`. `repo` is
required on every capture, so each project's memories are physically separated and
search is scoped to the caller's repo. A teammate in *any* project bootstraps with no
checkout.

The installer does **not assume** which Artifactory you're on. Specify the
connection explicitly (precedence top→bottom):

| How | Env vars | When |
|---|---|---|
| Register on the fly | `JF_URL` + `JF_ACCESS_TOKEN` (+ optional `JF_SERVER_ID`, default `openbrain`) | friend has no `jf` setup, or default points elsewhere |
| Use a configured server | `JF_SERVER_ID` | friend already has that server in `jf config` |
| Default server | _(none)_ | friend's default `jf` already points at the right RT |

Example — repo21 (entplus), no prior `jf` setup, team repo doubles as the
memories repo:

```bash
jf rt download openbrain-team-3/dist/install_from_bundle.sh . --flat=true
chmod +x install_from_bundle.sh
JF_URL=https://entplus.jfrog.io JF_ACCESS_TOKEN=<token> \
  ./install_from_bundle.sh openbrain-team-3/dist/openbrain-bundle-offline-arm64.tar.gz openbrain-team-3
```

(Drop the `JF_URL/JF_ACCESS_TOKEN` prefix if their default `jf` already points at
the right Artifactory; or use `JF_SERVER_ID=<id>` to pick a configured server.)

`install_from_bundle.sh` auto-detects the offline layout (an `images/` dir +
`IMAGE_TAG.txt` with `OFFLINE=1`): it loads every image, pins the exact `TEI_IMAGE`
/`OPENBRAIN_IMAGE`/`db` refs the bundle shipped, mounts the bundled model
(`EMBED_MODEL=/model`), and skips the CDN prefetch entirely. Build one bundle per
arch (`arm64`, `amd64`) — `docker save` is single-arch.

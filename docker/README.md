# Open Brain — Docker Compose Stack

Run Open Brain fully in containers: Postgres + pgvector, HuggingFace TEI (embeddings), and the MCP server. Artifactory is the source of truth for memories; pgvector is a rebuildable search index synced from it.

> Metadata (topics, type, people, …) is supplied by the **calling agent** via `capture_thought` — this stack runs **no chat model**. The only model is the embedding model.

> **Operators:** the canonical install/startup runbook is the `open-brain-up` skill (`skills/open-brain-up/`). This README is the reference; the skill is the procedure.

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) or [Rancher Desktop](https://rancherdesktop.io/) (Compose v2 plugin required)
- ~2 GB free disk: TEI image ~0.35 GB + embedding model ~0.67 GB + pgvector ~0.46 GB + server ~0.35 GB. Memories themselves are tiny (~10 MB per 1000).
- ~2 GB RAM available (peak during an active capture)
- Apple Silicon / arm64: set `TEI_IMAGE=ghcr.io/huggingface/text-embeddings-inference:cpu-arm64-latest` in `.env`

---

## Quickstart

### 1. Clone / enter the repo

```bash
git clone https://github.com/your-org/open-brain
cd open-brain
git checkout local-deploy-docker-no-supabase
```

### 2. Copy config files

```bash
cd docker
cp .env.example .env
cp .env.secrets.example .env.secrets
```

### 3. Set the secret in `.env.secrets`

```bash
openssl rand -hex 32   # paste as POSTGRES_PASSWORD
```

Edit `docker/.env.secrets`:
```
POSTGRES_PASSWORD=<your 64-hex password>
```

> The MCP endpoint has no auth and binds to `127.0.0.1` only — it's a private
> per-developer service. Shared-memory access control lives in Artifactory.

### 4. (Optional) Review non-secret config in `.env`

The defaults in `.env` work out of the box, but set these for your team:
- `EMBED_MODEL=mxbai-embed-large` — 1024-dim embedding model (the only model)
- `PORT=8787` — host port for the MCP server
- `JF_SERVER_ID` / `RT_REPO` — your Artifactory server-id and memories repo
- `GIT_USER` — fallback pusher identity recorded on memories

You must also provide Artifactory credentials for the `jf` CLI — see the
`open-brain-up` skill for the `jf config add` + mount step.

### 5. Start the stack

Two distribution paths for the `server` image:

**Option B — prebuilt image (recommended):** a maintainer pushes the image to
your registry (see the `open-brain-up` skill *Publishing* section). Set
`OPENBRAIN_IMAGE` in `.env` to the pushed ref, then:

```bash
docker compose pull server
docker compose up -d --no-build
```

**Option A — build from source:** leave `OPENBRAIN_IMAGE` unset.

```bash
docker compose build server   # add CA_CERT_FILE=./corp-ca.pem behind a TLS proxy
docker compose up -d
```

**On first run TEI loads the ~0.67 GB embedding model** (auto-downloaded from HuggingFace, or from a pre-fetched `tei-model/` mount on CDN-blocked networks — see the `open-brain-up` skill). The `server` waits until `tei` is healthy. Monitor progress:

```bash
docker compose logs -f tei      # expect "Ready" + health → healthy
docker compose logs -f server
```

---

## Smoke test

Once `server` is healthy, set your key and run:

```bash
PORT=$(grep -E '^PORT=' .env | cut -d= -f2); PORT=${PORT:-8787}
BASE="http://localhost:${PORT}"

# Liveness
curl -s "${BASE}/health"   # -> {"status":"ok"}

# Capture a thought (no auth header — endpoint is loopback-only)
curl -s -X POST "${BASE}/" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"capture_thought","arguments":{"content":"Docker smoke test from Open Brain"}}}'

# Search for it
curl -s -X POST "${BASE}/" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_thoughts","arguments":{"query":"docker smoke test"}}}'
```

Expected:
- Capture returns `"Captured as observation — ..."`
- Search returns the captured thought as a top result
- Re-capturing the same content deduplicates (upsert) rather than creating a duplicate

---

## Wire up an MCP client

### Claude Code

```bash
jq '.mcpServers["open-brain"] = {
  "type": "http",
  "url": "http://localhost:8787/"
}' ~/.claude.json > /tmp/.claude.json.new && mv /tmp/.claude.json.new ~/.claude.json
```

Restart Claude Code, then run `/mcp` — `open-brain` should appear with its four tools (`capture_thought`, `search_thoughts`, `list_thoughts`, `delete_thought`).

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "open-brain": {
      "type": "http",
      "url": "http://localhost:8787/"
    }
  }
}
```

Restart Claude Desktop.

---

## Resource expectations

| State | RAM |
|---|---|
| Stack idle (db + tei) | ~0.8 GB |
| Active capture/search | ~1.5 GB peak |

TEI keeps the model resident (no load/unload churn), so latency is steady.

---

## Common commands

```bash
# Start
docker compose up -d

# Stop (keep data)
docker compose down

# Stop and delete DB data (destructive)
docker compose down -v

# View logs
docker compose logs -f server

# Check service health
docker compose ps
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `server` exits immediately | Check `docker compose logs server` — likely missing env vars in `.env.secrets` |
| `tei` unhealthy with a CDN/`xethub` download error | Proxy blocks HF's CDN — pre-fetch the model and set `EMBED_MODEL=/model` (see `open-brain-up` skill) |
| `tei` pull fails with `manifest unknown` | arm64 host — set `TEI_IMAGE=...:cpu-arm64-latest` |
| `expected 1024 dimensions` error | Wrong `EMBED_MODEL` — must be a 1024-dim model (mxbai-embed-large-v1) matching the DB schema |
| `connection refused` from server to DB | DB healthcheck hasn't passed yet — wait and retry |
| Port 8787 already in use | Set a free `PORT=` in `docker/.env`, then `docker compose up -d` |

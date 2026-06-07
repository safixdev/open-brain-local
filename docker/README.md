# Open Brain — Docker Compose Stack

Run Open Brain fully in containers: Postgres + pgvector, Ollama (embeddings + chat), and the MCP server — no Supabase, no API keys, no cloud.

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) or [Rancher Desktop](https://rancherdesktop.io/) (Compose v2 plugin required)
- ~15 GB free disk (models: ~4 GB; images + DB: ~2 GB; headroom)
- ~4.5 GB RAM available (peak during an active capture)

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

### 3. Set secrets in `.env.secrets`

```bash
# Generate strong random values:
openssl rand -hex 32   # paste as MCP_ACCESS_KEY
openssl rand -hex 32   # paste as POSTGRES_PASSWORD
```

Edit `docker/.env.secrets`:
```
MCP_ACCESS_KEY=<your 64-hex key>
POSTGRES_PASSWORD=<your 64-hex password>
```

### 4. (Optional) Review non-secret config in `.env`

The defaults in `.env` work out of the box:
- `EMBED_MODEL=mxbai-embed-large` — 1024-dim embedding model
- `CHAT_MODEL=gemma3:4b` — metadata extraction model
- `PORT=8000` — host port for the MCP server

### 5. Start the stack

```bash
docker compose up -d
```

**First run downloads ~4 GB of Ollama models.** The `server` service waits until the `ollama-pull` one-shot completes, so it may take several minutes before the server is ready. Monitor progress:

```bash
docker compose logs -f ollama-pull
docker compose logs -f server
```

---

## Smoke test

Once `server` is healthy, set your key and run:

```bash
KEY=$(grep MCP_ACCESS_KEY .env.secrets | cut -d= -f2)
BASE="http://localhost:8000"

# Capture a thought
curl -s -X POST "${BASE}/?key=${KEY}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"capture_thought","arguments":{"content":"Docker smoke test from Open Brain"}}}'

# Search for it
curl -s -X POST "${BASE}/?key=${KEY}" \
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
  "url": "http://localhost:8000/?key=YOUR_MCP_ACCESS_KEY"
}' ~/.claude.json > /tmp/.claude.json.new && mv /tmp/.claude.json.new ~/.claude.json
```

Restart Claude Code, then run `/mcp` — `open-brain` should appear with all six tools.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "open-brain": {
      "type": "http",
      "url": "http://localhost:8000/?key=YOUR_MCP_ACCESS_KEY"
    }
  }
}
```

Restart Claude Desktop.

---

## Resource expectations

| State | RAM |
|---|---|
| Stack idle (db + ollama, no model loaded) | ~400 MB |
| Active capture (both models loaded) | ~4.5 GB peak |
| 5+ min idle (Ollama auto-unloads models) | ~500 MB |

RAM drops automatically after 5 minutes of inactivity as Ollama unloads models.

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
| Capture takes > 30 s on first run | Ollama is loading models into RAM — normal, subsequent calls are faster |
| `expected 1024 dimensions` error | Wrong `EMBED_MODEL` — must match the DB schema dim (1024 for mxbai-embed-large) |
| `connection refused` from server to DB | DB healthcheck hasn't passed yet — wait and retry |
| Port 8000 already in use | Set `PORT=8001` (or another free port) in `docker/.env` |

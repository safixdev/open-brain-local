# Open Brain Docker — Developer Guide

This document covers the `db.ts` seam, multiarch builds, testing, and optional integrations.

---

## Architecture: the `db.ts` seam

`server/db.ts` is a data-access seam that mirrors `server/llm.ts`. The driver is chosen at runtime by the `DB_DRIVER` environment variable:

| `DB_DRIVER` | Driver | Use case |
|---|---|---|
| `supabase` (default) | supabase-js client → PostgREST | Upstream cloud deploy |
| `postgres` | deno-postgres `Pool` → direct SQL | docker-compose / k8s |

Both drivers expose the same interface (`Db`):

```ts
db.matchThoughts(queryEmbedding, threshold, count, filter)
db.getThoughtById(id)
db.listThoughts({ limit, type, topic, person, days })
db.countThoughts()
db.allThoughtsMeta()
db.upsertThought(content, payload)
db.updateEmbedding(id, embedding)
```

The postgres driver calls the same SQL functions (`match_thoughts`, `upsert_thought`) that the supabase driver calls via RPC, so semantics are identical. `server/index.ts` calls `db.*` and is driver-agnostic.

**Upstream compatibility:** When `DB_DRIVER` is unset, the supabase driver is used — same behavior as before this seam was introduced. The postgres driver is only activated when `DB_DRIVER=postgres`.

---

## Running tests

```bash
cd server

# Export-shape tests (always pass, no live services needed)
deno test db_test.ts llm_test.ts --allow-env --allow-net

# Postgres integration tests (requires a running DB)
DB_DRIVER=postgres \
DB_HOST=localhost \
DB_PORT=5432 \
DB_NAME=openbrain \
DB_USER=postgres \
DB_PASSWORD=<your-pw> \
deno test db_test.ts --allow-env --allow-net

# Ollama integration tests (requires Ollama running on localhost:11434)
deno test llm_test.ts --allow-env --allow-net
```

---

## Multiarch build with `docker buildx bake`

The bake file builds `linux/amd64` + `linux/arm64` in one command.

### Prerequisites

A multiarch buildx builder (create once):
```bash
docker buildx create --use --name obx --platform linux/amd64,linux/arm64
```

### Build (local cache, no push)

```bash
# From repo root:
docker buildx bake -f docker/docker-bake.hcl

# With entitlements (Docker 29+):
docker buildx bake --allow=fs.read=$(pwd) -f docker/docker-bake.hcl
```

### Build and push to a registry

```bash
IMAGE=ghcr.io/yourorg/openbrain-mcp-server \
TAG=v1.0.0 \
docker buildx bake -f docker/docker-bake.hcl --push
```

### Tagging

Override `IMAGE` and `TAG` variables:
```bash
IMAGE=myregistry.com/openbrain TAG=main-abc1234 \
  docker buildx bake -f docker/docker-bake.hcl --push
```

---

## Embedding dimension constraint

The schema (`docker/init/01-init.sql`) declares `embedding vector(1024)` to match `mxbai-embed-large`. If you swap the embedding model, you **must** update both together:

1. Change `EMBED_MODEL` in `docker/.env`
2. Update the `vector(1024)` dimension in `01-init.sql` to match the new model's output size
3. Re-initialize the DB (delete the `db-data` volume and restart): `docker compose down -v && docker compose up -d`

Common models and their dimensions:
- `mxbai-embed-large` → 1024 (default)
- `nomic-embed-text` → 768
- `all-minilm` → 384
- `text-embedding-3-small` (OpenAI) → 1536

---

## Remote chat provider opt-in

`server/llm.ts` uses a single `LLM_BASE` for both embeddings and chat. The Ollama-only setup works out of the box. To route chat through a remote OpenAI-compatible provider while keeping Ollama for embeddings, you need a small split in `llm.ts` — documented here as a follow-up, **not yet implemented**.

When the split is implemented, the additional env vars would be:
```
CHAT_BASE=https://your-openai-compatible-endpoint/v1
CHAT_API_KEY=<api-key>
CHAT_MODEL=<model-name>
```

Until the split exists, using a remote provider requires pointing `LLM_BASE` at a single endpoint that serves both `/embeddings` and `/chat/completions`. Ollama does this; many hosted providers serve only chat, which is why the default keeps everything on Ollama.

---

## Local development with hot reload

For faster iteration without rebuilding the image:

```bash
# Start just db and ollama
docker compose up -d db ollama ollama-pull

# Wait for ollama-pull to finish, then run server on host:
cd server
DB_DRIVER=postgres \
DB_HOST=localhost DB_PORT=5432 DB_NAME=openbrain DB_USER=postgres DB_PASSWORD=<pw> \
LLM_BASE=http://localhost:11434/v1 LLM_API_KEY=ollama \
EMBED_MODEL=mxbai-embed-large CHAT_MODEL=gemma3:4b \
MCP_ACCESS_KEY=<key> \
deno run --allow-net --allow-env --allow-read --watch index.ts
```

(Expose Postgres from the compose stack: add `ports: ["5432:5432"]` to the `db` service in `docker-compose.yml` for local dev.)

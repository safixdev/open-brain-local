# LOCAL_DEPLOY — Running OB1 fully on your machine

> **This file describes a fork variant.** It only applies on the `local-deploy` branch. Upstream's `main` and the standard CLAUDE.md guardrail "MCP servers must be remote (Supabase Edge Functions)" still hold for upstream contributions; this branch is for personal use only.

This branch trades upstream's cloud-Supabase + OpenRouter design for a fully-local deployment:

- **Postgres + pgvector**: a local Supabase Docker stack (or any self-hosted Postgres with pgvector).
- **AI provider**: a local **Ollama** instance, no API keys, no cloud calls.
- **MCP server**: the upstream `server/index.ts`, run directly on the host with `deno run` (not inside Supabase's edge-runtime container).

The result is a fork that runs offline and costs $0/month.

---

## What this branch changes vs upstream

Five small, atomic commits on top of upstream `main`:

| # | Subject | What it does |
|---|---|---|
| 1 | `feat: extract LLM calls to server/llm.ts` | Pure refactor. Pulls `getEmbedding` and `extractMetadata` out of `server/index.ts` into a new `server/llm.ts` "seam." `index.ts` now imports them. **Zero behavior change** — this commit alone is upstream-PR-able. |
| 2 | `feat: parameterize LLM provider via env vars` | `server/llm.ts` reads `LLM_BASE`, `LLM_API_KEY`, `EMBED_MODEL`, `CHAT_MODEL` per-call. Defaults route to local Ollama at `http://host.docker.internal:11434/v1`. Same code can target OpenRouter, LM Studio, vLLM, etc. just by changing env vars. |
| 3 | `feat: inject current date into metadata extraction prompt` | Fixes year-drift on small local models (`gemma3:4b` resolves "December 15" to its training-cutoff year unless told today's date). Per-call `Today is YYYY-MM-DD (Weekday)` prepended to the system prompt. |
| 4 | `chore: pgvector 1024-dim for mxbai-embed-large` | Patches `vector(1536)` → `vector(1024)` in both the K8s `init.sql` and the embedded SQL inside `openbrain.yml` ConfigMap so the K8s integration stays self-consistent. |
| 5 | `fix: surface chat completion errors and remove dead UPSTREAM_SYSTEM_PROMPT` | Cleanup pass: `extractMetadata` now checks `r.ok` like `getEmbedding` does, and the `UPSTREAM_SYSTEM_PROMPT` export (unused after commit 3) is removed. |

The seam pattern in commit 1 keeps the merge surface tiny: upstream can rewrite the bodies of `getEmbedding` / `extractMetadata` freely without conflicting with us, because our `local-deploy` branch removed the import of those bodies. Conflicts only arise if upstream changes the *signatures* of those functions or their call sites.

> Commit 1 is a candidate to upstream as a PR — it makes OB1 provider-agnostic without changing default behavior. If accepted, the seam becomes part of OB1 itself and `local-deploy` shrinks to four commits.

### What this branch does NOT change

- The MCP server tool surface (`search`, `fetch`, `search_thoughts`, `list_thoughts`, `thought_stats`, `capture_thought`).
- The Hono / `StreamableHTTPTransport` plumbing.
- The deduplication design (`upsert_thought` Postgres function).
- Any extension, recipe, schema, or integration outside `server/`.

---

## Quickstart (M3 Mac with Rancher Desktop or Docker Desktop)

This recipe assumes you already have:
- Docker Desktop or Rancher Desktop running
- [Homebrew](https://brew.sh)
- This fork cloned and `local-deploy` branch checked out

### 1. Install host dependencies

```bash
brew install supabase/tap/supabase deno ollama
```

If you prefer the Ollama desktop app, install it from <https://ollama.com> — it auto-starts and binds to `0.0.0.0:11434`.

### 2. Pull the local AI models

```bash
ollama pull mxbai-embed-large gemma3:4b
```

Disk: ~4 GB total. RAM at peak (both loaded): ~4.5 GB. Auto-unloads after 5 min idle.

### 3. Initialize Supabase scaffolding

```bash
supabase init
```

This creates `supabase/config.toml` (gitignored). Edit it to:

- Set `[edge_runtime] enabled = false` (we run the function with bare Deno)
- Set `[realtime] enabled = false`, `[storage] enabled = false`, `[inbucket] enabled = false`, `[studio] enabled = false`, `[analytics] enabled = false` (OB1 doesn't need them; several fail to start on Rancher Desktop)
- If another Supabase project on this machine is already using ports 54321–54324, remap to a free range like 54421–54424 (`[api]`, `[db]`, `[db.pooler]`, `[studio]`, `[inbucket]`, `[analytics]` ports + `[db].shadow_port`)

### 4. Start the local Supabase stack

```bash
supabase start
```

First run pulls Docker images (~2–3 min). On success it prints `API URL` and `Secret` key — keep them, you'll need them in step 7.

Verify with `supabase status` and `docker ps --filter name=supabase` — should see `db`, `kong`, `auth`, `rest` healthy.

### 5. Apply the canonical schema with `vector(1024)`

The K8s `init.sql` is missing functions that the Edge Function calls (`upsert_thought`, `update_updated_at`, `content_fingerprint`). The complete schema lives inline in `docs/01-getting-started.md` (intended for paste-into-Supabase-Dashboard). Save the version below as `supabase/seed.sql` (gitignored), then apply it:

```sql
-- supabase/seed.sql — canonical schema with dim=1024
DROP FUNCTION IF EXISTS match_thoughts(vector, float, int, jsonb);
DROP FUNCTION IF EXISTS upsert_thought(text, jsonb);
DROP TABLE IF EXISTS thoughts CASCADE;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE thoughts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  content text NOT NULL,
  embedding vector(1024),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX ON thoughts USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON thoughts USING gin (metadata);
CREATE INDEX ON thoughts (created_at DESC);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER thoughts_updated_at
  BEFORE UPDATE ON thoughts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding vector(1024),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10,
  filter jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity float,
  created_at timestamptz
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT t.id, t.content, t.metadata,
         1 - (t.embedding <=> query_embedding) AS similarity,
         t.created_at
  FROM thoughts t
  WHERE 1 - (t.embedding <=> query_embedding) > match_threshold
    AND (filter = '{}'::jsonb OR t.metadata @> filter)
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS content_fingerprint TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_fingerprint
  ON thoughts (content_fingerprint)
  WHERE content_fingerprint IS NOT NULL;

CREATE OR REPLACE FUNCTION upsert_thought(p_content text, p_payload jsonb DEFAULT '{}')
RETURNS jsonb AS $$
DECLARE
  v_fingerprint text;
  v_id uuid;
BEGIN
  v_fingerprint := encode(sha256(convert_to(
    lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))),
    'UTF8'
  )), 'hex');

  INSERT INTO thoughts (content, content_fingerprint, metadata)
  VALUES (p_content, v_fingerprint, COALESCE(p_payload->'metadata', '{}'::jsonb))
  ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
  SET updated_at = now(),
      metadata = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$ LANGUAGE plpgsql;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.thoughts TO service_role;
GRANT EXECUTE ON FUNCTION match_thoughts(vector, float, int, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION upsert_thought(text, jsonb) TO service_role;
```

Apply (adjust the `-p 54422` to your actual db port if you didn't remap):

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54422 -U postgres -d postgres -f supabase/seed.sql
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54422 -U postgres -d postgres -c "NOTIFY pgrst, 'reload schema';"
```

The `NOTIFY` is required; without it PostgREST returns "Could not find the function public.upsert_thought" on the first capture.

### 6. Create the bare-Deno entry wrapper (untracked)

Upstream `server/index.ts` calls `Deno.serve(app.fetch)` which binds port 8000 by default. To pick a different port without modifying upstream code, save this as `server/dev-entry.ts` (gitignored — it's local-only):

```ts
// server/dev-entry.ts — local-only port-override wrapper. Untracked.
const PORT = Number(Deno.env.get("PORT")) || 8000;
const origServe = Deno.serve;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (...args: unknown[]) => {
  if (args.length === 1 && typeof args[0] === "function") {
    // deno-lint-ignore no-explicit-any
    return (origServe as any)({ port: PORT }, args[0]);
  }
  // deno-lint-ignore no-explicit-any
  return (origServe as any)(...args);
};
await import("./index.ts");
```

### 7. Write `.env`

```bash
openssl rand -hex 32   # save the output as MCP_ACCESS_KEY below
```

Then create `.env` in the repo root:

```
MCP_ACCESS_KEY=<paste the hex above>

# Local Supabase from `supabase status` (Kong API URL + Secret key)
SUPABASE_URL=http://127.0.0.1:54421
SUPABASE_SERVICE_ROLE_KEY=<paste the sb_secret_... from supabase status>

# Local Ollama (using localhost — we run on the host, not in a container)
LLM_BASE=http://localhost:11434/v1
LLM_API_KEY=ollama
EMBED_MODEL=mxbai-embed-large
CHAT_MODEL=gemma3:4b

# Listen port for the bare-Deno function (default 8000 conflicts on many setups)
PORT=8787
```

`.env` is already in upstream's `.gitignore`. Verify with `git check-ignore .env`.

### 8. Run the function

```bash
DENO_TLS_CA_STORE=system deno run --allow-net --allow-env --env-file=.env server/dev-entry.ts
```

`DENO_TLS_CA_STORE=system` is needed if you're behind a corporate TLS-intercepting proxy — it makes Deno trust the macOS keychain. Drop it otherwise.

Leave this terminal open. The function logs each request.

### 9. Smoke test

```bash
KEY=<your MCP_ACCESS_KEY>

# Auth check (should return 401)
curl -s -i http://localhost:8787/ | head -1

# Capture
curl -s -X POST "http://localhost:8787/?key=$KEY" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"capture_thought","arguments":{"content":"Smoke test from LOCAL_DEPLOY.md"}}}'

# Search
curl -s -X POST "http://localhost:8787/?key=$KEY" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_thoughts","arguments":{"query":"smoke test"}}}'
```

Expected: capture returns a `Captured as ...` summary; search returns the captured thought as a top result.

### 10. Wire up an MCP client

For Claude Code, edit `~/.claude.json`:

```bash
jq '.mcpServers["open-brain"] = {type:"http",url:"http://localhost:8787/?key=<your-MCP_ACCESS_KEY>"}' \
  ~/.claude.json > /tmp/.claude.json.new && mv /tmp/.claude.json.new ~/.claude.json
```

Quit and relaunch Claude Code. In a session, run `/mcp` to confirm `open-brain` shows up with all six tools.

For Claude Desktop, add the same entry to `~/Library/Application Support/Claude/claude_desktop_config.json` under `mcpServers`. Restart Claude Desktop.

---

## Restart procedure (after a reboot)

```bash
# Terminal 1 — Supabase stack
cd <fork-root> && supabase start

# Terminal 2 — Function
cd <fork-root> && DENO_TLS_CA_STORE=system deno run \
  --allow-net --allow-env --env-file=.env server/dev-entry.ts
```

Ollama Desktop runs persistently if installed as a desktop app; otherwise `ollama serve` in a third terminal.

---

## Maintaining the fork

Periodically pick up upstream improvements:

```bash
git fetch upstream
git checkout local-deploy
git rebase upstream/main
# Resolve any conflicts (usually none — see "Why the seam matters" below)
```

If you have a fork remote on github.com, `git push --force-with-lease origin local-deploy` after.

### Why the seam matters

Our five commits touch only:

- `server/llm.ts` (new file — upstream never touches this)
- `server/index.ts` — exactly one import line
- One number in two files for the schema dim (`init.sql` and `openbrain.yml`)

Conflicts only happen if upstream:

- Changes the signature of `getEmbedding` or `extractMetadata` (forces a matching update in `llm.ts`)
- Removes the import surface entirely (forces the import line to move)
- Changes the `thoughts` table column name (forces the schema commit to update)

Day-to-day churn inside the bodies of `getEmbedding` / `extractMetadata` does **not** conflict with us because the bodies aren't called anymore.

---

## Untracked vs tracked files

| Path | Tracked? | Purpose |
|---|---|---|
| `server/llm.ts`, `server/index.ts`, `server/llm_test.ts` | ✅ tracked | The 5 commits |
| `integrations/kubernetes-deployment/k8s/init.sql`, `openbrain.yml` | ✅ tracked | Schema dim patched in commit 4 |
| `LOCAL_DEPLOY.md` (this file) | ✅ tracked | The fork's documentation |
| `.env` | ❌ untracked | Secrets and local config. Already gitignored upstream. |
| `supabase/` (everything under it) | ❌ untracked | `supabase init` scaffolding. `supabase/` is in upstream `.gitignore`. |
| `server/dev-entry.ts` | ❌ untracked | Local-only port-override wrapper. |

If you ever clone the fork fresh, you'll need to recreate the untracked items. This file has the recipe.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Could not find the function public.upsert_thought in the schema cache` | PostgREST cached the old schema | `psql -c "NOTIFY pgrst, 'reload schema';"` |
| `expected 1024 dimensions, not N` on insert | Wrong embedding model active | Confirm `EMBED_MODEL=mxbai-embed-large` in `.env`; re-run `supabase/seed.sql` if the column type itself is wrong |
| `Embedding failed: connection refused` | Ollama not running | `ollama serve` or open the desktop app |
| `404 model not found` | Model not pulled | `ollama pull <model>` |
| `port is already allocated` on `supabase start` | Another Supabase project running on default ports | Remap in `supabase/config.toml`, see step 3 |
| Edge-runtime container fails on `deno.land/std` with `UnknownIssuer` | Corp TLS interception | Set `[edge_runtime] enabled = false` in `config.toml` and use bare `deno run` (steps 6–8). Add `DENO_TLS_CA_STORE=system` to all `deno` commands. |
| `mkdir /Users/.../.rd/docker.sock: operation not supported` | Rancher Desktop's docker socket path | Disable the failing service in `config.toml` (`storage`, `vector`, `realtime`, `studio`, `inbucket` are common offenders) |
| Function answers but `dates_mentioned` shows 2024 | Date prompt injection didn't take effect | Confirm commit 3 (`feat: inject current date into metadata extraction prompt`) is on `local-deploy` and you restarted the function after pulling it |
| 401 on capture but key looks right | Trailing newline in `MCP_ACCESS_KEY` | Re-paste cleanly without trailing whitespace |

---

## Resource cost (M3 Mac, 36 GB RAM reference)

| State | RAM |
|---|---|
| Supabase containers idle (4 services) | ~600 MB |
| Ollama daemon idle, no model loaded | ~50–100 MB |
| Active capture (both Ollama models loaded for ~1.7 s burst) | ~4.5 GB peak |
| 5+ min idle (Ollama auto-unloads, Supabase keeps running) | ~700 MB total |

Per capture: ~1.6 s of GPU activity at ~30–40 W. Fans don't engage at typical capture rates.

---

## Further reading (in the brain repo, not this fork)

If this fork was set up by following a planned implementation, the design notes and the executed plan live alongside it:

- Spec: `<brain-repo>/docs/superpowers/specs/2026-05-09-ob1-local-deploy-design.md` — full design rationale, model-selection benchmarks, real-world divergences from the original spec.
- Plan: `<brain-repo>/docs/superpowers/plans/2026-05-10-ob1-local-deploy.md` — task-by-task execution log with TDD breakdowns for each commit.
- Benchmarks: `<brain-repo>/bench/` — reproducible scripts for picking the embedding and chat models (`bench.mjs`, `embed_bench.mjs`, `date_bench.mjs`).

These are personal docs for the maintainer of *this* fork; they aren't part of upstream OB1.

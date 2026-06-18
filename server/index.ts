import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { getEmbedding } from "./llm.ts";
import { db } from "./db.ts";
import {
  artifactIdForContent,
  deleteArtifact,
  diffSince,
  fetchArtifact,
  listTombstones,
  liveSubPath,
  probeRtRoot,
  pushArtifact,
  pushTombstone,
  removeTombstone,
} from "./artifactory.ts";

// --- MCP Server Setup ---

const server = new McpServer({
  name: "open-brain",
  version: "1.0.0",
});

// search — semantic recall, repo-scoped by default.
server.registerTool(
  "search_memories",
  {
    title: "Search Memories",
    description:
      "Recall stored memories via semantic search. USE PROACTIVELY and FIRST — before answering or acting — whenever the request touches anything that could be remembered. Triggers (non-exhaustive): the user references prior context ('remember', 'recall', 'as we discussed', 'last time', 'previously', 'earlier', 'what did we decide', 'do we have', 'have we', 'did I/we', 'what do you know about'); asks you to VERIFY, check, confirm, or cross-reference against what's known; asks a question whose answer may depend on past decisions, conventions, preferences, identities, or project facts; or you're starting a task that could benefit from prior knowledge. When in doubt, search — a missed recall is worse than an empty result. Pass `repo` to scope to your current project; set `all_repos` for global recall.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
      repo: z
        .string()
        .optional()
        .describe("Scope results to memories captured in this git repo. Pass the repo you are currently working in so you don't surface memories from unrelated projects."),
      all_repos: z
        .boolean()
        .optional()
        .default(false)
        .describe("Search across ALL repos, ignoring `repo`. Use only when the user explicitly asks for cross-repo / global memory."),
    },
  },
  async ({ query, limit, threshold, repo, all_repos }) => {
    try {
      const qEmb = await getEmbedding(query);
      // Repo scoping: filter to the agent's current repo unless cross-repo is
      // explicitly requested. metadata @> {repo} is applied by match_thoughts.
      const filter = repo && !all_repos ? { repo } : {};
      const { data, error } = await db.matchThoughts(qEmb, threshold, limit, filter);

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
          isError: true,
        };
      }

      const scopeNote = repo && !all_repos ? ` in repo "${repo}"` : all_repos ? " across all repos" : "";

      if (!data || data.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No memories found matching "${query}"${scopeNote}.` }],
        };
      }

      const results = data.map(
        (
          t: { id: string; content: string; metadata: Record<string, unknown>; similarity: number; created_at: string },
          i: number
        ) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Type: ${m.type || "unknown"}`,
          ];
          if (Array.isArray(m.topics) && m.topics.length)
            parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          if (Array.isArray(m.people) && m.people.length)
            parts.push(`People: ${(m.people as string[]).join(", ")}`);
          if (Array.isArray(m.action_items) && m.action_items.length)
            parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${data.length} memory(ies)${scopeNote}:\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// list — browse recent memories with optional filters.
server.registerTool(
  "list_memories",
  {
    title: "List Recent Memories",
    description:
      "Browse recent memories (chronological), optionally filtered by type, topic, person, or last N days. Use when the user asks what's been remembered/captured lately ('what do we have', 'show recent notes', 'what have we saved'). For topical recall prefer `search_memories`.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z.string().optional().describe("Filter by type: observation, task, idea, reference, person_note"),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      days: z.number().optional().describe("Only memories from the last N days"),
    },
  },
  async ({ limit, type, topic, person, days }) => {
    try {
      const { data, error } = await db.listThoughts({ limit, type, topic, person, days });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || !data.length) {
        return { content: [{ type: "text" as const, text: "No memories found." }] };
      }

      const results = data.map(
        (
          t: { content?: string; metadata: Record<string, unknown>; created_at: string },
          i: number
        ) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${(t as { content?: string }).content ?? ""}`;
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `${data.length} recent memory(ies):\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// capture — save a memory. The agent owns the metadata (no server-side LLM).
server.registerTool(
  "capture_memory",
  {
    title: "Capture Memory",
    description:
      "Save a memory for later recall. USE PROACTIVELY whenever something durable and reusable surfaces. Triggers: the user says 'remember', 'note', 'keep in mind', 'for next time', 'don't forget', 'save this', 'make a note'; OR you learn a lasting fact worth not rediscovering — a decision + rationale, a project convention/constraint/architecture choice, a user preference or identity fact, or a non-obvious gotcha. Do NOT capture transient state, secrets/tokens, or trivially re-derivable detail. You own the metadata — pass `content` as a standalone statement plus `type`/`topics`/`people`/`repo` etc. Set `source` to 'user' (explicitly asked) or 'agent-inferred' (you captured it proactively). Server only embeds + stores.",
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      content: z.string().describe("The memory to capture — a clear, standalone statement that will make sense when retrieved later by any AI"),
      type: z
        .enum(["observation", "task", "idea", "reference", "person_note"])
        .optional()
        .describe("The kind of memory. Defaults to 'observation' if omitted."),
      topics: z.array(z.string()).optional().describe("1-3 short topic tags you assign to this memory."),
      people: z.array(z.string()).optional().describe("People mentioned in or relevant to this memory."),
      action_items: z.array(z.string()).optional().describe("Concrete to-dos implied by this memory."),
      dates_mentioned: z.array(z.string()).optional().describe("Absolute dates (YYYY-MM-DD) you resolved from the content."),
      source: z
        .string()
        .optional()
        .describe("Origin/trust of this memory: 'user' (the user asked to remember it), 'agent-inferred' (you captured it proactively), or another label. Defaults to 'mcp'."),
      git_user: z.string().optional().describe("Git username of the person/agent capturing this memory (e.g. from `git config user.name`). Falls back to the server default if omitted."),
      repo: z.string().describe("REQUIRED. The git repository this memory belongs to, e.g. 'context_as_artifacts'. Memories are stored and recalled per-repo, so always pass the repo you are working in."),
      context: z.string().optional().describe("Optional short note on the context/situation in which this was captured (e.g. the task or file being worked on)."),
    },
  },
  async ({ content, type, topics, people, action_items, dates_mentioned, source, git_user, repo, context }) => {
    try {
      if (!repo || !repo.trim()) {
        return {
          content: [{ type: "text" as const, text: "Error: `repo` is required — pass the git repo this memory belongs to." }],
          isError: true,
        };
      }
      // Metadata is supplied by the calling agent — no server-side LLM extraction.
      // Fall back to minimal defaults only for the structural fields.
      const metadata: Record<string, unknown> = {
        type: type ?? "observation",
        topics: topics && topics.length ? topics : ["uncategorized"],
        ...(people && people.length ? { people } : {}),
        ...(action_items && action_items.length ? { action_items } : {}),
        ...(dates_mentioned && dates_mentioned.length ? { dates_mentioned } : {}),
      };

      // Push to Artifactory (SOT). pgvector is populated exclusively via sync.
      const artifactId = await artifactIdForContent(content);
      await pushArtifact({
        id: artifactId,
        content,
        metadata: { ...metadata, source: source ?? "mcp", git_user, repo, context },
        created_at: new Date().toISOString(),
      });

      // Resurrect: drop any stale tombstone for this content so a re-captured
      // memory is not removed again by the tombstone-reconcile step.
      await removeTombstone(artifactId, repo);

      // Sync immediately so the new artifact lands in pgvector before we return.
      await runAutoSync();

      let confirmation = `Captured as ${metadata.type}`;
      const tags = metadata.topics as string[];
      if (tags.length) confirmation += ` — ${tags.join(", ")}`;
      if (people && people.length) confirmation += ` | People: ${people.join(", ")}`;
      if (action_items && action_items.length) confirmation += ` | Actions: ${action_items.join("; ")}`;

      return {
        content: [{ type: "text" as const, text: confirmation }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// delete — tombstone in Artifactory + drop from pgvector. Identify by id or content.
server.registerTool(
  "delete_memory",
  {
    title: "Delete Memory",
    description:
      "Delete a memory in a given `repo` by `id` (sha256) or exact `content`. Writes a durable tombstone in Artifactory (trace of what/when/who) so the deletion sticks across syncs, then removes it from pgvector.",
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: true,
      idempotentHint: true,
    },
    inputSchema: {
      repo: z
        .string()
        .describe("REQUIRED. The git repo the memory belongs to (memories are stored per-repo)."),
      id: z
        .string()
        .optional()
        .describe("The artifact id (sha256) of the memory to delete, e.g. from artifact_path '<repo>/thoughts/<id>.json'."),
      content: z
        .string()
        .optional()
        .describe("The exact memory content to delete (used to compute the artifact id when `id` is not given)."),
      git_user: z
        .string()
        .optional()
        .describe("Git username of who is deleting, recorded in the tombstone trace. Falls back to the server default."),
    },
  },
  async ({ repo, id, content, git_user }) => {
    try {
      if (!repo || !repo.trim()) {
        return {
          content: [{ type: "text" as const, text: "Error: `repo` is required to locate the memory." }],
          isError: true,
        };
      }
      let artId = id;
      if (!artId && content) artId = await artifactIdForContent(content);
      if (!artId) {
        return {
          content: [{ type: "text" as const, text: "Error: provide either `id` or `content`." }],
          isError: true,
        };
      }

      const subPath = liveSubPath(repo, artId);

      // Best-effort: fetch original content for the tombstone trace if not given.
      let original = content;
      if (!original) {
        try {
          original = (await fetchArtifact(subPath)).content;
        } catch {
          // Artifact may already be gone — tombstone without a snippet.
        }
      }

      // 1. Write the tombstone (trace). 2. Remove the live artifact. 3. Drop from pgvector.
      await pushTombstone(artId, repo, { git_user, content: original });
      await deleteArtifact(artId, repo).catch(() => {});
      const { data: removed } = await db.deleteByArtifactPath(subPath);

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Deleted memory ${artId.slice(0, 12)} from ${repo}. Removed ${removed ?? 0} row(s) from pgvector. ` +
              `Trace kept at ${subPath.replace(/\.json$/, ".deleted.json")}.`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Delete error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// --- Hono App (CORS only) ---
//
// There is intentionally NO endpoint auth here. The server is bound to loopback
// (see docker-compose `127.0.0.1:...`) and is a private, per-developer detail —
// sharing happens via Artifactory (the SOT), governed by RT repo permissions and
// the access token in jfrog-config. If you ever expose this on a network, add
// auth + TLS at an ingress; do not rely on this process for access control.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

const app = new Hono();

// Liveness probe (used by the container healthcheck). Must be declared before the
// catch-all so it isn't swallowed by the MCP transport handler.
app.get("/health", (c) => c.json({ status: "ok" }));

// CORS preflight — required for browser/Electron-based clients (Claude Desktop, claude.ai)
app.options("*", (c) => {
  return c.text("ok", 200, corsHeaders);
});

app.all("*", async (c) => {
  // Fix: Claude Desktop connectors don't send the Accept header that
  // StreamableHTTPTransport requires. Build a patched request if missing.
  // See: https://github.com/NateBJones-Projects/OB1/issues/33
  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore -- duplex required for streaming body in Deno
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

// --- Autosync: Artifactory → Postgres every 5 minutes ---
// The cursor advances after each successful run so only genuinely new Artifactory
// artifacts are fetched. It is persisted in Postgres (sync_state) and restored on
// startup, so a restart does not re-scan/re-download the entire repo. A fresh DB
// starts at epoch (safe — upsert_thought is idempotent; hasEmbedding skips
// re-embedding), then converges after the first run.

const AUTOSYNC_INTERVAL_MS = parseInt(
  Deno.env.get("AUTOSYNC_INTERVAL_MS") ?? String(5 * 60 * 1000),
);
const EPOCH = "1970-01-01T00:00:00.000Z";
let _syncCursor = EPOCH;
let _cursorLoaded = false;

// Restore the persisted cursor once, before the first sync runs.
async function loadCursor(): Promise<void> {
  if (_cursorLoaded) return;
  try {
    const { data, error } = await db.getSyncCursor();
    if (error) {
      console.error("[autosync] cursor load failed (starting at epoch):", error.message);
    } else if (data) {
      _syncCursor = data;
      console.log(`[autosync] cursor restored → ${_syncCursor.slice(0, 19)}`);
    }
  } catch (err) {
    console.error("[autosync] cursor load threw (starting at epoch):", (err as Error).message);
  }
  _cursorLoaded = true;
}

async function runAutoSync(): Promise<void> {
  await loadCursor();

  // Reconcile tombstones first (independent of the diff cursor — a tombstone can
  // target an artifact created long before the cursor). Any memory that has been
  // tombstoned in RT is removed from pgvector here, and skipped during indexing.
  let tombstonedIds = new Set<string>();
  try {
    const tombstones = await listTombstones();
    tombstonedIds = new Set(tombstones.map((t) => t.id));
    for (const t of tombstones) {
      // The live artifact sits next to the tombstone: same path, sans ".deleted".
      const livePath = t.path.replace(/\.deleted\.json$/, ".json");
      const { data: removed } = await db.deleteByArtifactPath(livePath);
      if (removed && removed > 0) {
        console.log(`[autosync] tombstone enforced — removed ${t.id.slice(0, 12)} from pgvector`);
      }
    }
  } catch (err) {
    console.error("[autosync] tombstone reconcile failed:", (err as Error).message);
  }

  const newArtifacts = await diffSince(_syncCursor);

  if (!newArtifacts.length) {
    console.log(`[autosync] up to date (cursor: ${_syncCursor.slice(0, 19)})`);
    return;
  }

  console.log(`[autosync] ${newArtifacts.length} new artifact(s) since ${_syncCursor.slice(0, 19)}`);

  for (const { path } of newArtifacts) {
    // Never index a tombstoned memory.
    const artId = path.split("/").pop()!.replace(/\.json$/, "");
    if (tombstonedIds.has(artId)) {
      console.log(`[autosync] skip tombstoned: ${artId.slice(0, 12)}`);
      continue;
    }
    try {
      const artifact = await fetchArtifact(path);

      const { data: upsertData, error: upsertErr } = await db.upsertThought(
        artifact.content,
        { metadata: { ...artifact.metadata, artifact_path: path } },
      );

      if (upsertErr || !upsertData) {
        console.error(`[autosync] upsert failed for ${path}:`, upsertErr?.message);
        continue;
      }

      const { data: alreadyEmbedded } = await db.hasEmbedding(upsertData.id);
      if (alreadyEmbedded) {
        console.log(`[autosync] skip embed (already present): ${artifact.content.slice(0, 60)}`);
        continue;
      }

      const embedding = await getEmbedding(artifact.content);
      await db.updateEmbedding(upsertData.id, embedding);
      console.log(`[autosync] embedded: ${artifact.content.slice(0, 60)}`);
    } catch (err) {
      console.error(`[autosync] error on ${path}:`, (err as Error).message);
    }
  }

  // Advance cursor to now — next run fetches only artifacts created after this
  // point — and persist it so a restart resumes here instead of re-scanning all.
  _syncCursor = new Date().toISOString();
  const { error: saveErr } = await db.setSyncCursor(_syncCursor);
  if (saveErr) console.error("[autosync] cursor persist failed:", saveErr.message);
  console.log(`[autosync] cursor → ${_syncCursor.slice(0, 19)}`);
}

// Fire immediately on startup, then on the configured interval.
runAutoSync().catch((e) =>
  console.error("[autosync] startup sync failed:", (e as Error).message)
);
setInterval(
  () =>
    runAutoSync().catch((e) =>
      console.error("[autosync] interval sync failed:", (e as Error).message)
    ),
  AUTOSYNC_INTERVAL_MS,
);
console.log(`[autosync] started — interval ${AUTOSYNC_INTERVAL_MS / 1000}s`);
probeRtRoot().catch((e) =>
  console.error("[artifactory] probe failed:", (e as Error).message)
);

Deno.serve(app.fetch);

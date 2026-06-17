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
  probeRtRoot,
  pushArtifact,
  pushTombstone,
  removeTombstone,
} from "./artifactory.ts";

const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const CITATION_BASE_URL =
  Deno.env.get("OPEN_BRAIN_CITATION_BASE_URL") || "https://openbrain.local/thoughts";

function thoughtTitle(content: string, createdAt?: string): string {
  const firstLine = content.replace(/\s+/g, " ").trim().slice(0, 80);
  const datePrefix = createdAt ? new Date(createdAt).toLocaleDateString() : "Open Brain";
  return firstLine ? `${datePrefix} - ${firstLine}` : `${datePrefix} thought`;
}

function thoughtUrl(id: string): string {
  return `${CITATION_BASE_URL.replace(/\/$/, "")}/${id}`;
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "open-brain",
  version: "1.0.0",
});

// ChatGPT compatibility: restricted connector surfaces, company knowledge, and deep
// research look for exact read-only `search` and `fetch` tool shapes.
server.registerTool(
  "search",
  {
    title: "Search Open Brain",
    description:
      "Search Open Brain memories by meaning. Use this read-only compatibility tool when ChatGPT needs search/fetch-style access to stored thoughts.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      query: z.string().describe("The search query to run against Open Brain thoughts"),
    },
  },
  async ({ query }) => {
    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await db.matchThoughts(qEmb, 0.5, 10, {});

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
          isError: true,
        };
      }

      const results = ((data || []) as { id: string; content: string; created_at: string }[]).map(
        (t) => ({
          id: t.id,
          title: thoughtTitle(t.content, t.created_at),
          url: thoughtUrl(t.id),
        })
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ results }) }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "fetch",
  {
    title: "Fetch Open Brain Thought",
    description:
      "Fetch one Open Brain thought by ID after using search. Use this read-only compatibility tool to retrieve the full text and metadata for citation.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      id: z.string().describe("The Open Brain thought ID returned by the search tool"),
    },
  },
  async ({ id }) => {
    try {
      const { data, error } = await db.getThoughtById(id);

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Fetch error: ${error.message}` }],
          isError: true,
        };
      }

      const thought = data!;
      const document = {
        id: thought.id,
        title: thoughtTitle(thought.content, thought.created_at),
        text: thought.content,
        url: thoughtUrl(thought.id),
        metadata: {
          ...thought.metadata,
          created_at: thought.created_at,
          updated_at: thought.updated_at,
        },
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(document) }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 1: Semantic Search
server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description:
      "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
    },
  },
  async ({ query, limit, threshold }) => {
    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await db.matchThoughts(qEmb, threshold, limit, {});

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || data.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
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
            text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}`,
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

// Tool 2: List Recent
server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description:
      "List recently captured thoughts with optional filters by type, topic, person, or time range.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z.string().optional().describe("Filter by type: observation, task, idea, reference, person_note"),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      days: z.number().optional().describe("Only thoughts from the last N days"),
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
        return { content: [{ type: "text" as const, text: "No thoughts found." }] };
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
            text: `${data.length} recent thought(s):\n\n${results.join("\n\n")}`,
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

// Tool 3: Stats
server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {},
  },
  async () => {
    try {
      const { data: count } = await db.countThoughts();
      const { data } = await db.allThoughtsMeta();

      const types: Record<string, number> = {};
      const topics: Record<string, number> = {};
      const people: Record<string, number> = {};

      for (const r of data || []) {
        const m = (r.metadata || {}) as Record<string, unknown>;
        if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
        if (Array.isArray(m.topics))
          for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
        if (Array.isArray(m.people))
          for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
      }

      const sort = (o: Record<string, number>): [string, number][] =>
        Object.entries(o)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

      const lines: string[] = [
        `Total thoughts: ${count}`,
        `Date range: ${
          data?.length
            ? new Date(data[data.length - 1].created_at).toLocaleDateString() +
              " → " +
              new Date(data[0].created_at).toLocaleDateString()
            : "N/A"
        }`,
        "",
        "Types:",
        ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
      ];

      if (Object.keys(topics).length) {
        lines.push("", "Top topics:");
        for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
      }

      if (Object.keys(people).length) {
        lines.push("", "People mentioned:");
        for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 4: Capture Thought
server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description:
      "Save a new memory to the Open Brain. YOU (the calling agent) own the metadata: extract it yourself and pass it in — the server does NOT run any LLM to infer it. Write `content` as a clear, standalone statement that will make sense out of context later. Set `type`, `topics`, `people`, `action_items`, and `dates_mentioned` (absolute YYYY-MM-DD) from your understanding of the conversation. Set `source` to 'user' when the user explicitly asked to remember something, or 'agent-inferred' when you are proactively capturing a durable fact you noticed. The server only generates the embedding (for search) and stores the artifact.",
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
      repo: z.string().optional().describe("The git repository the memory was captured in, e.g. 'context_as_artifacts'."),
      context: z.string().optional().describe("Optional short note on the context/situation in which this was captured (e.g. the task or file being worked on)."),
    },
  },
  async ({ content, type, topics, people, action_items, dates_mentioned, source, git_user, repo, context }) => {
    try {
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
      await removeTombstone(artifactId);

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

// Tool 5: Delete Thought
server.registerTool(
  "delete_thought",
  {
    title: "Delete Thought",
    description:
      "Delete a captured memory. Writes a tombstone to Artifactory (a durable trace of what was deleted, when, and by whom), removes the live artifact, and deletes the memory from the local pgvector index. The tombstone makes the deletion stick across future syncs and other clients. Identify the memory by its artifact id (sha256, shown as artifact_path 'thoughts/<id>.json' / by list_rt_memories) or by its exact content.",
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: true,
      idempotentHint: true,
    },
    inputSchema: {
      id: z
        .string()
        .optional()
        .describe("The artifact id (sha256) of the memory to delete, e.g. from artifact_path 'thoughts/<id>.json'."),
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
  async ({ id, content, git_user }) => {
    try {
      let artId = id;
      if (!artId && content) artId = await artifactIdForContent(content);
      if (!artId) {
        return {
          content: [{ type: "text" as const, text: "Error: provide either `id` or `content`." }],
          isError: true,
        };
      }

      // Best-effort: fetch original content for the tombstone trace if not given.
      let original = content;
      if (!original) {
        try {
          original = (await fetchArtifact(`thoughts/${artId}.json`)).content;
        } catch {
          // Artifact may already be gone — tombstone without a snippet.
        }
      }

      // 1. Write the tombstone (trace). 2. Remove the live artifact. 3. Drop from pgvector.
      await pushTombstone(artId, { git_user, content: original });
      await deleteArtifact(artId).catch(() => {});
      const { data: removed } = await db.deleteByArtifactPath(`thoughts/${artId}.json`);

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Deleted memory ${artId.slice(0, 12)}. Removed ${removed ?? 0} row(s) from pgvector. ` +
              `Trace kept at thoughts/${artId}.deleted.json.`,
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

// Tool 6: Trigger Sync
server.registerTool(
  "trigger_sync",
  {
    title: "Trigger Artifactory Sync",
    description:
      "Manually trigger a sync from Artifactory into Open Brain. Fetches all artifacts created since the last sync cursor and embeds any new ones. Use when you want to pull in new artifacts immediately rather than waiting for the next scheduled sync.",
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: {
      reset_cursor: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, reset the sync cursor to epoch and re-sync all artifacts from the beginning"),
    },
  },
  async ({ reset_cursor }) => {
    try {
      if (reset_cursor) {
        _syncCursor = "1970-01-01T00:00:00.000Z";
        console.log("[trigger_sync] cursor reset to epoch");
      }

      const cursorBefore = _syncCursor;
      await runAutoSync();
      const cursorAfter = _syncCursor;

      const advanced = cursorAfter !== cursorBefore;
      return {
        content: [
          {
            type: "text" as const,
            text: advanced
              ? `Sync complete. Cursor advanced from ${cursorBefore.slice(0, 19)} → ${cursorAfter.slice(0, 19)}.`
              : `Sync complete. Already up to date (cursor: ${cursorBefore.slice(0, 19)}).`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Sync error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// --- Hono App with Auth + CORS ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

const app = new Hono();

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
// In-memory cursor: advances after each successful run so only genuinely new
// Artifactory artifacts are fetched. Resets to epoch on server restart (safe —
// upsert_thought is idempotent; hasEmbedding skips re-embedding).

const AUTOSYNC_INTERVAL_MS = parseInt(
  Deno.env.get("AUTOSYNC_INTERVAL_MS") ?? String(5 * 60 * 1000),
);
let _syncCursor = "1970-01-01T00:00:00.000Z";

async function runAutoSync(): Promise<void> {
  // Reconcile tombstones first (independent of the diff cursor — a tombstone can
  // target an artifact created long before the cursor). Any memory that has been
  // tombstoned in RT is removed from pgvector here, and skipped during indexing.
  let tombstonedIds = new Set<string>();
  try {
    const tombstones = await listTombstones();
    tombstonedIds = new Set(tombstones.map((t) => t.id));
    for (const t of tombstones) {
      const { data: removed } = await db.deleteByArtifactPath(`thoughts/${t.id}.json`);
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

  // Advance cursor to now — next run fetches only artifacts created after this point.
  _syncCursor = new Date().toISOString();
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

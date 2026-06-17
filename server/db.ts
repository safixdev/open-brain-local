// server/db.ts
// Data-access seam for Open Brain.
// Driver is chosen by DB_DRIVER env var (default "supabase").
//   supabase  — wraps supabase-js client (upstream default, no behavior change)
//   postgres  — deno-postgres Pool talking directly to Postgres (docker/k8s deploy)

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "postgres";

// ── Shared types ─────────────────────────────────────────────────────────────

export type ThoughtMatch = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
  created_at: string;
};

export type ThoughtRecord = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at?: string | null;
};

export type ThoughtMeta = {
  metadata: Record<string, unknown>;
  created_at: string;
};

// ── Result shape (mirrors supabase-js so index.ts stays consistent) ──────────

export type DbResult<T> = { data: T | null; error: { message: string } | null };

// ── DB interface ─────────────────────────────────────────────────────────────

export interface Db {
  matchThoughts(
    queryEmbedding: number[],
    threshold: number,
    count: number,
    filter: Record<string, unknown>,
  ): Promise<DbResult<ThoughtMatch[]>>;

  getThoughtById(id: string): Promise<DbResult<ThoughtRecord>>;

  listThoughts(opts: {
    limit: number;
    type?: string;
    topic?: string;
    person?: string;
    days?: number;
  }): Promise<DbResult<ThoughtMeta[]>>;

  countThoughts(): Promise<DbResult<number>>;

  allThoughtsMeta(): Promise<DbResult<ThoughtMeta[]>>;

  upsertThought(
    content: string,
    payload: Record<string, unknown>,
  ): Promise<DbResult<{ id: string }>>;

  updateEmbedding(id: string, embedding: number[]): Promise<DbResult<null>>;

  hasEmbedding(id: string): Promise<DbResult<boolean>>;

  // Remove every local row whose metadata.artifact_path matches. Used to enforce
  // RT tombstones — returns the number of rows deleted.
  deleteByArtifactPath(artifactPath: string): Promise<DbResult<number>>;
}

// ── Supabase driver ──────────────────────────────────────────────────────────

function makeSupabaseDb(): Db {
  // Defer client construction to first call so that importing db.ts
  // in a test environment (DB_DRIVER != supabase) does not throw.
  let _client: SupabaseClient | null = null;
  function sb(): SupabaseClient {
    if (!_client) {
      const url = Deno.env.get("SUPABASE_URL")!;
      const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      _client = createClient(url, key);
    }
    return _client;
  }

  return {
    async matchThoughts(queryEmbedding, threshold, count, filter) {
      const { data, error } = await sb().rpc("match_thoughts", {
        query_embedding: queryEmbedding,
        match_threshold: threshold,
        match_count: count,
        filter,
      });
      return { data: data as ThoughtMatch[] | null, error };
    },

    async getThoughtById(id) {
      const { data, error } = await sb()
        .from("thoughts")
        .select("id, content, metadata, created_at, updated_at")
        .eq("id", id)
        .single();
      return { data: data as ThoughtRecord | null, error };
    },

    async listThoughts({ limit, type, topic, person, days }) {
      let q = sb()
        .from("thoughts")
        .select("content, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (type) q = q.contains("metadata", { type });
      if (topic) q = q.contains("metadata", { topics: [topic] });
      if (person) q = q.contains("metadata", { people: [person] });
      if (days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("created_at", since.toISOString());
      }

      const { data, error } = await q;
      return { data: data as ThoughtMeta[] | null, error };
    },

    async countThoughts() {
      const { count, error } = await sb()
        .from("thoughts")
        .select("*", { count: "exact", head: true });
      return { data: count, error };
    },

    async allThoughtsMeta() {
      const { data, error } = await sb()
        .from("thoughts")
        .select("metadata, created_at")
        .order("created_at", { ascending: false });
      return { data: data as ThoughtMeta[] | null, error };
    },

    async upsertThought(content, payload) {
      const { data, error } = await sb().rpc("upsert_thought", {
        p_content: content,
        p_payload: payload,
      });
      return { data: data as { id: string } | null, error };
    },

    async updateEmbedding(id, embedding) {
      const { error } = await sb()
        .from("thoughts")
        .update({ embedding })
        .eq("id", id);
      return { data: null, error };
    },

    async hasEmbedding(id) {
      const { data, error } = await sb()
        .from("thoughts")
        .select("embedding")
        .eq("id", id)
        .single();
      return { data: data ? data.embedding !== null : false, error };
    },

    async deleteByArtifactPath(artifactPath) {
      const { error, count } = await sb()
        .from("thoughts")
        .delete({ count: "exact" })
        .eq("metadata->>artifact_path", artifactPath);
      return { data: count ?? 0, error };
    },
  };
}

// ── Postgres driver ──────────────────────────────────────────────────────────

function makePostgresDb(): Db {
  const pool = new Pool(
    {
      hostname: Deno.env.get("DB_HOST") || "127.0.0.1",
      port: parseInt(Deno.env.get("DB_PORT") || "5432", 10),
      database: Deno.env.get("DB_NAME") || "openbrain",
      user: Deno.env.get("DB_USER") || "postgres",
      // DB_PASSWORD is the app-specific name; fall back to POSTGRES_PASSWORD so a
      // single secret can drive both the Postgres image and this client.
      password: Deno.env.get("DB_PASSWORD") || Deno.env.get("POSTGRES_PASSWORD")!,
    },
    10,
  );

  function embStr(embedding: number[]): string {
    return `[${embedding.join(",")}]`;
  }

  return {
    async matchThoughts(queryEmbedding, threshold, count, filter) {
      const client = await pool.connect();
      try {
        const filterJson = JSON.stringify(filter);
        const result = await client.queryObject<ThoughtMatch>(
          `SELECT id::text, content, metadata, similarity, created_at
           FROM match_thoughts($1::vector, $2, $3, $4::jsonb)`,
          [embStr(queryEmbedding), threshold, count, filterJson],
        );
        return { data: result.rows, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      } finally {
        client.release();
      }
    },

    async getThoughtById(id) {
      const client = await pool.connect();
      try {
        const result = await client.queryObject<ThoughtRecord>(
          `SELECT id::text, content, metadata, created_at, updated_at
           FROM thoughts WHERE id = $1 LIMIT 1`,
          [id],
        );
        const row = result.rows[0] ?? null;
        const error = row ? null : { message: `No thought found for ID ${id}` };
        return { data: row, error };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      } finally {
        client.release();
      }
    },

    async listThoughts({ limit, type, topic, person, days }) {
      const client = await pool.connect();
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (type) {
          conditions.push(`metadata->>'type' = $${idx++}`);
          params.push(type);
        }
        if (topic) {
          conditions.push(`metadata->'topics' ? $${idx++}`);
          params.push(topic);
        }
        if (person) {
          conditions.push(`metadata->'people' ? $${idx++}`);
          params.push(person);
        }
        if (days) {
          conditions.push(`created_at >= NOW() - INTERVAL '${Math.floor(days)} days'`);
        }

        const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
        const result = await client.queryObject<ThoughtMeta>(
          `SELECT content, metadata, created_at
           FROM thoughts ${where}
           ORDER BY created_at DESC
           LIMIT $${idx}`,
          [...params, limit],
        );
        return { data: result.rows, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      } finally {
        client.release();
      }
    },

    async countThoughts() {
      const client = await pool.connect();
      try {
        const result = await client.queryObject<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM thoughts",
        );
        return { data: result.rows[0]?.count ?? 0, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      } finally {
        client.release();
      }
    },

    async allThoughtsMeta() {
      const client = await pool.connect();
      try {
        const result = await client.queryObject<ThoughtMeta>(
          "SELECT metadata, created_at FROM thoughts ORDER BY created_at DESC",
        );
        return { data: result.rows, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      } finally {
        client.release();
      }
    },

    async upsertThought(content, payload) {
      const client = await pool.connect();
      try {
        const result = await client.queryObject<{ id: string }>(
          `SELECT (upsert_thought($1, $2::jsonb))->>'id' AS id`,
          [content, JSON.stringify(payload)],
        );
        const row = result.rows[0] ?? null;
        return { data: row, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      } finally {
        client.release();
      }
    },

    async updateEmbedding(id, embedding) {
      const client = await pool.connect();
      try {
        await client.queryObject(
          `UPDATE thoughts SET embedding = $1::vector WHERE id = $2`,
          [embStr(embedding), id],
        );
        return { data: null, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      } finally {
        client.release();
      }
    },

    async hasEmbedding(id) {
      const client = await pool.connect();
      try {
        const result = await client.queryObject<{ has_embedding: boolean }>(
          `SELECT (embedding IS NOT NULL) AS has_embedding FROM thoughts WHERE id = $1`,
          [id],
        );
        return { data: result.rows[0]?.has_embedding ?? false, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      } finally {
        client.release();
      }
    },

    async deleteByArtifactPath(artifactPath) {
      const client = await pool.connect();
      try {
        const result = await client.queryObject(
          `DELETE FROM thoughts WHERE metadata->>'artifact_path' = $1`,
          [artifactPath],
        );
        return { data: result.rowCount ?? 0, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      } finally {
        client.release();
      }
    },
  };
}

// ── Factory ───────────────────────────────────────────────────────────────────

const driver = Deno.env.get("DB_DRIVER") ?? "supabase";

export const db: Db = driver === "postgres" ? makePostgresDb() : makeSupabaseDb();

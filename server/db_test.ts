// server/db_test.ts
// Smoke tests: verify the db seam exports the expected surface.
// Integration tests against a live Postgres are gated on DB_DRIVER=postgres
// and a DB_PASSWORD being set — they are skipped (not failed) otherwise.
//
// Run with:
//   deno test db_test.ts
//
// For integration tests against docker-compose:
//   DB_DRIVER=postgres DB_HOST=localhost DB_PORT=5432 DB_NAME=openbrain \
//   DB_USER=postgres DB_PASSWORD=<pw> deno test db_test.ts

import { assertEquals, assertExists } from "@std/assert";
import { db } from "./db.ts";

// ── Export-shape tests (always run) ─────────────────────────────────────────

Deno.test("db.ts exports matchThoughts as a function", () => {
  assertEquals(typeof db.matchThoughts, "function");
});

Deno.test("db.ts exports getThoughtById as a function", () => {
  assertEquals(typeof db.getThoughtById, "function");
});

Deno.test("db.ts exports listThoughts as a function", () => {
  assertEquals(typeof db.listThoughts, "function");
});

Deno.test("db.ts exports countThoughts as a function", () => {
  assertEquals(typeof db.countThoughts, "function");
});

Deno.test("db.ts exports allThoughtsMeta as a function", () => {
  assertEquals(typeof db.allThoughtsMeta, "function");
});

Deno.test("db.ts exports upsertThought as a function", () => {
  assertEquals(typeof db.upsertThought, "function");
});

Deno.test("db.ts exports updateEmbedding as a function", () => {
  assertEquals(typeof db.updateEmbedding, "function");
});

// ── Postgres integration tests (gated) ───────────────────────────────────────

const pgEnabled =
  Deno.env.get("DB_DRIVER") === "postgres" && !!Deno.env.get("DB_PASSWORD");

Deno.test({
  name: "postgres: countThoughts returns a non-negative integer",
  ignore: !pgEnabled,
  async fn() {
    const { data, error } = await db.countThoughts();
    assertEquals(error, null);
    assertExists(data);
    assertEquals(typeof data, "number");
    assertEquals(data >= 0, true);
  },
});

Deno.test({
  name: "postgres: upsertThought returns an id string",
  ignore: !pgEnabled,
  async fn() {
    const { data, error } = await db.upsertThought(
      "db_test.ts integration: upsert smoke test",
      { metadata: { type: "observation", topics: ["test"], source: "db_test" } },
    );
    assertEquals(error, null);
    assertExists(data);
    assertExists(data!.id);
    assertEquals(typeof data!.id, "string");
    assertEquals(data!.id.length > 0, true);
  },
});

Deno.test({
  name: "postgres: listThoughts returns an array",
  ignore: !pgEnabled,
  async fn() {
    const { data, error } = await db.listThoughts({ limit: 5 });
    assertEquals(error, null);
    assertExists(data);
    assertEquals(Array.isArray(data), true);
  },
});

Deno.test({
  name: "postgres: allThoughtsMeta returns an array with metadata fields",
  ignore: !pgEnabled,
  async fn() {
    const { data, error } = await db.allThoughtsMeta();
    assertEquals(error, null);
    assertExists(data);
    assertEquals(Array.isArray(data), true);
    if (data!.length > 0) {
      assertExists(data![0].metadata);
      assertExists(data![0].created_at);
    }
  },
});

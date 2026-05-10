// server/llm_test.ts
// Smoke tests: verify the seam exports the expected surface.
// Behavior tests against a live provider come in a later commit.
//
// Run with `DENO_TLS_CA_STORE=system` if you're behind a corporate
// TLS-intercepting proxy; that flag tells Deno to trust certs in
// the system keychain (e.g. macOS Keychain).

import { assertEquals, assertExists } from "jsr:@std/assert";
import { getEmbedding, extractMetadata } from "./llm.ts";

Deno.test("llm.ts exports getEmbedding as a function", () => {
  assertEquals(typeof getEmbedding, "function");
});

Deno.test("llm.ts exports extractMetadata as a function", () => {
  assertEquals(typeof extractMetadata, "function");
});

// Integration test: getEmbedding actually hits Ollama and returns a vector.
// Requires Ollama running on localhost:11434 with mxbai-embed-large pulled.
Deno.test({
  name: "getEmbedding returns a 1024-dim vector from local Ollama",
  async fn() {
    Deno.env.set("LLM_BASE", "http://localhost:11434/v1");
    Deno.env.set("LLM_API_KEY", "ollama");
    Deno.env.set("EMBED_MODEL", "mxbai-embed-large");

    const v = await getEmbedding("hello world");

    assertEquals(Array.isArray(v), true);
    assertEquals(v.length, 1024);
    assertEquals(typeof v[0], "number");
  },
});

// Integration test: extractMetadata returns a JSON object with the expected
// keys, using the upstream prompt (Task 5 will change the prompt).
Deno.test({
  name: "extractMetadata returns the expected JSON shape from local Ollama",
  async fn() {
    Deno.env.set("LLM_BASE", "http://localhost:11434/v1");
    Deno.env.set("LLM_API_KEY", "ollama");
    Deno.env.set("CHAT_MODEL", "gemma3:4b");

    const m = await extractMetadata("Coffee with Sarah about Q3 mobile launch.");

    assertExists(m.topics);
    assertEquals(Array.isArray(m.topics), true);
    assertEquals((m.topics as string[]).length >= 1, true);
    assertExists(m.type);
    assertEquals(typeof m.type, "string");
  },
});

// extractMetadata should resolve "December 15" with the current year.
// (We only check the YEAR — day-of-week math can still be wrong;
//  see spec risks section.)
Deno.test({
  name: "extractMetadata resolves dates to the current year",
  async fn() {
    Deno.env.set("LLM_BASE", "http://localhost:11434/v1");
    Deno.env.set("LLM_API_KEY", "ollama");
    Deno.env.set("CHAT_MODEL", "gemma3:4b");

    const thisYear = new Date().getFullYear().toString();
    const m = await extractMetadata("Mom's birthday is December 15. Need to book the restaurant.");

    const dates = (m.dates_mentioned as string[] | undefined) ?? [];
    assertEquals(dates.length >= 1, true, "Expected at least one date");
    assertEquals(
      dates.some((d) => d.startsWith(thisYear)),
      true,
      `Expected at least one date starting with ${thisYear}, got: ${JSON.stringify(dates)}`,
    );
  },
});

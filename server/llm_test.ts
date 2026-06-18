// server/llm_test.ts
// Smoke tests: verify the seam exports the expected surface.
// Behavior tests against a live provider come in a later commit.
//
// Run with `DENO_TLS_CA_STORE=system` if you're behind a corporate
// TLS-intercepting proxy; that flag tells Deno to trust certs in
// the system keychain (e.g. macOS Keychain).

import { assertEquals } from "jsr:@std/assert";
import { getEmbedding } from "./llm.ts";

Deno.test("llm.ts exports getEmbedding as a function", () => {
  assertEquals(typeof getEmbedding, "function");
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

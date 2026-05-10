// server/llm_test.ts
// Smoke tests: verify the seam exports the expected surface.
// Behavior tests against a live provider come in a later commit.
//
// Run with `DENO_TLS_CA_STORE=system` if you're behind a corporate
// TLS-intercepting proxy; that flag tells Deno to trust certs in
// the system keychain (e.g. macOS Keychain).

import { assertEquals, assertExists } from "jsr:@std/assert";
import { getEmbedding, extractMetadata, UPSTREAM_SYSTEM_PROMPT } from "./llm.ts";

Deno.test("llm.ts exports getEmbedding as a function", () => {
  assertEquals(typeof getEmbedding, "function");
});

Deno.test("llm.ts exports extractMetadata as a function", () => {
  assertEquals(typeof extractMetadata, "function");
});

Deno.test("llm.ts exports UPSTREAM_SYSTEM_PROMPT as a non-empty string", () => {
  assertExists(UPSTREAM_SYSTEM_PROMPT);
  assertEquals(typeof UPSTREAM_SYSTEM_PROMPT, "string");
  assertEquals(UPSTREAM_SYSTEM_PROMPT.length > 0, true);
});

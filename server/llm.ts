// server/llm.ts
// Local-deploy seam: embedding calls flow through this file.
// Provider is selected via env vars; defaults target local Ollama on the host.
//
// Note: there is no chat/LLM metadata extraction here. The calling agent
// (Claude/Cursor/etc.) owns metadata and passes it to capture_thought directly.
// The only model this stack runs is the embedding model.

export async function getEmbedding(text: string): Promise<number[]> {
  const base = Deno.env.get("LLM_BASE") ?? "http://host.docker.internal:11434/v1";
  const key = Deno.env.get("LLM_API_KEY") ?? "ollama";
  const model = Deno.env.get("EMBED_MODEL") ?? "mxbai-embed-large";

  const r = await fetch(`${base}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: text }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`Embedding failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

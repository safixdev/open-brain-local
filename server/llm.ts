// server/llm.ts
// Local-deploy seam: all LLM provider calls flow through this file.
// Provider is selected via env vars; defaults target local Ollama on the host.

export const UPSTREAM_SYSTEM_PROMPT = `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`;

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

export async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const base = Deno.env.get("LLM_BASE") ?? "http://host.docker.internal:11434/v1";
  const key = Deno.env.get("LLM_API_KEY") ?? "ollama";
  const model = Deno.env.get("CHAT_MODEL") ?? "gemma3:4b";

  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: UPSTREAM_SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

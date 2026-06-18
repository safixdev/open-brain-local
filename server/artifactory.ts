// server/artifactory.ts
// JFrog CLI-backed Artifactory client for Open Brain artifact SOT write-path.
//
// All operations shell out to `jf rt` commands — no raw HTTP, no API key env vars.
// The machine must have `jf` installed and configured (`jf config show` lists servers).
//
// Env vars:
//   JF_SERVER_ID  — jf server ID to use (default: "intro")
//   RT_REPO       — generic local repo name (default: "open-brain-memories")
//
// Artifact path convention inside the repo — memories are foldered per git repo for
// a clear separation when browsing RT:
//   <repo>/thoughts/<sha256-of-content>.json
//   <repo>/thoughts/<sha256-of-content>.deleted.json   (tombstone)
//
// Artifact payload (JSON) — embedding excluded, re-generated on sync:
//   { id, content, metadata, created_at }

const JF_SERVER_ID = Deno.env.get("JF_SERVER_ID") ?? "intro";
const RT_REPO = Deno.env.get("RT_REPO") ?? "open-brain-memories";

// Folder (within RT_REPO) that holds a given git repo's memories. Sanitised so an
// arbitrary repo name is a safe single path segment.
export function repoFolder(repo: string): string {
  const safe = repo.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!safe) throw new Error("repo is required to locate memories");
  return safe;
}

// Live artifact sub-path for a memory in a given repo.
export function liveSubPath(repo: string, id: string): string {
  return `${repoFolder(repo)}/thoughts/${id}.json`;
}

export type ThoughtArtifact = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

// jf search result item shape
type JfSearchItem = {
  path: string;      // e.g. "open-brain-memories/thoughts/abc123.json"
  created: string;   // ISO 8601
  name: string;
  repo: string;
};

// Deno.Command does not inherit the shell PATH, so jf at /opt/homebrew/bin
// is invisible unless we pass it explicitly.
// In Docker: jf is installed at /usr/local/bin/jf via Dockerfile.
// On a dev host: override with JF_PATH env var (e.g. /opt/homebrew/bin/jf).
const JF_PATH = Deno.env.get("JF_PATH") ?? "/usr/local/bin/jf";
const ENRICHED_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  Deno.env.get("PATH") ?? "",
].join(":");

async function runJf(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command(JF_PATH, {
    args: [...args, "--server-id", JF_SERVER_ID],
    stdout: "piped",
    stderr: "piped",
    env: {
      PATH: ENRICHED_PATH,
      HOME: Deno.env.get("HOME") ?? "/home/deno",
      USER: Deno.env.get("USER") ?? "deno",
      TMPDIR: Deno.env.get("TMPDIR") ?? "/tmp",
    },
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout).trim(),
    stderr: new TextDecoder().decode(stderr).trim(),
  };
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The artifact id for a piece of content is the SHA-256 of the content.
// Same content → same id → same artifact path (idempotent capture & delete).
export function artifactIdForContent(content: string): Promise<string> {
  return sha256Hex(content);
}

// Print the resolved RT repo root to stdout so teammates can verify they share
// the same path. Shells out to `jf config show` to surface the base URL.
export async function probeRtRoot(): Promise<void> {
  let baseUrl = "<unknown>";
  try {
    const cmd = new Deno.Command(JF_PATH, {
      args: ["config", "show", "--server-id", JF_SERVER_ID],
      stdout: "piped",
      stderr: "piped",
      env: { PATH: ENRICHED_PATH, HOME: Deno.env.get("HOME") ?? "" },
    });
    const { stdout } = await cmd.output();
    const raw = new TextDecoder().decode(stdout).trim();
    // `jf config show` emits JSON; extract url field
    const match = raw.match(/"url"\s*:\s*"([^"]+)"/);
    if (match) baseUrl = match[1].replace(/\/$/, "");
  } catch {
    // jf not installed or server not configured — still print what we know
  }
  console.log(`[artifactory] server-id : ${JF_SERVER_ID}`);
  console.log(`[artifactory] base url  : ${baseUrl}`);
  console.log(`[artifactory] repo root : ${baseUrl}/${RT_REPO}/<repo>/thoughts/`);
}

// Push a thought artifact to Artifactory via `jf rt upload`.
// Returns the artifact sub-path within the repo (e.g. "<repo>/thoughts/<sha256>.json").
// Idempotent: same content → same SHA-256 → same path.
//
// RT properties written on each artifact (enables AQL listing without downloads):
//   content    — URL-encoded first 200 chars of text
//   context    — URL-encoded optional free-form capture context (omitted if empty)
//   source     — metadata.source or "mcp"
//   git_user   — git username of the pusher (arg → GIT_USER env → USER env → "unknown")
//   user_id    — mirror of git_user, kept for mem0 cross-compatibility
//   repo       — git repository the memory was captured in (omitted if empty)
//   type       — metadata.type or "thought"
//   topics     — comma-separated list, max 5
//   created_at — ISO timestamp of capture (queryable; mirrors RT's own created field)
//   tombstone  — always "false" on creation
export async function pushArtifact(thought: ThoughtArtifact): Promise<string> {
  const m = thought.metadata as Record<string, unknown>;
  const repo = m.repo ? String(m.repo) : "";
  if (!repo) throw new Error("repo is required to capture a memory");

  const hash = await sha256Hex(thought.content);
  const subPath = liveSubPath(repo, hash);
  const remotePath = `${RT_REPO}/${subPath}`;

  const topics = Array.isArray(m.topics)
    ? (m.topics as string[]).slice(0, 5).join(",")
    : "";
  const gitUser = String(
    m.git_user ?? m.user_id ?? Deno.env.get("GIT_USER") ?? Deno.env.get("USER") ?? "unknown",
  );
  const context = m.context ? String(m.context) : "";
  const propsStr = [
    `content=${encodeURIComponent(thought.content.slice(0, 200))}`,
    ...(context ? [`context=${encodeURIComponent(context.slice(0, 200))}`] : []),
    `source=${String(m.source ?? "mcp")}`,
    `git_user=${encodeURIComponent(gitUser)}`,
    `user_id=${encodeURIComponent(gitUser)}`,
    ...(repo ? [`repo=${encodeURIComponent(repo)}`] : []),
    `type=${String(m.type ?? "thought")}`,
    ...(topics ? [`topics=${topics}`] : []),
    `created_at=${encodeURIComponent(thought.created_at)}`,
    `tombstone=false`,
  ].join(";");

  const tmpFile = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(tmpFile, JSON.stringify(thought, null, 2));
    const { code, stderr } = await runJf([
      "rt", "upload", tmpFile, remotePath,
      `--target-props=${propsStr}`,
    ]);
    if (code !== 0) throw new Error(`jf rt upload failed: ${stderr}`);
    return subPath;
  } finally {
    await Deno.remove(tmpFile).catch(() => {});
  }
}

// List all live thought artifacts in the repo, sorted by created asc.
// Tombstone markers (*.deleted.json) are excluded — they are not thoughts.
export async function listArtifacts(): Promise<{ path: string; created: string }[]> {
  const { code, stdout, stderr } = await runJf([
    "rt", "search",
    `${RT_REPO}/*/thoughts/*.json`,
  ]);
  if (code !== 0) throw new Error(`jf rt search failed: ${stderr}`);
  if (!stdout || stdout === "[]") return [];

  const items: JfSearchItem[] = JSON.parse(stdout);
  return items
    .filter((item) => !item.path.endsWith(".deleted.json"))
    .map((item) => ({
      path: item.path.replace(`${RT_REPO}/`, ""),
      created: item.created,
    }))
    .sort((a, b) => a.created.localeCompare(b.created));
}

export type Tombstone = { id: string; path: string; created: string };

// List all tombstone markers (deleted memories). The id is the artifact id of
// the memory that was deleted (filename is "<id>.deleted.json").
export async function listTombstones(): Promise<Tombstone[]> {
  const { code, stdout, stderr } = await runJf([
    "rt", "search",
    `${RT_REPO}/*/thoughts/*.deleted.json`,
  ]);
  if (code !== 0) throw new Error(`jf rt search (tombstones) failed: ${stderr}`);
  if (!stdout || stdout === "[]") return [];

  const items: JfSearchItem[] = JSON.parse(stdout);
  return items.map((item) => {
    const name = item.path.split("/").pop()!;
    return {
      id: name.replace(/\.deleted\.json$/, ""),
      path: item.path.replace(`${RT_REPO}/`, ""),
      created: item.created,
    };
  });
}

// Write a tombstone for a deleted memory. Keeps a durable trace in Artifactory:
// who deleted it, when, and a snippet of the original content. Sync honours
// tombstones by removing the matching memory from pgvector.
export async function pushTombstone(
  id: string,
  repo: string,
  trace: { git_user?: string; content?: string } = {},
): Promise<string> {
  const subPath = `${repoFolder(repo)}/thoughts/${id}.deleted.json`;
  const remotePath = `${RT_REPO}/${subPath}`;
  const deletedAt = new Date().toISOString();
  const deletedBy = trace.git_user ?? Deno.env.get("GIT_USER") ?? Deno.env.get("USER") ?? "unknown";
  const snippet = (trace.content ?? "").slice(0, 200);

  const tombstone = {
    memory_id: id,
    tombstone: true,
    deleted_at: deletedAt,
    deleted_by: deletedBy,
    original_content: snippet,
  };
  const props = [
    `tombstone=true`,
    `memory_id=${id}`,
    `deleted_at=${encodeURIComponent(deletedAt)}`,
    `git_user=${encodeURIComponent(deletedBy)}`,
    ...(snippet ? [`content=${encodeURIComponent(snippet)}`] : []),
  ].join(";");

  const tmpFile = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(tmpFile, JSON.stringify(tombstone, null, 2));
    const { code, stderr } = await runJf([
      "rt", "upload", tmpFile, remotePath,
      `--target-props=${props}`,
    ]);
    if (code !== 0) throw new Error(`jf rt upload (tombstone) failed: ${stderr}`);
    return subPath;
  } finally {
    await Deno.remove(tmpFile).catch(() => {});
  }
}

// Delete the live artifact for a memory (the "<id>.json" file). Best-effort.
export async function deleteArtifact(id: string, repo: string): Promise<void> {
  const remotePath = `${RT_REPO}/${liveSubPath(repo, id)}`;
  const { code, stderr } = await runJf(["rt", "delete", remotePath, "--quiet"]);
  if (code !== 0) throw new Error(`jf rt delete failed: ${stderr}`);
}

// Remove a tombstone, e.g. to resurrect a memory that is being re-captured.
// Best-effort: a missing tombstone is not an error.
export async function removeTombstone(id: string, repo: string): Promise<void> {
  const remotePath = `${RT_REPO}/${repoFolder(repo)}/thoughts/${id}.deleted.json`;
  await runJf(["rt", "delete", remotePath, "--quiet"]).catch(() => {});
}

// Return artifacts created strictly after `sinceIso`.
// Filters client-side from the full list — Artifactory AQL date filtering
// via jf CLI requires a spec file; simpler to filter after a lightweight search.
export async function diffSince(sinceIso: string): Promise<{ path: string; created: string }[]> {
  const all = await listArtifacts();
  return all.filter(({ created }) => created > sinceIso);
}

// Fetch a single artifact by sub-path and return its parsed content.
export async function fetchArtifact(subPath: string): Promise<ThoughtArtifact> {
  const tmpDir = await Deno.makeTempDir();
  try {
    const { code, stderr } = await runJf([
      "rt", "download",
      `${RT_REPO}/${subPath}`,
      `${tmpDir}/`,
      "--flat=true",    // download directly into tmpDir, no nested subdirs
    ]);
    if (code !== 0) throw new Error(`jf rt download failed: ${stderr}`);

    const fileName = subPath.split("/").pop()!;
    const raw = await Deno.readTextFile(`${tmpDir}/${fileName}`);
    return JSON.parse(raw) as ThoughtArtifact;
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

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
// Artifact path convention inside the repo:
//   thoughts/<sha256-of-content>.json
//
// Artifact payload (JSON) — embedding excluded, re-generated on sync:
//   { id, content, metadata, created_at }

const JF_SERVER_ID = Deno.env.get("JF_SERVER_ID") ?? "intro";
const RT_REPO = Deno.env.get("RT_REPO") ?? "open-brain-memories";

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
  console.log(`[artifactory] repo root : ${baseUrl}/${RT_REPO}/thoughts/`);
}

// Push a thought artifact to Artifactory via `jf rt upload`.
// Returns the artifact sub-path within the repo (e.g. "thoughts/<sha256>.json").
// Idempotent: same content → same SHA-256 → same path.
export async function pushArtifact(thought: ThoughtArtifact): Promise<string> {
  const hash = await sha256Hex(thought.content);
  const subPath = `thoughts/${hash}.json`;
  const remotePath = `${RT_REPO}/${subPath}`;

  const tmpFile = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(tmpFile, JSON.stringify(thought, null, 2));
    const { code, stderr } = await runJf(["rt", "upload", tmpFile, remotePath]);
    if (code !== 0) throw new Error(`jf rt upload failed: ${stderr}`);
    return subPath;
  } finally {
    await Deno.remove(tmpFile).catch(() => {});
  }
}

// List all thought artifacts in the repo, sorted by created asc.
export async function listArtifacts(): Promise<{ path: string; created: string }[]> {
  const { code, stdout, stderr } = await runJf([
    "rt", "search",
    `${RT_REPO}/thoughts/*.json`,
  ]);
  if (code !== 0) throw new Error(`jf rt search failed: ${stderr}`);
  if (!stdout || stdout === "[]") return [];

  const items: JfSearchItem[] = JSON.parse(stdout);
  return items
    .map((item) => ({
      path: item.path.replace(`${RT_REPO}/`, ""),
      created: item.created,
    }))
    .sort((a, b) => a.created.localeCompare(b.created));
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

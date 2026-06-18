#!/usr/bin/env bash
# install_from_bundle.sh — bring up the Open Brain MCP server from a prebuilt bundle.
#
# Points at the Artifactory that holds the bundle AND the shared memories. The
# connection is NOT assumed: specify it explicitly, or fall back to your default.
#
# Usage:
#   ./install_from_bundle.sh <BUNDLE_RT_PATH> <MEMORIES_REPO>
#
# Example:
#   ./install_from_bundle.sh openbrain-team-3/dist/openbrain-bundle-offline-arm64.tar.gz openbrain-team-3
#
# Param 1  BUNDLE_RT_PATH  Artifactory path to the bundle tarball.
# Param 2  MEMORIES_REPO   Generic local repo for memories. Created if missing.
#
# Specify the Artifactory connection (pick ONE; precedence top→bottom):
#   JF_URL + JF_ACCESS_TOKEN   register a server on the fly (no prior jf setup needed).
#                              optional JF_SERVER_ID names it (default: openbrain).
#   JF_SERVER_ID               use an already-configured `jf` server by id.
#   (nothing)                  use your current default `jf` server.
#
# Examples:
#   JF_URL=https://entplus.jfrog.io JF_ACCESS_TOKEN=*** \
#     ./install_from_bundle.sh openbrain-team-3/dist/openbrain-bundle-offline-arm64.tar.gz openbrain-team-3
#   JF_SERVER_ID=repo21 \
#     ./install_from_bundle.sh openbrain-team-3/dist/openbrain-bundle-offline-arm64.tar.gz openbrain-team-3
set -euo pipefail

BUNDLE_RT_PATH="${1:-}"
MEMORIES_REPO="${2:-}"
if [[ -z "$BUNDLE_RT_PATH" || -z "$MEMORIES_REPO" ]]; then
  echo "usage: $0 <BUNDLE_RT_PATH> <MEMORIES_REPO>   (see header for JF_URL/JF_ACCESS_TOKEN/JF_SERVER_ID)" >&2
  exit 2
fi

command -v jf >/dev/null     || { echo "jf CLI not found — install it first (https://jfrog.com/getcli/)." >&2; exit 1; }
command -v docker >/dev/null || { echo "docker not found." >&2; exit 1; }

# Resolve the jf server to use — explicit beats default, never assumed.
JF_SERVER_ID="${JF_SERVER_ID:-}"
if [[ -n "${JF_URL:-}" && -n "${JF_ACCESS_TOKEN:-}" ]]; then
  # 1. Register (idempotently) a server from URL + token.
  JF_SERVER_ID="${JF_SERVER_ID:-openbrain}"
  echo "[install] configuring jf server '${JF_SERVER_ID}' → ${JF_URL}"
  jf config remove "$JF_SERVER_ID" --quiet 2>/dev/null || true
  jf config add "$JF_SERVER_ID" \
    --url="$JF_URL" --access-token="$JF_ACCESS_TOKEN" --interactive=false
elif [[ -n "$JF_SERVER_ID" ]]; then
  # 2. Use a server the friend already configured.
  jf config show "$JF_SERVER_ID" >/dev/null 2>&1 \
    || { echo "jf server '$JF_SERVER_ID' not found. Configure it or pass JF_URL+JF_ACCESS_TOKEN." >&2; exit 1; }
  echo "[install] using specified jf server: $JF_SERVER_ID"
else
  # 3. Fall back to the current default server.
  JF_SERVER_ID="$(jf config show 2>/dev/null | awk '/^Server ID:/{id=$3} /^Default:[[:space:]]*true/{print id; exit}')"
  [[ -n "$JF_SERVER_ID" ]] || { echo "No jf connection. Set JF_URL+JF_ACCESS_TOKEN, or JF_SERVER_ID, or run: jf config use <id>" >&2; exit 1; }
  echo "[install] using default jf server: $JF_SERVER_ID"
fi

# 1. Ensure the memories repo exists (create a generic local repo if missing).
code="$(jf rt curl -s -o /dev/null -w '%{http_code}' -XGET "/api/repositories/${MEMORIES_REPO}" --server-id "$JF_SERVER_ID" || true)"
if [[ "$code" == "200" ]]; then
  echo "[install] memories repo '${MEMORIES_REPO}' exists."
else
  echo "[install] creating generic local repo '${MEMORIES_REPO}' (HTTP ${code})..."
  jf rt curl -XPUT "/api/repositories/${MEMORIES_REPO}" \
    -H "Content-Type: application/json" \
    -d "{\"rclass\":\"local\",\"packageType\":\"generic\"}" --server-id "$JF_SERVER_ID"
  echo "[install] created '${MEMORIES_REPO}'."
fi

# 2. Download + unpack the bundle, then load the docker image(s).
#    The bundle is extracted into a PERSISTENT install dir (not a tempdir) because
#    the stack bind-mounts ./jfrog-config, ./tei-model and ./init at runtime — those
#    paths must survive after this script exits. Only the download is temporary.
INSTALL_DIR="${OPENBRAIN_HOME:-$HOME/.openbrain}"
dl="$(mktemp -d)"; trap 'rm -rf "$dl"' EXIT

echo "[install] downloading bundle..."
jf rt download "$BUNDLE_RT_PATH" "${dl}/" --flat=true --server-id "$JF_SERVER_ID"
mkdir -p "$INSTALL_DIR"
rm -rf "${INSTALL_DIR}/openbrain-bundle"
tar -xzf "${dl}/$(basename "$BUNDLE_RT_PATH")" -C "$INSTALL_DIR"
cd "${INSTALL_DIR}/openbrain-bundle"
echo "[install] install dir: $(pwd)"

# Offline bundle ships every image under images/; thin bundle ships only the
# server image at the root. Load whatever is present.
OFFLINE=0
echo "[install] loading docker image(s)..."
if [[ -d images ]]; then
  OFFLINE=1
  for img in images/*.tar.gz; do
    echo "[install]   load ${img}"
    gunzip -c "$img" | docker load
  done
else
  gunzip -c server-image.tar.gz | docker load
fi
# Pull the exact image refs to pin in .env (written by build_bundle.sh).
[[ -f IMAGE_TAG.txt ]] && source IMAGE_TAG.txt || true

# 3. Generate the ONE config file. No hand-editing, no .env.secrets: docker-compose.yml
#    hardcodes all static plumbing, so the generated .env carries only the real input
#    (RT_REPO) plus values derived from jf/git/the bundle. Compose auto-loads this .env
#    for interpolation, and it persists so later `docker compose` commands just work.
GIT_USER="$(git config user.name 2>/dev/null || echo "${USER:-unknown}")"
{
  echo "# generated by install_from_bundle.sh — do not hand-edit"
  echo "RT_REPO=${MEMORIES_REPO}"
  echo "JF_SERVER_ID=${JF_SERVER_ID}"
  echo "GIT_USER=${GIT_USER}"
  [[ -n "${OPENBRAIN_PORT:-}" ]] && echo "PORT=${OPENBRAIN_PORT}"
} > .env
# Pin the exact image refs the bundle shipped (offline), else fall back to the arm64
# TEI tag on Apple Silicon. DB_IMAGE/OPENBRAIN_IMAGE come from IMAGE_TAG.txt.
if [[ -n "${TEI_IMAGE:-}" ]]; then
  echo "TEI_IMAGE=${TEI_IMAGE}" >> .env
elif [[ "$(uname -m)" == "arm64" || "$(uname -m)" == "aarch64" ]]; then
  echo "TEI_IMAGE=ghcr.io/huggingface/text-embeddings-inference:cpu-arm64-latest" >> .env
fi
[[ -n "${OPENBRAIN_IMAGE:-}" ]] && echo "OPENBRAIN_IMAGE=${OPENBRAIN_IMAGE}" >> .env
[[ -n "${DB_IMAGE:-}" ]]        && echo "DB_IMAGE=${DB_IMAGE}" >> .env

# 4. Reuse the host's jf credentials for the container (mounted at /home/deno/.jfrog).
mkdir -p jfrog-config
cp -R "${JFROG_CLI_HOME_DIR:-$HOME/.jfrog}/." jfrog-config/

# 5. Embedding model. Offline bundle ships it in ./tei-model → mount it, no download.
if [[ "$OFFLINE" == "1" && -f tei-model/model.safetensors ]]; then
  echo "[install] using bundled embedding model (offline, no CDN)."
  echo "EMBED_MODEL=/model" >> .env
elif ! curl -fsI --max-time 10 \
     "https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1/resolve/main/config.json" >/dev/null 2>&1; then
  echo "[install] HF unreachable from host — skipping prefetch; TEI will try at boot."
else
  echo "[install] pre-fetching embedding model (host has the proxy/CA)..."
  mkdir -p tei-model/1_Pooling
  B="https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1/resolve/main"
  for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json \
           vocab.txt sentence_bert_config.json config_sentence_transformers.json \
           modules.json 1_Pooling/config.json model.safetensors; do
    curl -fsSL -o "tei-model/$f" "$B/$f"
  done
  echo "EMBED_MODEL=/model" >> .env
fi

# 6. Start using the loaded image (never build).
echo "[install] starting stack..."
docker compose up -d --no-build

PORT="$(awk -F= '/^PORT=/{p=$2} END{print (p==""?"8787":p)}' .env)"
echo "[install] waiting for health on http://localhost:${PORT} ..."
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    echo "[install] healthy. MCP endpoint: http://localhost:${PORT}/ (no auth, loopback only)"
    echo "[install] tools: capture_memory, search_memories, list_memories, delete_memory"
    echo "[install] manage with: cd '$(pwd)' && docker compose {logs -f,down,up -d}"
    exit 0
  fi
  sleep 5
done
echo "[install] server did not become healthy in time — check:" >&2
echo "          cd '$(pwd)' && docker compose logs -f server tei" >&2
exit 1

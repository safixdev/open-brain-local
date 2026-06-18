#!/usr/bin/env bash
# build_bundle.sh — build a FULLY OFFLINE Open Brain bundle.
#
# Packs every runtime dependency so the target host needs zero registry/CDN egress:
#   - server image  (openbrain-mcp-server)
#   - TEI image     (huggingface text-embeddings-inference)
#   - db image      (pgvector/pgvector)
#   - embedding model weights (mounted at /model, no HF download at boot)
#   - compose + env templates + db init
#
# Result: dist/openbrain-bundle-offline-<arch>.tar.gz  (~1.9 GB)
#
# Usage:
#   ./build_bundle.sh            # uses local images; builds server if missing
#
# Env overrides:
#   SERVER_IMAGE   default: openbrain-mcp-server:local
#   DB_IMAGE       default: pgvector/pgvector:pg16
#   TEI_MODEL_DIR  default: ./tei-model   (must already be prefetched)
set -euo pipefail
cd "$(dirname "$0")"

ARCH="$(uname -m)"; case "$ARCH" in aarch64) ARCH=arm64;; x86_64) ARCH=amd64;; esac
SERVER_IMAGE="${SERVER_IMAGE:-openbrain-mcp-server:local}"
DB_IMAGE="${DB_IMAGE:-pgvector/pgvector:pg16}"
TEI_MODEL_DIR="${TEI_MODEL_DIR:-./tei-model}"
if [[ "$ARCH" == "arm64" ]]; then
  TEI_IMAGE="${TEI_IMAGE:-ghcr.io/huggingface/text-embeddings-inference:cpu-arm64-latest}"
else
  TEI_IMAGE="${TEI_IMAGE:-ghcr.io/huggingface/text-embeddings-inference:cpu-1.9}"
fi

stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT
out="${stage}/openbrain-bundle"
mkdir -p "${out}/images"

echo "[build] arch=${ARCH}"
echo "[build]   server = ${SERVER_IMAGE}"
echo "[build]   tei    = ${TEI_IMAGE}"
echo "[build]   db     = ${DB_IMAGE}"

# Ensure all three images are present locally.
docker image inspect "$SERVER_IMAGE" >/dev/null 2>&1 || { echo "[build] building server image..."; docker compose build server; }
docker image inspect "$TEI_IMAGE" >/dev/null 2>&1 || docker pull "$TEI_IMAGE"
docker image inspect "$DB_IMAGE"  >/dev/null 2>&1 || docker pull "$DB_IMAGE"

# Model weights must be prefetched (the whole point of offline).
[[ -f "${TEI_MODEL_DIR}/model.safetensors" ]] || {
  echo "[build] ERROR: ${TEI_MODEL_DIR}/model.safetensors missing." >&2
  echo "        Prefetch the model first (see install_from_bundle.sh / open-brain-up skill)." >&2
  exit 1
}

echo "[build] saving images (this is the slow part)..."
docker save "$SERVER_IMAGE" | gzip > "${out}/images/server-image.tar.gz"
docker save "$TEI_IMAGE"    | gzip > "${out}/images/tei-image.tar.gz"
docker save "$DB_IMAGE"     | gzip > "${out}/images/db-image.tar.gz"

echo "[build] copying config + model..."
# No env templates ship: the stack is self-contained (docker-compose.yml hardcodes
# plumbing) and the installer generates the only .env from RT_REPO.
cp docker-compose.yml "$out/"
mkdir -p "${out}/init"; cp init/01-init.sql "${out}/init/"
cp -R "$TEI_MODEL_DIR" "${out}/tei-model"

# Record the exact refs the installer must wire into .env.
cat > "${out}/IMAGE_TAG.txt" <<EOF
ARCH=${ARCH}
OPENBRAIN_IMAGE=${SERVER_IMAGE}
TEI_IMAGE=${TEI_IMAGE}
DB_IMAGE=${DB_IMAGE}
OFFLINE=1
EOF

mkdir -p dist
tarball="dist/openbrain-bundle-offline-${ARCH}.tar.gz"
echo "[build] writing ${tarball}..."
tar -C "$stage" -czf "$tarball" openbrain-bundle
echo "[build] done: $(ls -lh "$tarball" | awk '{print $5}')  ${tarball}"

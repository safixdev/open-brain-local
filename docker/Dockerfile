# docker/Dockerfile
# Build context is the repo root (..):
#   docker buildx bake -f docker/docker-bake.hcl
# Or directly:
#   docker build -f docker/Dockerfile -t openbrain-mcp-server ..
#
# Behind a corporate TLS-intercepting proxy, `deno install` cannot verify the
# re-signed certificates. Pass your corporate CA as a build secret:
#   docker buildx build -f docker/Dockerfile --secret id=ca,src=corp-ca.pem -t openbrain-mcp-server ..
# The secret is read only during build, never baked into the image, and the
# step is a no-op when no `ca` secret is provided (so clean-network/CI builds
# work unchanged).

FROM denoland/deno:2.3.3

WORKDIR /app

# Cache dependencies before copying source so rebuilds on code change are fast.
# When a `ca` build secret is present and non-empty, trust it via DENO_CERT for
# this download; otherwise behave exactly as a normal `deno install`.
COPY server/deno.json ./deno.json
RUN --mount=type=secret,id=ca \
    if [ -s /run/secrets/ca ]; then export DENO_CERT=/run/secrets/ca; fi; \
    deno install

# Copy server source files and cache the FULL module graph (including in-source
# remote imports like `jsr:@supabase/...`) so the runtime never fetches anything.
# Same CA-secret handling as above.
COPY server/*.ts ./
RUN --mount=type=secret,id=ca \
    if [ -s /run/secrets/ca ]; then export DENO_CERT=/run/secrets/ca; fi; \
    deno cache index.ts

# Install JFrog CLI so the autosync can shell out to `jf rt` commands.
# Pinned to the same version as the host (2.107.0) for consistency.
# The CA secret is re-used so corporate TLS proxies don't block the download.
ARG JF_VERSION=2.107.0
RUN --mount=type=secret,id=ca \
    set -e; \
    apt-get update -qq && apt-get install -y --no-install-recommends curl ca-certificates; \
    if [ -s /run/secrets/ca ]; then \
      cp /run/secrets/ca /usr/local/share/ca-certificates/corp-ca.crt \
      && update-ca-certificates; \
    fi; \
    ARCH=$(uname -m); \
    case "$ARCH" in \
      aarch64|arm64) JF_ARCH="arm64" ;; \
      *) JF_ARCH="amd64" ;; \
    esac; \
    curl -fL "https://releases.jfrog.io/artifactory/jfrog-cli/v2-jf/${JF_VERSION}/jfrog-cli-linux-${JF_ARCH}/jf" \
         -o /usr/local/bin/jf \
    && chmod +x /usr/local/bin/jf \
    && /usr/local/bin/jf --version; \
    apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Pre-create the jfrog config directory (mounted from host at runtime).
RUN mkdir -p /home/deno/.jfrog && chown -R deno:deno /home/deno/.jfrog

# Run as the non-root deno user provided by the base image.
USER deno

EXPOSE 8000

# --cached-only: fail fast instead of reaching the network at runtime (hermetic).
CMD ["deno", "run", "--cached-only", "--allow-net", "--allow-env", "--allow-read", "--allow-run=/usr/local/bin/jf", "--allow-write=/tmp", "index.ts"]

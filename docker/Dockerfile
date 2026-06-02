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

# Run as the non-root deno user provided by the base image.
USER deno

EXPOSE 8000

# --cached-only: fail fast instead of reaching the network at runtime (hermetic).
CMD ["deno", "run", "--cached-only", "--allow-net", "--allow-env", "--allow-read", "index.ts"]

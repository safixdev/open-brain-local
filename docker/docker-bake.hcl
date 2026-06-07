# docker/docker-bake.hcl
# Multiarch build for the Open Brain MCP server container.
#
# Build (local cache, no push):
#   docker buildx bake -f docker/docker-bake.hcl
#
# Build and push to a registry:
#   IMAGE=ghcr.io/yourorg/openbrain-mcp-server TAG=v1.0.0 \
#   docker buildx bake -f docker/docker-bake.hcl --push
#
# Requires a multiarch buildx builder:
#   docker buildx create --use --name obx --platform linux/amd64,linux/arm64
#
# Behind a corporate TLS proxy, supply your CA so `deno install` trusts it:
#   CA_CERT=corp-ca.pem docker buildx bake -f docker/docker-bake.hcl
# CA_CERT defaults to /dev/null (empty) so the secret is a no-op without it.

variable "IMAGE" {
  default = "openbrain-mcp-server"
}

variable "TAG" {
  default = "latest"
}

variable "CA_CERT" {
  default = "/dev/null"
}

group "default" {
  targets = ["server"]
}

target "server" {
  context    = ".."
  dockerfile = "docker/Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = ["${IMAGE}:${TAG}"]
  secret     = ["id=ca,src=${CA_CERT}"]
}

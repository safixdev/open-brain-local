# Open Brain Up

Production install/startup runbook for the dockerized Open Brain stack, packaged
as an agent skill so any team can stand up their own instance.

## What it does

Walks an operator (or an AI agent) through bringing Open Brain online against the
team's **own Artifactory**:

1. Collect the team's Artifactory inputs (URL, access token, server-id, repo).
2. Generate the `jf` CLI config the server mounts (`docker/jfrog-config/`).
3. Template `.env` / `.env.secrets` and generate strong secrets.
4. Build (with corporate-CA support for TLS-intercepting proxies) and start.
5. Verify with a capture → search round trip.

## Architecture recap

- **Artifactory = source of truth.** Every memory is an artifact at
  `<RT_REPO>/thoughts/<sha256>.json` with provenance properties (`git_user`,
  `repo`, `created_at`, `content`, `type`, `topics`, …).
- **pgvector = rebuildable index**, synced from Artifactory. `down -v` is safe;
  a re-sync rebuilds it.
- **Deletes are tombstones** (`<id>.deleted.json`) — an audit trail; sync removes
  tombstoned memories from pgvector.
- **No chat model.** The calling agent supplies metadata to `capture_thought`.

## Files

- `SKILL.md` — the step-by-step procedure (this is what the agent executes).
- `list_rt_memories.sh` — inspect live + tombstoned memories via one AQL call.
- `metadata.json` — skill manifest.

## Usage

From the repo root: "open brain up" / "set up open brain". The agent will ask for
the Artifactory inputs, then follow `SKILL.md`.

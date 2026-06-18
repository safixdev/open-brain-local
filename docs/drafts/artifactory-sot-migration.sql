-- Artifactory SOT migration (JFrog CLI variant)
-- Repo: open-brain-memories (generic local) on eldada.jfrog.io (server-id: intro)
-- Browse: https://eldada.jfrog.io/ui/repos/tree/General/open-brain-memories
-- Run once against your Supabase / local Postgres after deploying the RT integration.
-- Idempotent.

-- 1. Add artifact_path provenance column to thoughts.
--    Stores the Artifactory path (e.g. thoughts/<sha256>.json) for each thought.
--    NULL for thoughts captured before this migration or without RT configured.
ALTER TABLE public.thoughts
  ADD COLUMN IF NOT EXISTS artifact_path TEXT;

CREATE INDEX IF NOT EXISTS thoughts_artifact_path_idx
  ON public.thoughts (artifact_path)
  WHERE artifact_path IS NOT NULL;

-- 2. Sync cursor table — one row per sync source.
--    The sync worker reads/writes the artifactory row to track incremental sync progress.
CREATE TABLE IF NOT EXISTS public.sync_cursor (
  id            TEXT PRIMARY KEY,           -- e.g. 'artifactory'
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the cursor row so the sync worker can upsert cleanly on first run.
INSERT INTO public.sync_cursor (id, last_synced_at)
  VALUES ('artifactory', '1970-01-01T00:00:00Z')
  ON CONFLICT (id) DO NOTHING;

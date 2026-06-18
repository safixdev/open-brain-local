#!/usr/bin/env bash
# list_rt_memories.sh — single AQL call per section, no downloads, ~1s
# Lists live memories and (as a trace) tombstoned/deleted memories.
# Requires: jf CLI configured, jq, python3

set -euo pipefail

SERVER_ID="${RT_SERVER_ID:-intro}"
REPO="${RT_REPO:-open-brain-memories}"

aql() {
  jf rt curl -s -X POST "/api/search/aql" \
    --server-id "$SERVER_ID" \
    -H "Content-Type: text/plain" \
    --data "$1" 2>/dev/null
}

# ── Live memories ────────────────────────────────────────────────────────────
# Memories are foldered per git repo: <repo>/thoughts/<sha>.json
LIVE=$(aql "items.find({
  \"repo\":\"$REPO\",
  \"path\":{\"\$match\":\"*/thoughts\"},
  \"\$and\":[
    {\"name\":{\"\$match\":\"*.json\"}},
    {\"name\":{\"\$nmatch\":\"*.deleted.json\"}}
  ]
}).include(\"name\",\"path\",\"created\",\"property\").sort({\"\$asc\":[\"created\"]})")

LIVE_COUNT=$(echo "$LIVE" | jq '.results | length')

echo ""
echo "Memories in $REPO/thoughts ($LIVE_COUNT):"
echo "─────────────────────────────────────────────────────"

if [[ "$LIVE_COUNT" -eq 0 ]]; then
  echo "  (none)"
else
  echo "$LIVE" | jq -r '
    .results[] |
    ((.properties // []) | map({(.key): .value}) | add // {}) as $p |
    [
      (.created | split("T")[0]),
      ($p.git_user // $p.user_id // "?"),
      ($p.repo     // "-"),
      ($p.source   // "?"),
      ($p.content  // "")
    ] | @tsv
  ' | python3 -c "
import sys, urllib.parse

for i, line in enumerate(sys.stdin, 1):
    parts = line.rstrip('\n').split('\t')
    parts += [''] * (5 - len(parts))
    date, user, repo, src, content = parts[0], parts[1], parts[2], parts[3], parts[4]
    user = urllib.parse.unquote(user)
    repo = urllib.parse.unquote(repo)
    decoded = urllib.parse.unquote(content) if content else '(no preview — needs backfill)'
    print(f'{i:3d}. [{date}] {user:<10s} repo:{repo:<20s} {src}')
    print(f'     {decoded[:120]}')
    print()
"
fi

# ── Tombstones (deleted memories — trace) ────────────────────────────────────
TOMB=$(aql "items.find({
  \"repo\":\"$REPO\",
  \"path\":{\"\$match\":\"*/thoughts\"},
  \"name\":{\"\$match\":\"*.deleted.json\"}
}).include(\"name\",\"path\",\"created\",\"property\").sort({\"\$asc\":[\"created\"]})")

TOMB_COUNT=$(echo "$TOMB" | jq '.results | length')

if [[ "$TOMB_COUNT" -gt 0 ]]; then
  echo "─────────────────────────────────────────────────────"
  echo "Deleted (tombstoned) memories ($TOMB_COUNT) — trace:"
  echo "─────────────────────────────────────────────────────"
  echo "$TOMB" | jq -r '
    .results[] |
    ((.properties // []) | map({(.key): .value}) | add // {}) as $p |
    [
      ((($p.deleted_at // .created) | split("T")[0])),
      ($p.git_user // "?"),
      ($p.content  // "")
    ] | @tsv
  ' | python3 -c "
import sys, urllib.parse

for i, line in enumerate(sys.stdin, 1):
    parts = line.rstrip('\n').split('\t')
    parts += [''] * (3 - len(parts))
    date, user, content = parts[0], parts[1], parts[2]
    date = urllib.parse.unquote(date).split('T')[0]
    user = urllib.parse.unquote(user)
    decoded = urllib.parse.unquote(content) if content else '(no snippet)'
    print(f'{i:3d}. [{date}] deleted by {user:<10s}')
    print(f'     {decoded[:120]}')
    print()
"
fi

echo "─────────────────────────────────────────────────────"
echo "Live: $LIVE_COUNT  |  Deleted: ${TOMB_COUNT:-0}  |  AQL only (no downloads)"

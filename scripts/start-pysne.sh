#!/bin/sh
set -eu
# Create logical DB `pysne` on the shared free Postgres, then start.
# Skip drizzle-kit push on cold starts when core tables already exist — that
# push was adding ~20–30s before the process listened, so free-tier wakeups
# looked like timeouts. Additive migrations still run in prepareDatabase().
# Force a full push after schema changes with PYSNE_DB_PUSH=1.
BOOTSTRAP="$(pnpm --filter @workspace/db exec -- node ./ensure-pysne-db.mjs)"
NEW_URL="$(printf '%s\n' "$BOOTSTRAP" | sed -n '1p')"
SCHEMA_STATE="$(printf '%s\n' "$BOOTSTRAP" | sed -n '2p')"
case "$NEW_URL" in
  postgres://*|postgresql://*) ;;
  *)
    echo "ensure-pysne-db.mjs did not return a postgres URL" >&2
    echo "$BOOTSTRAP" >&2
    exit 1
    ;;
esac
export DATABASE_URL="$NEW_URL"
echo "Pysne using logical database $(printf '%s' "$DATABASE_URL" | sed -E 's#^.*/([^/?]+).*#\1#')"

if [ "${PYSNE_DB_PUSH:-0}" = "1" ] || [ "$SCHEMA_STATE" != "SCHEMA_READY" ]; then
  echo "Running drizzle push (force=${PYSNE_DB_PUSH:-0} state=${SCHEMA_STATE:-unknown})"
  pnpm --filter @workspace/db run push
else
  echo "Schema present — skipping drizzle push (set PYSNE_DB_PUSH=1 to force)"
fi

exec pnpm run start:production

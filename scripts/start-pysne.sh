#!/bin/sh
set -eu
# Create logical DB `pysne` on the shared free Postgres, then migrate + start.
NEW_URL="$(pnpm --filter @workspace/db exec -- node ./ensure-pysne-db.mjs)"
case "$NEW_URL" in
  postgres://*|postgresql://*) ;;
  *)
    echo "ensure-pysne-db.mjs did not return a postgres URL" >&2
    echo "$NEW_URL" >&2
    exit 1
    ;;
esac
export DATABASE_URL="$NEW_URL"
echo "Pysne using logical database $(printf '%s' "$DATABASE_URL" | sed -E 's#^.*/([^/?]+).*#\1#')"
pnpm --filter @workspace/db run push
exec pnpm run start:production

#!/bin/sh
set -eu
export DATABASE_URL="$(pnpm --filter @workspace/db exec node ../../scripts/ensure-pysne-db.mjs)"
echo "Pysne DATABASE_URL path=$(node -e 'console.log(new URL(process.env.DATABASE_URL).pathname)')"
pnpm --filter @workspace/db run push
exec pnpm run start:production

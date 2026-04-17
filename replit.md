# Treasure Hunt – Szczecin

## Overview

A full-stack geo-treasure hunt web app for Szczecin, Poland. Admins hide treasures on a Leaflet map; guests discover them via secret codes that expire after 1 hour.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui + Leaflet.js
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Map**: Leaflet.js with OpenStreetMap tiles centered on Szczecin

## Artifacts

- `artifacts/treasure-hunt` — React + Vite frontend, served at `/`
- `artifacts/api-server` — Express API server, served at `/api`

## Roles

- **Admin** — can add/delete treasures, see all markers on map with codes. Login: `admin` / `haslo123`
- **Guest** — enters a treasure code, sees that one treasure on map. Codes: TRX7K, SCZ2M, JKB9Q, ZMK4F (all expire 1h from seed time)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Database Schema

- `users` — admin users (id, name, email, password_hash, role)
- `markers` — treasure locations (id, title, description, code, lat, lng, image_url, created_at, expires_at)
- `redemptions` — which user redeemed which code (id, user_id, marker_id, redeemed_at)

## Admin credentials

- Username: `admin` / Password: `haslo123`

## Sample treasure codes (seeded at startup, expire 1h after seeding)

- `TRX7K` — Brama Portowa
- `SCZ2M` — Wały Chrobrego
- `JKB9Q` — Katedra św. Jakuba
- `ZMK4F` — Zamek Książąt Pom.
- `PGR8X` — Plac Grunwaldzki (expired test marker)

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

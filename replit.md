# Pysne.com.pl – Szczecin

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

- **Admin** — can add/delete treasures, see all markers on map with codes. Login: `czosnek` / `Aszwarganda666!@#`
- **Guest** — enters a treasure code, sees that one treasure on map. Codes: TRX7K, SCZ2M, JKB9Q, ZMK4F (all expire 1h from seed time)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm run build:production` — production typecheck plus frontend and API builds for Replit
- `pnpm run start:production` — serve the built frontend and API from one production process
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Database Schema

- `users` — admin users (id, name, email, password_hash, role)
- `markers` — treasure locations (id, title, description, code, lat, lng, image_url, created_at, **expires_at NULLABLE**)
- `redemptions` — which user redeemed which code (id, user_id, marker_id, redeemed_at)
- `guest_discoveries` — legacy table; no longer used by application code (kept in DB for backwards compatibility).

## Code countdown timer (single source of truth)

The application has exactly **one** countdown timer: the 60-minute marker code timer.

- **Admin creation**: `markers.expires_at` is left **NULL**. The 60-minute value is implicit (set by `CODE_TTL_MS` in `auth.ts`) but the timer does **not** start.
- **First guest activation**: when the FIRST guest successfully enters a valid code, the server runs an atomic conditional UPDATE (`SET expires_at = NOW + 60min WHERE id = ? AND expires_at IS NULL`). First-writer-wins; concurrent races re-read the winning value.
- **Subsequent guests**: see the same shared `markerExpiresAt` — the timer does NOT restart on re-login or refresh.
- **UI surface**: a single red mm:ss chip at the bottom-center of the map, plus the same `Pozostało: mm:ss` in each admin row.
- **Expired state**: guests get a 401 ("Ten skarb już wygasł") on `/auth/guest-login`; admins still see the row and code, but greyed out + line-through (`Wygasły`).
- **Pre-activation state (admin only)**: the row shows `Nieaktywny (60:00)` in grey so the admin knows the code is set but no guest has activated it yet.

The frontend persists `{ code }` under `th_guest_session` so a page refresh re-fetches the same shared timer.

## Known security posture

All admin-only routes (POST/DELETE `/markers`, `/stats`, `/discoveries`, `/discoveries/reset`) are currently unauthenticated at the API layer — admin gating is enforced only on the client. This matches the existing app's posture and is acceptable for the current single-tenant, demo-style deployment, but a future hardening pass should add a session-based `requireAdmin` middleware uniformly across all admin endpoints.

## Admin credentials

- Username: `czosnek` / Password: `Aszwarganda666!@#`

## Sample treasure codes (seeded at startup, expire 1h after seeding)

- `TRX7K` — Brama Portowa
- `SCZ2M` — Wały Chrobrego
- `JKB9Q` — Katedra św. Jakuba
- `ZMK4F` — Zamek Książąt Pom.
- `PGR8X` — Plac Grunwaldzki (expired test marker)

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

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

- **Kreator (admin)** — ukrywa skarby i publikuje gry Podchody. Logowanie jest tylko przez konto w bazie; haseł nie trzymamy w repozytorium.
- **Moderator i master admin** — opiekują się kontami. Analityka jest dostępna dla tych ról.
- **Uczestnik** — nie ma konta. Wpisuje kod skarbu albo dołącza do gry Podchody nickiem.

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

## Bezpieczeństwo

Trasy administratora wymagają podpisanej sesji. `requireAdmin` jest podpięte do konkretnych ścieżek, a nieznane adresy `/api` zwracają JSON 404. Próby kodów skarbu i kodów gier są limitowane per IP. Serwer ustawia nagłówki `nosniff`, `X-Frame-Options`, `frame-ancestors` oraz CSP zgodne z kafelkami OSM i przekierowaniem do Stripe. HSTS jest włączone w produkcji. Analityka zależy od roli `master_admin` albo `moderator`.

Hasła i przykładowe kody nie są zapisywane w tym pliku. Zmianę hasła robi właściciel konta poza repozytorium.

## Podchody

Organizator publikuje grę z 2–10 punktami. Publikacja zużywa jedną pinezkę (saldo Kreatora, ten sam próg 402 i pakiety Stripe co przy skarbie). Uczestnik dołącza pięcioznakowym kodem, widzi tylko bieżący punkt jako przybliżony obszar i po poprawnym kodzie dostaje następny. Po mecie może raz ocenić organizatora kciukiem w górę albo w dół. Wynik organizatora to suma tych ocen.

Tabele `guest_discoveries` i `settings` zostają w bazie. Aplikacja nie korzysta już ze starych ścieżek odkryć ani z identyfikatora gościa w przeglądarce.


## Statistics Scraper Monorepo

This is a pnpm-based TypeScript monorepo containing:

- `apps/web` (Next.js App Router, frontend-only admin dashboard)
- `apps/orchestrator` (Hono REST API)
- `apps/worker` (long-running Node worker using Playwright Core + Browserless)
- `shared/types` (shared TypeScript types)
- `supabase/sql` (all SQL scripts in order)

Root scripts:

- dev:web: `pnpm --filter @app/web dev`
- dev:orchestrator: `pnpm --filter @app/orchestrator dev`
- dev:worker: `pnpm --filter @app/worker dev`

Environment variables are documented in each app's `.env.example`.

---

### Supabase Setup (once)

- Create project → get `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- Run SQL files in order: 01_tables.sql → 02_rls.sql → 03_rpc.sql → 04_policies.sql → 05_indexes.sql
- Create SUPERADMIN user by signing in once via web; copy their email to env SUPERADMIN_EMAIL

### Deploy Web (Vercel)

- Import repo, select **apps/web**
- Set Environment Variables:
  - NEXT_PUBLIC_SUPABASE_URL
  - NEXT_PUBLIC_SUPABASE_ANON_KEY
  - NEXT_PUBLIC_ORCHESTRATOR_URL (e.g., the Railway orchestrator HTTPS URL)
  - NEXT_PUBLIC_SUPERADMIN_EMAIL
- No server secrets in web.
- Add a Vercel Cron (optional) to hit orchestrator `/cron/enqueue` (method POST) with header `X-Cron-Token: ${CRON_TOKEN}`; else configure a Railway Cron instead.

### Deploy Orchestrator (Railway)

- New service from `/apps/orchestrator`
- Set Environment Variables:
  - SUPABASE_URL
  - SUPABASE_SERVICE_ROLE_KEY
  - SUPABASE_JWKS_URL (https://<project-ref>.supabase.co/auth/v1/jwks)
  - SUPERADMIN_EMAIL
  - WEB_ORIGIN (your Vercel URL)
  - CRON_TOKEN (long random)
- Expose port `$PORT` (Railway default)
- Verify `GET /health`
- Test local: curl POST `/enqueue` with an Authorization bearer from a logged-in Super Admin (see README snippet)

### Deploy Worker (Railway)

- New service from `/apps/worker` (no port needed)
- Set Environment Variables:
  - SUPABASE_URL
  - SUPABASE_SERVICE_ROLE_KEY
  - BROWSERLESS_WS
  - SPY_BASE_URL
  - SPY_USERNAME
  - SPY_PASSWORD
  - TIMEZONE=Europe/Copenhagen
- Logs should show idling “no jobs”; enqueue one and watch it process

### Hook Up CRON

- Option A (Railway Cron): Configure a schedule to POST to orchestrator `/cron/enqueue` with header `X-Cron-Token: ${CRON_TOKEN}`
- Option B (Vercel Cron): Project → Settings → Cron → POST to orchestrator `/cron/enqueue` with the same header
- Cron should **enqueue**, not run the job itself

### Admin Access

- Visit `/signin`, sign in. If your email !== SUPERADMIN_EMAIL, you’ll be redirected away from `/admin`
- Super Admin sees `/admin` dashboard: recent jobs, “Run now” toggles (shallow/deep), detail pages with logs/results

### SPY Selectors & Browserless Notes

- Login selectors used:
  - username: `input#username, input[name="username"], input[type="text"]`
  - password: `input#password, input[name="password"], input[type="password"]`
  - submit: `button[type="submit"], input[type="submit"], .btn-login`
- Post-login marker options:
  - `.dashboard, nav[aria-label="main"], .user-menu, .logout, [data-testid="main-shell"]`
- If login is inside an iframe, code includes a helper to detect and switch to the correct frame
- Nav timeouts: 60s; selector timeouts: 30s; settle waits: ~1–2s
- Use incognito context per job; always close context/page/browser in finally

---

## Local Development

1. Install pnpm if needed.
2. Run `pnpm install` at the repo root.
3. Copy each `.env.example` to `.env` in its app folder and fill in values.
4. Start services:
   - Web: `pnpm dev:web`
   - Orchestrator: `pnpm dev:orchestrator`
   - Worker: `pnpm dev:worker`

---

## curl snippets

Replace placeholders before running.

```bash
# Orchestrator health
curl -sS https://YOUR-ORCHESTRATOR/health

# Cron enqueue (server-side)
curl -i -X POST https://YOUR-ORCHESTRATOR/cron/enqueue \
  -H "X-Cron-Token: $CRON_TOKEN" \
  -H "Content-Type: application/json"

# Enqueue (as Super Admin from browser token)
curl -i -X POST https://YOUR-ORCHESTRATOR/enqueue \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"type":"scrape_statistics","payload":{"toggles":{"deep":false},"requestedBy":"you@example.com"}}'
```



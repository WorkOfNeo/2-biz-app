import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import type { EnqueueRequestBody, EnqueueResponseBody, JobLogRow, JobResult, JobRow } from '@shared/types';

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const SUPABASE_JWKS_URL = (process.env.SUPABASE_JWKS_URL || '').trim();
const SUPABASE_JWT_SECRET = (process.env.SUPABASE_JWT_SECRET || '').trim();
const SUPERADMIN_EMAIL = (process.env.SUPERADMIN_EMAIL || '').trim();
const WEB_ORIGIN = (process.env.WEB_ORIGIN || '').trim();
const CRON_TOKEN = (process.env.CRON_TOKEN || '').trim();
const CRON_ENABLED = ((process.env.CRON_ENABLED || 'false').trim().toLowerCase() === 'true');
const CRON_MIN_INTERVAL_MINUTES = Math.max(0, Number(process.env.CRON_MIN_INTERVAL_MINUTES || '0') || 0);
const CLEANUP_KEEP_DAYS = Math.max(1, Number(process.env.CLEANUP_KEEP_DAYS || '14') || 14);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_JWKS_URL || !SUPERADMIN_EMAIL || !WEB_ORIGIN || !CRON_TOKEN) {
  // eslint-disable-next-line no-console
  console.error('Missing required environment variables.');
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function assertValidEnv() {
  const errors: string[] = [];
  if (!SUPABASE_URL) errors.push('SUPABASE_URL is empty');
  else if (!isValidHttpUrl(SUPABASE_URL)) errors.push('SUPABASE_URL must be http(s) URL');
  if (!SUPABASE_SERVICE_ROLE_KEY) errors.push('SUPABASE_SERVICE_ROLE_KEY is empty');
  // Either JWKS URL (RS256) or HS256 secret must be provided
  if (!SUPABASE_JWKS_URL && !SUPABASE_JWT_SECRET) errors.push('Provide SUPABASE_JWKS_URL (RS256) or SUPABASE_JWT_SECRET (HS256)');
  if (SUPABASE_JWKS_URL && !isValidHttpUrl(SUPABASE_JWKS_URL)) errors.push('SUPABASE_JWKS_URL must be http(s) URL');
  // SUPERADMIN_EMAIL optional (we currently accept any authenticated user)
  if (!WEB_ORIGIN) errors.push('WEB_ORIGIN is empty');
  else {
    const origins = WEB_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
    for (const o of origins) {
      if (!isValidHttpUrl(o)) errors.push(`WEB_ORIGIN item must be http(s) URL: ${o}`);
    }
  }
  if (!CRON_TOKEN) errors.push('CRON_TOKEN is empty');
  // Optional: CRON_ENABLED flag
  if (process.env.CRON_ENABLED && !['true','false','1','0'].includes(process.env.CRON_ENABLED.trim().toLowerCase())) {
    errors.push('CRON_ENABLED must be true/false');
  }
  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error('[orchestrator] Invalid environment configuration:', errors.join('; '));
    process.exit(1);
  }
}

assertValidEnv();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const app = new Hono();

const allowedOrigins = WEB_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
const corsOrigins: '*' | string[] = allowedOrigins.includes('*') ? '*' : allowedOrigins;
app.use('*', cors({
  origin: corsOrigins as any,
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  // Allow all request headers to satisfy preflight Access-Control-Request-Headers
  allowHeaders: ['*']
}));

function logRequest(label: string, c: any, extra?: Record<string, any>) {
  const meta = {
    ts: new Date().toISOString(),
    ip:
      c.req.header('x-forwarded-for') ||
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-real-ip') ||
      '',
    ua: c.req.header('user-agent') || ''
  };
  // eslint-disable-next-line no-console
  console.log(`[orchestrator] ${label}`, { ...meta, ...(extra || {}) });
}

function buildJwksCandidates(): URL[] {
  const list: URL[] = [];
  try { list.push(new URL(SUPABASE_JWKS_URL)); } catch {}
  // Add Supabase well-known fallback if not already
  try {
    const u = new URL(SUPABASE_JWKS_URL);
    const wellKnown = new URL('/auth/v1/.well-known/jwks.json', u.origin);
    if (wellKnown.toString() !== u.toString()) list.push(wellKnown);
  } catch {}
  return list;
}

async function verifySupabaseJWT(authorization?: string): Promise<JWTPayload | null> {
  if (!authorization) return null;
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  // Try RS256 via JWKS if configured
  if (SUPABASE_JWKS_URL) {
    const candidates = buildJwksCandidates();
    let lastErr: unknown = null;
    for (const url of candidates) {
      try {
        const JWKS = createRemoteJWKSet(url);
        const { payload } = await jwtVerify(token, JWKS, { issuer: undefined, audience: undefined });
        return payload;
      } catch (err) {
        lastErr = err;
      }
    }
    // If JWKS failed but we have a secret, try HS256 fallback
    if (!SUPABASE_JWT_SECRET) {
      // eslint-disable-next-line no-console
      console.error('[orchestrator] JWT verify failed via JWKS and no HS256 secret configured.');
      throw lastErr;
    }
  }

  // HS256 fallback using project JWT secret
  if (SUPABASE_JWT_SECRET) {
    const secret = new TextEncoder().encode(SUPABASE_JWT_SECRET);
    const { payload } = await jwtVerify(token, secret, { issuer: undefined, audience: undefined });
    return payload;
  }

  return null;
}

const enqueueSchema = z.object({
  type: z.enum(['scrape_statistics','scrape_styles','update_style_stock','export_overview','scrape_customers','deep_scrape_styles']),
  payload: z.record(z.any())
});

const importCustomersSchema = z.object({
  rows: z.array(z.object({
    customer_id: z.string().min(1),
    company: z.string().optional(),
    stats_display_name: z.string().optional(),
    group_name: z.string().optional(),
    salesperson_name: z.string().optional(),
    email: z.string().optional(),
    city: z.string().optional(),
    postal: z.string().optional(),
    country: z.string().optional(),
    currency: z.string().optional(),
    excluded: z.boolean().optional(),
    nulled: z.boolean().optional(),
    permanently_closed: z.boolean().optional()
  }))
});

const updateCustomerSchema = z.object({
  company: z.string().optional(),
  stats_display_name: z.string().optional(),
  group_name: z.string().optional(),
  salesperson_name: z.string().optional(),
  email: z.string().optional(),
  city: z.string().optional(),
  postal: z.string().optional(),
  country: z.string().optional(),
  currency: z.string().optional(),
  excluded: z.boolean().optional(),
  nulled: z.boolean().optional(),
  permanently_closed: z.boolean().optional()
});

app.get('/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

app.get('/jobs/:id', async (c) => {
  const id = c.req.param('id');

  const { data: job, error: jobErr } = await supabase.from('jobs').select('*').eq('id', id).single();
  if (jobErr) return c.json({ error: jobErr.message }, 500);

  const { data: logs, error: logsErr } = await supabase
    .from('job_logs')
    .select('*')
    .eq('job_id', id)
    .order('ts', { ascending: false })
    .limit(200);
  if (logsErr) return c.json({ error: logsErr.message }, 500);

  const { data: results, error: resultsErr } = await supabase
    .from('job_results')
    .select('*')
    .eq('job_id', id)
    .order('created_at', { ascending: false })
    .limit(1);
  if (resultsErr) return c.json({ error: resultsErr.message }, 500);

  return c.json({ job: job as JobRow, logs: logs as JobLogRow[], result: (results?.[0] as JobResult | undefined) ?? null });
});

app.post('/enqueue', async (c) => {
  try {
    logRequest('/enqueue start', c);
    const payload = await verifySupabaseJWT(c.req.header('authorization'));
    const email = (payload?.email as string | undefined) ?? (payload?.user_metadata as any)?.email;
    // Accept any authenticated user (remove superadmin-only restriction)
    if (!email) return c.json({ error: 'Unauthorized' }, 401);

    const body = enqueueSchema.parse(await c.req.json<EnqueueRequestBody>());

    const insertBody = {
      type: body.type,
      payload: body.payload as any,
      status: 'queued' as const,
      max_attempts: 3
    };
    const { data, error } = await supabase.from('jobs').insert(insertBody).select('id, created_at').single();
    if (error) return c.json({ error: error.message }, 500);

    const jobId = data?.id as string;
    logRequest('/enqueue inserted', c, { jobId, created_at: (data as any)?.created_at, type: insertBody.type });
    // Write an initial enqueue log for visibility
    await supabase.from('job_logs').insert({
      job_id: jobId,
      level: 'info',
      msg: 'Enqueued job',
      data: { requestedBy: body.payload?.requestedBy ?? email, toggles: body.payload?.toggles ?? {} }
    });
    return c.json({ jobId } satisfies EnqueueResponseBody);
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Invalid request' }, 400);
  }
});

// Fan-out: split update_style_stock into sub-jobs for concurrency
app.post('/enqueue/update_style_stock_fanout', async (c) => {
  try {
    logRequest('/enqueue fanout start', c);
    const payload = await verifySupabaseJWT(c.req.header('authorization'));
    const email = (payload?.email as string | undefined) ?? (payload?.user_metadata as any)?.email;
    if (!email) return c.json({ error: 'Unauthorized' }, 401);

    const body = await c.req.json<{ styleNos?: string[]; batchSize?: number }>();
    const batchSize = Math.max(1, Math.min(50, Number(body?.batchSize || 10)));

    // Determine target styleNos: prefer provided, else app_settings.styles_daily_selection
    let styleNos: string[] = Array.isArray(body?.styleNos) ? body!.styleNos! : [];
    if (styleNos.length === 0) {
      const { data } = await supabase.from('app_settings').select('value').eq('key', 'styles_daily_selection').maybeSingle();
      styleNos = ((data?.value as any)?.styleNos as string[] | undefined) ?? [];
    }
    if (styleNos.length === 0) return c.json({ error: 'No styles selected' }, 400);

    const batches: string[][] = [];
    for (let i = 0; i < styleNos.length; i += batchSize) {
      batches.push(styleNos.slice(i, i + batchSize));
    }

    const jobIds: string[] = [];
    for (const b of batches) {
      const { data, error } = await supabase
        .from('jobs')
        .insert({ type: 'update_style_stock', payload: { styleNos: b, requestedBy: email }, status: 'queued', max_attempts: 3 })
        .select('id')
        .single();
      if (error) return c.json({ error: error.message }, 500);
      jobIds.push((data as any)?.id);
    }
    logRequest('/enqueue fanout done', c, { batches: batches.length, totalStyles: styleNos.length });
    return c.json({ jobIds, batches: batches.length, totalStyles: styleNos.length });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Invalid request' }, 400);
  }
});

app.post('/cron/enqueue', async (c) => {
  if (!CRON_ENABLED) return c.json({ error: 'Cron disabled' }, 403);
  const token = c.req.header('x-cron-token');
  if (!token || token !== CRON_TOKEN) return c.json({ error: 'Unauthorized' }, 401);

  // eslint-disable-next-line no-console
  logRequest('/cron/enqueue called', c, { CRON_ENABLED, CRON_MIN_INTERVAL_MINUTES });

  // dedupe: if a job of this type is queued or running, skip
  const { data: existing, error: findErr } = await supabase
    .from('jobs')
    .select('id,status')
    .in('status', ['queued','running'])
    .eq('type', 'scrape_statistics')
    .limit(1);
  if (!findErr && existing && existing.length > 0) {
    logRequest('/cron/enqueue skipped', c, { reason: 'already queued or running' });
    return c.json({ skipped: true, reason: 'job already queued or running' });
  }

  // rate-limit: do not enqueue if last finished or started job was within X minutes
  if (CRON_MIN_INTERVAL_MINUTES > 0) {
    const sinceIso = new Date(Date.now() - CRON_MIN_INTERVAL_MINUTES * 60_000).toISOString();
    const { data: recent, error: recentErr } = await supabase
      .from('jobs')
      .select('id, started_at, finished_at, status')
      .eq('type', 'scrape_statistics')
      .or('status.eq.succeeded,status.eq.failed,status.eq.cancelled')
      .order('created_at', { ascending: false })
      .limit(1);
    if (!recentErr && recent && recent.length > 0) {
      const r = recent[0] as any;
      const ts = r.finished_at ?? r.started_at ?? r.created_at;
      if (ts && new Date(ts).getTime() > Date.now() - CRON_MIN_INTERVAL_MINUTES * 60_000) {
        logRequest('/cron/enqueue skipped', c, { reason: 'rate-limited', sinceMinutes: CRON_MIN_INTERVAL_MINUTES });
        return c.json({ skipped: true, reason: `last job within ${CRON_MIN_INTERVAL_MINUTES}m` });
      }
    }
  }

  // Determine seasonId for deep run: prefer query param, else app_settings.season_compare.s1
  let seasonId: string | null = null;
  try {
    const seasonIdParam = c.req.query('seasonId');
    if (seasonIdParam && seasonIdParam.trim().length > 0) {
      seasonId = seasonIdParam.trim();
    } else {
      const { data: compare } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'season_compare')
        .maybeSingle();
      const s1 = (compare?.value as any)?.s1 as string | undefined;
      if (s1 && s1.trim().length > 0) seasonId = s1.trim();
    }
  } catch {}

  const { data, error } = await supabase
    .from('jobs')
    .insert({
      type: 'scrape_statistics',
      payload: { toggles: { deep: true }, requestedBy: 'cron', ...(seasonId ? { seasonId } : {}) } as any,
      status: 'queued',
      max_attempts: 3
    })
    .select('id, created_at')
    .single();
  if (error) return c.json({ error: error.message }, 500);
  const jobId = (data as any)?.id;
  logRequest('/cron/enqueue inserted', c, { jobId, created_at: (data as any)?.created_at, seasonId: seasonId ?? '(auto)' });
  return c.json({ jobId });
});

app.post('/cron/cleanup', async (c) => {
  if (!CRON_ENABLED) return c.json({ error: 'Cron disabled' }, 403);
  const token = c.req.header('x-cron-token');
  if (!token || token !== CRON_TOKEN) return c.json({ error: 'Unauthorized' }, 401);
  const cutoff = new Date(Date.now() - CLEANUP_KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  logRequest('/cron/cleanup called', c, { CLEANUP_KEEP_DAYS, cutoff });
  const { data, error } = await supabase.rpc('cleanup_jobs', { p_cutoff: cutoff });
  if (error) return c.json({ error: error.message }, 500);
  logRequest('/cron/cleanup done', c, { data });
  return c.json({ ok: true, data });
});

app.post('/import/customers', async (c) => {
  try {
    const payload = await verifySupabaseJWT(c.req.header('authorization'));
    const email = (payload?.email as string | undefined) ?? (payload?.user_metadata as any)?.email;
    if (!email) return c.json({ error: 'Unauthorized' }, 401);

    const body = importCustomersSchema.parse(await c.req.json());

    let imported = 0;
    let updated = 0;
    const salespersonCache = new Map<string, string>();

    for (const r of body.rows) {
      let salesperson_id: string | null = null;
      if (r.salesperson_name && r.salesperson_name.trim().length > 0) {
        const key = r.salesperson_name.trim();
        if (salespersonCache.has(key)) {
          salesperson_id = salespersonCache.get(key)!;
        } else {
          // find or create salesperson
          const { data: spFind } = await supabase
            .from('salespersons')
            .select('id')
            .ilike('name', key)
            .maybeSingle();
          if (spFind?.id) {
            salesperson_id = spFind.id as string;
          } else {
            const { data: spIns, error: spErr } = await supabase
              .from('salespersons')
              .insert({ name: key })
              .select('id')
              .single();
            if (spErr) return c.json({ error: spErr.message }, 500);
            salesperson_id = spIns!.id as string;
          }
          salespersonCache.set(key, salesperson_id);
        }
      }

      // upsert customer based on customer_id
      const base = {
        company: r.company ?? null,
        stats_display_name: r.stats_display_name ?? null,
        group_name: r.group_name ?? null,
        salesperson_id,
        email: r.email ?? null,
        city: r.city ?? null,
        postal: r.postal ?? null,
        country: r.country ?? null,
        currency: r.currency ?? null,
        excluded: r.excluded ?? false,
        nulled: r.nulled ?? false,
        permanently_closed: r.permanently_closed ?? false
      };

      const { data: existing } = await supabase
        .from('customers')
        .select('id')
        .eq('customer_id', r.customer_id)
        .maybeSingle();

      if (existing?.id) {
        const { error: upErr } = await supabase
          .from('customers')
          .update(base)
          .eq('id', existing.id);
        if (upErr) return c.json({ error: upErr.message }, 500);
        updated++;
      } else {
        const { error: insErr } = await supabase
          .from('customers')
          .insert({ customer_id: r.customer_id, ...base });
        if (insErr) return c.json({ error: insErr.message }, 500);
        imported++;
      }
    }

    return c.json({ imported, updated });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Invalid request' }, 400);
  }
});

app.patch('/customers/:id', async (c) => {
  try {
    const payload = await verifySupabaseJWT(c.req.header('authorization'));
    const email = (payload?.email as string | undefined) ?? (payload?.user_metadata as any)?.email;
    if (!email) return c.json({ error: 'Unauthorized' }, 401);
    const id = c.req.param('id');
    const body = updateCustomerSchema.parse(await c.req.json());

    let salesperson_id: string | null | undefined = undefined;
    if (body.salesperson_name && body.salesperson_name.trim().length > 0) {
      const key = body.salesperson_name.trim();
      const { data: spFind } = await supabase.from('salespersons').select('id').ilike('name', key).maybeSingle();
      if (spFind?.id) salesperson_id = spFind.id as string;
      else {
        const { data: spIns, error: spErr } = await supabase.from('salespersons').insert({ name: key }).select('id').single();
        if (spErr) return c.json({ error: spErr.message }, 500);
        salesperson_id = spIns!.id as string;
      }
    } else if (body.salesperson_name === '') {
      // Explicitly clear salesperson
      salesperson_id = null;
    }

    const updateFields: Record<string, any> = { ...body };
    delete updateFields.salesperson_name;
    if (salesperson_id !== undefined) updateFields.salesperson_id = salesperson_id;

    const { error: upErr } = await supabase.from('customers').update(updateFields).eq('id', id);
    if (upErr) return c.json({ error: upErr.message }, 500);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Invalid request' }, 400);
  }
});

serve({ fetch: app.fetch, port: PORT });
// eslint-disable-next-line no-console
console.log(`[orchestrator] listening on :${PORT}`);



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
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return origin;
    if (allowedOrigins.includes('*')) return origin;
    return allowedOrigins.includes(origin) ? origin : '' as any;
  },
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'X-Cron-Token']
}));

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
  type: z.literal('scrape_statistics'),
  payload: z.object({
    // Allow specific known key 'deep' to be optional, plus arbitrary boolean toggles
    toggles: z
      .object({ deep: z.boolean().optional() })
      .catchall(z.boolean())
      .default({}),
    requestedBy: z.string().email().optional()
  })
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
    const { data, error } = await supabase.from('jobs').insert(insertBody).select('id').single();
    if (error) return c.json({ error: error.message }, 500);

    const jobId = data?.id as string;
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

app.post('/cron/enqueue', async (c) => {
  const token = c.req.header('x-cron-token');
  if (!token || token !== CRON_TOKEN) return c.json({ error: 'Unauthorized' }, 401);

  // eslint-disable-next-line no-console
  console.log('[orchestrator] /cron/enqueue called');

  const { data, error } = await supabase
    .from('jobs')
    .insert({ type: 'scrape_statistics', payload: { toggles: { deep: false }, requestedBy: 'cron' }, status: 'queued', max_attempts: 3 })
    .select('id')
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ jobId: data?.id });
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

serve({ fetch: app.fetch, port: PORT });
// eslint-disable-next-line no-console
console.log(`[orchestrator] listening on :${PORT}`);



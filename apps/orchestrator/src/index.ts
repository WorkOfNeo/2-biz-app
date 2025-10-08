import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import type { EnqueueRequestBody, EnqueueResponseBody, JobLogRow, JobResult, JobRow } from '@shared/types';

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_JWKS_URL = process.env.SUPABASE_JWKS_URL!;
const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL!;
const WEB_ORIGIN = process.env.WEB_ORIGIN!;
const CRON_TOKEN = process.env.CRON_TOKEN!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_JWKS_URL || !SUPERADMIN_EMAIL || !WEB_ORIGIN || !CRON_TOKEN) {
  // eslint-disable-next-line no-console
  console.error('Missing required environment variables.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const app = new Hono();

app.use('*', cors({
  origin: WEB_ORIGIN,
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'X-Cron-Token']
}));

async function verifySupabaseJWT(authorization?: string): Promise<JWTPayload | null> {
  if (!authorization) return null;
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const JWKS = createRemoteJWKSet(new URL(SUPABASE_JWKS_URL));
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: undefined,
    audience: undefined
  });
  return payload;
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

app.get('/health', (c) => c.json({ ok: true }));

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
    if (!email || email !== SUPERADMIN_EMAIL) return c.json({ error: 'Forbidden' }, 403);

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
    return c.json({ jobId } satisfies EnqueueResponseBody);
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Invalid request' }, 400);
  }
});

app.post('/cron/enqueue', async (c) => {
  const token = c.req.header('x-cron-token');
  if (!token || token !== CRON_TOKEN) return c.json({ error: 'Unauthorized' }, 401);

  const { data, error } = await supabase
    .from('jobs')
    .insert({ type: 'scrape_statistics', payload: { toggles: { deep: false }, requestedBy: 'cron' }, status: 'queued', max_attempts: 3 })
    .select('id')
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ jobId: data?.id });
});

serve({ fetch: app.fetch, port: PORT });
// eslint-disable-next-line no-console
console.log(`[orchestrator] listening on :${PORT}`);



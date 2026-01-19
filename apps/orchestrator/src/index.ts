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
  allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
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
  type: z.enum(['scrape_statistics','scrape_styles','update_style_stock','export_overview','scrape_customers','deep_scrape_styles','scrape_top_styles','export_top_styles','scrape_purchase_orders','fix_invoices','scrape_eans','export_stock_list','check_purchase_orders','scrape_style_raw_costs','run_statistics_email_pipeline']),
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

    // Safety: do not allow deep General scrape without spy_season_id on target season
    // Also block if the season is frozen (marked complete)
    try {
      if (body.type === 'scrape_statistics') {
        const toggles = (body.payload?.toggles as any) || {};
        const isDeep = Boolean(toggles.deep);
        const seasonId = (body.payload as any)?.seasonId as string | undefined;
        if (isDeep && seasonId) {
          const { data: s } = await supabase.from('seasons').select('spy_season_id, is_frozen').eq('id', seasonId).maybeSingle();
          const spy = (s as any)?.spy_season_id;
          if (!spy || String(spy).trim().length === 0) {
            return c.json({ error: 'Selected season has no SPY season id. Set it in Settings → Seasons before running deep scrape.' }, 400);
          }
          // Block if frozen
          if ((s as any)?.is_frozen) {
            return c.json({ error: 'Season is marked as Complete. Unmark it in Statistics → General before running scrape.', skipped: true, reason: 'season is frozen' }, 400);
          }
        }
      }
    } catch {}

    const isStock = body.type === 'update_style_stock' || body.type === 'scrape_eans';
    const insertBody = {
      type: body.type,
      payload: body.payload as any,
      status: 'queued' as const,
      max_attempts: 3,
      queue: isStock ? 'stock' : 'default',
      priority: isStock ? 200 : 100
    } as any;
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

    // Determine target styleNos: prefer provided, else union from app_settings.styles_user_selection (fallback to legacy styles_daily_selection)
    let styleNos: string[] = Array.isArray(body?.styleNos) ? body!.styleNos! : [];
    if (styleNos.length === 0) {
      const { data: sel } = await supabase.from('app_settings').select('value').eq('key', 'styles_user_selection').maybeSingle();
      const map = ((sel?.value as any) || {}) as Record<string, string[]>;
      const set = new Set<string>();
      for (const arr of Object.values(map)) for (const no of (arr || [])) if (typeof no === 'string') set.add(no);
      styleNos = Array.from(set);
      if (styleNos.length === 0) {
        const { data } = await supabase.from('app_settings').select('value').eq('key', 'styles_daily_selection').maybeSingle();
        styleNos = ((data?.value as any)?.styleNos as string[] | undefined) ?? [];
      }
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
        .insert({ type: 'update_style_stock', payload: { styleNos: b, requestedBy: email }, status: 'queued', max_attempts: 3, queue: 'stock', priority: 200 })
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

  // Check if the target season is frozen (marked complete) - skip if so
  if (seasonId) {
    try {
      const { data: seasonRow } = await supabase
        .from('seasons')
        .select('is_frozen')
        .eq('id', seasonId)
        .maybeSingle();
      if ((seasonRow as any)?.is_frozen) {
        logRequest('/cron/enqueue skipped', c, { reason: 'season is frozen', seasonId });
        return c.json({ skipped: true, reason: 'season is frozen (marked complete)', seasonId });
      }
    } catch {}
  }

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

/**
 * Purchase AI Analysis Automation
 * 
 * This endpoint runs the purchase AI comparison and analysis on the latest import.
 * Feature-flagged via PURCHASE_AI_ENABLED env var.
 * 
 * Usage:
 * - POST /cron/purchase-ai?seasonId=xxx&comparisonSeasonId=yyy
 * - Or configure via app_settings.purchase_ai_config
 */
const PURCHASE_AI_ENABLED = ((process.env.PURCHASE_AI_ENABLED || 'false').trim().toLowerCase() === 'true');

app.post('/cron/purchase-ai', async (c) => {
  if (!PURCHASE_AI_ENABLED) return c.json({ error: 'Purchase AI cron disabled. Set PURCHASE_AI_ENABLED=true' }, 403);
  const token = c.req.header('x-cron-token');
  if (!token || token !== CRON_TOKEN) return c.json({ error: 'Unauthorized' }, 401);

  logRequest('/cron/purchase-ai called', c, { PURCHASE_AI_ENABLED });

  try {
    // Get config from query params or app_settings
    let seasonId = c.req.query('seasonId') || null;
    let comparisonSeasonId = c.req.query('comparisonSeasonId') || null;
    let importId = c.req.query('importId') || null;

    // Load config from app_settings if not provided
    if (!seasonId || !comparisonSeasonId) {
      const { data: config } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'purchase_ai_config')
        .maybeSingle();
      
      const configVal = (config?.value as any) || {};
      seasonId = seasonId || configVal.seasonId || null;
      comparisonSeasonId = comparisonSeasonId || configVal.comparisonSeasonId || null;
    }

    // If no importId, get the latest completed import for the season
    if (!importId) {
      const query = supabase
        .from('purchase_sales_imports')
        .select('id')
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(1);
      
      if (seasonId) {
        query.eq('season_id', seasonId);
      }
      
      const { data: latestImport } = await query.maybeSingle();
      importId = (latestImport as any)?.id || null;
    }

    if (!importId) {
      logRequest('/cron/purchase-ai skipped', c, { reason: 'no import found' });
      return c.json({ skipped: true, reason: 'No sales import found for the specified season' });
    }

    // Check if we already ran analysis on this import recently (within last hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recentRun } = await supabase
      .from('purchase_ai_runs')
      .select('id, created_at')
      .eq('import_id', importId)
      .gte('created_at', oneHourAgo)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recentRun) {
      logRequest('/cron/purchase-ai skipped', c, { reason: 'recent run exists', runId: (recentRun as any)?.id });
      return c.json({ 
        skipped: true, 
        reason: 'Analysis already ran within the last hour',
        lastRunId: (recentRun as any)?.id,
        lastRunAt: (recentRun as any)?.created_at,
      });
    }

    // Call the comparison API (internal call via fetch to web app)
    const webOrigin = allowedOrigins[0] || 'http://localhost:3001';
    
    // First, run comparison
    logRequest('/cron/purchase-ai running comparison', c, { importId, seasonId, comparisonSeasonId });
    
    const compareRes = await fetch(`${webOrigin}/api/purchase/ai-suggestions/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ importId, seasonId, comparisonSeasonId }),
    });

    if (!compareRes.ok) {
      const err = await compareRes.json();
      logRequest('/cron/purchase-ai comparison failed', c, { error: err });
      return c.json({ error: 'Comparison failed', details: err }, 500);
    }

    const compareData = await compareRes.json();
    logRequest('/cron/purchase-ai comparison complete', c, { 
      currentQty: compareData.comparison?.overall?.currentSeason?.qty,
      lastYearQty: compareData.comparison?.overall?.lastSeasonTotal?.qty,
    });

    // Then, run AI analysis
    logRequest('/cron/purchase-ai running AI', c, { importId, seasonId, comparisonSeasonId });
    
    const aiRes = await fetch(`${webOrigin}/api/purchase/ai-suggestions/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ importId, seasonId, comparisonSeasonId }),
    });

    if (!aiRes.ok) {
      const err = await aiRes.json();
      logRequest('/cron/purchase-ai AI failed', c, { error: err });
      return c.json({ error: 'AI analysis failed', details: err }, 500);
    }

    const aiData = await aiRes.json();
    logRequest('/cron/purchase-ai complete', c, { 
      purchaseRunId: aiData.purchaseRunId,
      suppliersCount: aiData.suggestions?.suppliers?.length || 0,
      totalUnits: aiData.suggestions?.total_units || 0,
    });

    return c.json({
      success: true,
      importId,
      seasonId,
      comparisonSeasonId,
      purchaseRunId: aiData.purchaseRunId,
      aiRunId: aiData.aiRunId,
      comparison: {
        currentQty: compareData.comparison?.overall?.currentSeason?.qty,
        lastYearQty: compareData.comparison?.overall?.lastSeasonTotal?.qty,
        gapPercent: compareData.comparison?.overall?.gapToTarget?.qtyPercent,
      },
      suggestions: {
        suppliersCount: aiData.suggestions?.suppliers?.length || 0,
        totalUnits: aiData.suggestions?.total_units || 0,
      },
      runLabel: aiData.analysisBackground?.runLabel,
    });
  } catch (err: any) {
    logRequest('/cron/purchase-ai error', c, { error: err?.message });
    return c.json({ error: err?.message || 'Internal error' }, 500);
  }
});

/**
 * Get/Set Purchase AI configuration
 */
app.get('/purchase-ai/config', async (c) => {
  try {
    const payload = await verifySupabaseJWT(c.req.header('authorization'));
    const email = (payload?.email as string | undefined) ?? (payload?.user_metadata as any)?.email;
    if (!email) return c.json({ error: 'Unauthorized' }, 401);

    const { data } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'purchase_ai_config')
      .maybeSingle();

    return c.json({ 
      config: (data?.value as any) || {},
      cronEnabled: PURCHASE_AI_ENABLED,
    });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Error fetching config' }, 500);
  }
});

app.post('/purchase-ai/config', async (c) => {
  try {
    const payload = await verifySupabaseJWT(c.req.header('authorization'));
    const email = (payload?.email as string | undefined) ?? (payload?.user_metadata as any)?.email;
    if (!email) return c.json({ error: 'Unauthorized' }, 401);

    const body = await c.req.json<{
      seasonId?: string;
      comparisonSeasonId?: string;
    }>();

    const { data: existing } = await supabase
      .from('app_settings')
      .select('id')
      .eq('key', 'purchase_ai_config')
      .maybeSingle();

    const configValue = {
      seasonId: body.seasonId || null,
      comparisonSeasonId: body.comparisonSeasonId || null,
      updatedBy: email,
      updatedAt: new Date().toISOString(),
    };

    if (existing?.id) {
      await supabase
        .from('app_settings')
        .update({ value: configValue })
        .eq('key', 'purchase_ai_config');
    } else {
      await supabase
        .from('app_settings')
        .insert({ key: 'purchase_ai_config', value: configValue });
    }

    logRequest('/purchase-ai/config updated', c, { by: email });
    return c.json({ ok: true, config: configValue });
  } catch (err: any) {
    return c.json({ error: err?.message ?? 'Error updating config' }, 500);
  }
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

// deploy bump 2025-11-18
// redeploy bump 2025-11-18T2
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



import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type VercelCron = { path: string; schedule: string };

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

async function tryReadVercelJson(): Promise<{ crons: VercelCron[]; filePath: string }> {
  const candidates = [
    path.join(process.cwd(), 'vercel.json'),
    // In some environments cwd is repo root
    path.join(process.cwd(), 'apps', 'web', 'vercel.json'),
  ];
  let lastErr: any = null;
  for (const p of candidates) {
    try {
      const json = await readJsonFile<{ crons?: VercelCron[] }>(p);
      return { crons: (json?.crons ?? []) as VercelCron[], filePath: p };
    } catch (e: any) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Failed to read vercel.json');
}

function cronPathToRouteDir(cronPath: string): string | null {
  // "/api/cron/foo" -> "foo"
  const m = cronPath.match(/^\/api\/cron\/([^/?#]+)\s*$/);
  return m?.[1] || null;
}

async function tryReadCronRouteSource(routeDir: string): Promise<{ filePath: string; source: string } | null> {
  const candidates = [
    path.join(process.cwd(), 'app', 'api', 'cron', routeDir, 'route.ts'),
    // In some environments cwd is repo root
    path.join(process.cwd(), 'apps', 'web', 'app', 'api', 'cron', routeDir, 'route.ts'),
  ];
  for (const p of candidates) {
    try {
      const source = await fs.readFile(p, 'utf8');
      return { filePath: p, source };
    } catch {}
  }
  return null;
}

function extractInsertedJobTypes(source: string): string[] {
  const found: string[] = [];

  // Heuristic 1: object literals containing "type: '...'" near inserts
  const insertChunks = source.match(/from\(\s*['"]jobs['"]\s*\)[\s\S]{0,300}?insert\([\s\S]{0,1200}?\)/g) || [];
  for (const chunk of insertChunks) {
    const types = chunk.match(/type\s*:\s*['"]([^'"]+)['"]/g) || [];
    for (const t of types) {
      const m = t.match(/type\s*:\s*['"]([^'"]+)['"]/);
      if (m?.[1]) found.push(m[1]);
    }
  }

  // Heuristic 2: "const insertBody = { ... type: '...' ... }"
  const insertBodyChunks = source.match(/const\s+insertBody\s*=\s*\{[\s\S]{0,1200}?\};/g) || [];
  for (const chunk of insertBodyChunks) {
    const m = chunk.match(/type\s*:\s*['"]([^'"]+)['"]/);
    if (m?.[1]) found.push(m[1]);
  }

  return uniq(found).filter(Boolean);
}

export async function GET() {
  try {
    const { crons, filePath } = await tryReadVercelJson();

    // Build mapping: jobType -> schedules + cron paths
    const byJobType: Record<
      string,
      { enabled: boolean; schedules: string[]; cronPaths: string[]; derivedFrom: Array<{ cronPath: string; routeFile?: string | null }> }
    > = {};

    for (const c of crons) {
      const routeDir = cronPathToRouteDir(c.path);
      const route = routeDir ? await tryReadCronRouteSource(routeDir) : null;
      const jobTypes = route?.source ? extractInsertedJobTypes(route.source) : [];

      for (const jt of jobTypes) {
        const existing =
          byJobType[jt] ||
          (byJobType[jt] = { enabled: true, schedules: [], cronPaths: [], derivedFrom: [] });
        existing.schedules.push(c.schedule);
        existing.cronPaths.push(c.path);
        existing.derivedFrom.push({ cronPath: c.path, routeFile: route?.filePath || null });
      }
    }

    // Normalize arrays
    for (const jt of Object.keys(byJobType)) {
      byJobType[jt]!.schedules = uniq(byJobType[jt]!.schedules);
      byJobType[jt]!.cronPaths = uniq(byJobType[jt]!.cronPaths);
    }

    return NextResponse.json({
      vercelJsonPath: filePath,
      crons,
      byJobType,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to read cron config' }, { status: 500 });
  }
}


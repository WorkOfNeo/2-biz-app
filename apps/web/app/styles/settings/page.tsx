'use client';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { SearchSelect } from '../../../components/SearchSelect';
import { useRoles } from '../../../lib/supabaseClient';
import { ProgressBar } from '../../../components/ProgressBar';

export default function StylesSettingsPage() {
  const supabase = createClientComponentClient();
  const { has } = useRoles();
  const isAdmin = has('admin');
  const [runLoading, setRunLoading] = useState(false);
  // Deep scrape progress
  const [deepJobId, setDeepJobId] = useState<string | null>(null);
  const [deepProgress, setDeepProgress] = useState<{ index: number; total: number } | null>(null);
  const [deepDone, setDeepDone] = useState(false);
  const { data: styles } = useSWR(isAdmin ? 'styles:all' : null, async () => {
    type StyleRow = {
      id: string;
      style_no: string;
      style_name: string | null;
      style_type?: string | null;
      supplier: string | null;
      image_url?: string | null;
      scrape_enabled: boolean | null;
      updated_at: string;
    };
    async function fetchStyles(selectCols: string) {
      const { data, error } = await supabase
        .from('styles')
        .select(selectCols)
        .order('style_no', { ascending: true })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as unknown as Array<StyleRow>;
    }
    try {
      // Preferred set without style_type to avoid 400s on older DBs
      return await fetchStyles('id, style_no, style_name, supplier, image_url, scrape_enabled, updated_at');
    } catch (e1: any) {
      // eslint-disable-next-line no-console
      console.warn('[styles-settings] styles select failed, falling back minimal', e1?.message || e1);
      // Final fallback: minimal set without image_url
      const rows: Array<StyleRow> = await fetchStyles('id, style_no, style_name, supplier, scrape_enabled, updated_at');
      return rows.map((r) => ({ ...r, style_type: (r.style_type ?? null), image_url: (r.image_url ?? null) })) as Array<StyleRow>;
    }
  });
  const { data: styleSeasons } = useSWR(isAdmin ? 'style_seasons:all' : null, async () => {
    const { data, error } = await supabase.from('style_seasons').select('style_no, seasons').limit(5000);
    if (error) throw new Error(error.message);
    const byStyle = new Map<string, string[]>();
    const labels = new Set<string>();
    for (const r of (data ?? []) as any[]) {
      const arr = Array.isArray(r.seasons) ? (r.seasons as string[]) : [];
      byStyle.set(r.style_no, arr);
      for (const s of arr) labels.add(String(s));
    }
    return { byStyle, labels: Array.from(labels).sort() } as { byStyle: Map<string, string[]>; labels: string[] };
  }, { refreshInterval: 0 });
  // Seasons list for dropdown + code/hidden maps for display
  const { data: seasonsList } = useSWR(isAdmin ? 'seasons:list' : null, async () => {
    const { data, error } = await supabase.from('seasons').select('id, name, year, hidden').order('year', { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; name: string | null; year: number | null; hidden?: boolean | null }>;
  }, { refreshInterval: 0 });
  const seasonCodeById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of (seasonsList ?? [])) {
      const parts = String(s.name || '').trim().split(/\s+/).filter(Boolean);
      const letters = parts.map((w) => w[0]?.toUpperCase() ?? '').join('');
      const yy = s.year != null ? String(s.year).slice(-2) : '';
      m.set(String(s.id), `${letters}${yy}`);
    }
    return m;
  }, [seasonsList && (seasonsList as any).length]);
  const hiddenSeasonSet = useMemo(() => {
    const st = new Set<string>();
    for (const s of (seasonsList ?? [])) if ((s as any).hidden) st.add(String(s.id));
    return st;
  }, [seasonsList && (seasonsList as any).length]);
  const { data: colorSeasons } = useSWR(isAdmin ? 'style_color_seasons:all' : null, async () => {
    const pageSize = 2000;
    const out = new Map<string, string[]>();
    let from = 0;
    while (true) {
      const to = from + pageSize - 1;
      const { data, error } = await supabase
        .from('style_color_seasons')
        .select('style_color_id, season_id')
        .range(from, to);
      if (error) throw error;
      const batch = (data ?? []) as Array<{ style_color_id: string; season_id: string }>;
      for (const r of batch) {
        const arr = out.get(r.style_color_id) || [];
        if (!arr.includes(r.season_id)) arr.push(r.season_id);
        out.set(r.style_color_id, arr);
      }
      if (batch.length < pageSize) break;
      from += pageSize;
    }
    return out as Map<string, string[]>;
  }, { refreshInterval: 0 });
  const [seasonFilter, setSeasonFilter] = useState<string>('');
  const { data: colorsByStyle, mutate: mutateColors } = useSWR(isAdmin ? 'style_colors:all' : null, async () => {
    const pageSize = 1000;
    async function loadPaged(selectCols: string) {
      const all: any[] = [];
      let from = 0;
      while (true) {
        const to = from + pageSize - 1;
        // Primary attempt: order by color with range pagination
        const { data, error } = await supabase
          .from('style_colors')
          .select(selectCols)
          .order('color', { ascending: true })
          .range(from, to);
        if (error) {
          // eslint-disable-next-line no-console
          console.error('[styles-settings] style_colors loadPaged error (ordered/ranged)', error);
          throw error;
        }
        const batch = (data ?? []) as any[];
        all.push(...batch);
        if (batch.length < pageSize) break;
        from += pageSize;
      }
      return all;
    }
    try {
      const rows = await loadPaged('id, style_id, color, visible, updated_at');
      const map = new Map<string, Array<{ id: string; color: string; visible: boolean | null; updated_at: string }>>();
      for (const r of rows) {
        const arr = map.get(r.style_id) || [];
        arr.push({ id: r.id, color: r.color, visible: (r.visible as boolean | null) ?? null, updated_at: r.updated_at });
        map.set(r.style_id, arr);
      }
      return map;
    } catch (e1) {
      // eslint-disable-next-line no-console
      console.warn('[styles-settings] style_colors fallback without "visible" column', e1);
      // Fallback 1: when 'visible' column not present; default to null
      try {
        const rows = await loadPaged('id, style_id, color, updated_at');
        const map = new Map<string, Array<{ id: string; color: string; visible: boolean | null; updated_at: string }>>();
        for (const r of rows) {
          const arr = map.get(r.style_id) || [];
          arr.push({ id: r.id, color: r.color, visible: null, updated_at: r.updated_at });
          map.set(r.style_id, arr);
        }
        return map;
      } catch (e2) {
        // eslint-disable-next-line no-console
        console.warn('[styles-settings] style_colors fallback without order/range', e2);
        // Fallback 2: as a last resort, avoid order/range entirely
        const { data, error } = await supabase
          .from('style_colors')
          .select('id, style_id, color, visible, updated_at');
        if (error) {
          // eslint-disable-next-line no-console
          console.error('[styles-settings] style_colors final fetch failed', error);
          throw error;
        }
        const map = new Map<string, Array<{ id: string; color: string; visible: boolean | null; updated_at: string }>>();
    for (const r of (data ?? []) as any[]) {
      const arr = map.get(r.style_id) || [];
          arr.push({ id: r.id, color: r.color, visible: (r.visible as boolean | null) ?? null, updated_at: r.updated_at });
      map.set(r.style_id, arr);
    }
    return map;
      }
    }
  }, { refreshInterval: 0 });
  // Removed global color editor from this section
  // Per-user selection map: { [user_id]: string[] }
  const { data: selectionMap, mutate: mutateSelection } = useSWR(isAdmin ? 'app-settings:styles-user-selection' : null, async () => {
    const { data } = await supabase.from('app_settings').select('id, value').eq('key', 'styles_user_selection').maybeSingle();
    return { id: data?.id ?? null, value: ((data?.value as any) || {}) as Record<string, string[]> };
  });
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  (require('react') as typeof import('react')).useEffect(() => { (async () => { const { data: { session } } = await supabase.auth.getSession(); setCurrentUserId(session?.user?.id ?? null); })(); }, []);
  const selectedForUser = useMemo(() => {
    if (!currentUserId) return new Set<string>();
    const arr = selectionMap?.value?.[currentUserId] || [];
    return new Set<string>(arr);
  }, [selectionMap, currentUserId]);
  // Search by style name (and number)
  const [searchQuery, setSearchQuery] = useState('');
  // Build season filter options from style_seasons labels (these are strings like "25 WINTER")
  const seasonOptions = useMemo(() => {
    function formatLabel(lbl: string): string {
      const m = /^(\d{2})\s+(.*)$/i.exec(lbl.trim());
      if (m) {
        const yy = m[1] ?? '';
        const name = (m[2] ?? '').toUpperCase();
        const yyyy = yy ? `20${yy}` : '';
        return `${name}${yyyy ? ` ${yyyy}` : ''}`.trim() || lbl;
      }
      return lbl;
    }
    return (styleSeasons?.labels || []).map((lbl) => ({
      value: String(lbl),
      label: formatLabel(String(lbl))
    }));
  }, [styleSeasons?.labels && styleSeasons.labels.join('|')]);
  const filteredStyles = useMemo(() => {
    if (!styles) return [] as { id: string; style_no: string; style_name: string | null; scrape_enabled: boolean | null; updated_at: string }[];
    const q = searchQuery.trim().toLowerCase();
    let base = styles;
    if (seasonFilter) {
      base = base.filter((s) => {
        const arr = styleSeasons?.byStyle.get(s.style_no) || [];
        return arr.includes(seasonFilter);
      });
    }
    if (!q) return base;
    return base.filter((s) => {
      const name = (s.style_name || '').toLowerCase();
      const no = (s.style_no || '').toLowerCase();
      const type = (s as any).style_type ? String((s as any).style_type).toLowerCase() : '';
      return name.includes(q) || no.includes(q) || type.includes(q);
    });
  }, [styles, searchQuery, seasonFilter, styleSeasons?.labels.length]);

  // (Seasons column removed)
  // Poll deep scrape job logs to show progress
  (require('react') as typeof import('react')).useEffect(() => {
    if (!deepJobId) return;
    let timer: any;
    const poll = async () => {
      try {
        const { data: logs } = await supabase
          .from('job_logs')
          .select('msg, data')
          .eq('job_id', deepJobId)
          .order('ts', { ascending: false })
          .limit(50);
        for (const l of (logs ?? []) as any[]) {
          if (l.msg === 'STEP:deep_styles_progress' && l.data) {
            setDeepProgress({ index: Number(l.data.index || 0), total: Number(l.data.total || 0) });
            break;
          }
          if (l.msg === 'STEP:complete') {
            setDeepDone(true);
            break;
          }
        }
        // Also check job status to stop when finished
        const { data: jobRow } = await supabase.from('jobs').select('status').eq('id', deepJobId).maybeSingle();
        const st = (jobRow as any)?.status as string | undefined;
        if (st === 'succeeded' || st === 'failed' || st === 'cancelled') {
          setDeepDone(true);
        }
      } catch {}
    };
    timer = setInterval(poll, 1200);
    return () => { if (timer) clearInterval(timer); };
  }, [deepJobId]);
  async function toggleStyleForUser(styleNo: string) {
    if (!currentUserId) return;
    const map = { ...(selectionMap?.value || {}) } as Record<string, string[]>;
    const list = new Set<string>(map[currentUserId] || []);
    if (list.has(styleNo)) list.delete(styleNo); else list.add(styleNo);
    map[currentUserId] = Array.from(list);
    const existsId = selectionMap?.id || null;
    if (existsId) await supabase.from('app_settings').update({ value: map }).eq('id', existsId as any);
    else await supabase.from('app_settings').insert({ key: 'styles_user_selection', value: map } as any);
    await mutateSelection();
  }
  async function addAllFiltered() {
    if (!currentUserId) return;
    const map = { ...(selectionMap?.value || {}) } as Record<string, string[]>;
    const list = new Set<string>(map[currentUserId] || []);
    for (const s of filteredStyles) list.add(s.style_no);
    map[currentUserId] = Array.from(list);
    const existsId = selectionMap?.id || null;
    if (existsId) await supabase.from('app_settings').update({ value: map }).eq('id', existsId as any);
    else await supabase.from('app_settings').insert({ key: 'styles_user_selection', value: map } as any);
    await mutateSelection();
  }
  async function clearAll() {
    if (!currentUserId) return;
    const map = { ...(selectionMap?.value || {}) } as Record<string, string[]>;
    map[currentUserId] = [];
    const existsId = selectionMap?.id || null;
    if (existsId) await supabase.from('app_settings').update({ value: map }).eq('id', existsId as any);
    else await supabase.from('app_settings').insert({ key: 'styles_user_selection', value: map } as any);
    await mutateSelection();
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Styles</div>
        <h1 className="text-xl font-semibold">Settings</h1>
      </div>

      {!isAdmin && (
        <div className="rounded-md border bg-white p-3 text-sm text-gray-600">Not authorized.</div>
      )}

      {isAdmin && (
      <div className="rounded-md border bg-white p-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Often Scraped Styles</div>
          <div className="flex items-center gap-2">
            <input
              className="text-xs border rounded px-2 py-1 w-56"
              placeholder="Search styles"
              value={searchQuery}
              onChange={(e)=>setSearchQuery(e.target.value)}
            />
            <SearchSelect
              items={seasonOptions}
              value={seasonFilter}
              onChange={setSeasonFilter}
              placeholder="All seasons"
              clearable
              className="min-w-[16rem]"
            />
            <button className="text-xs px-2 py-1 border rounded bg-slate-900 text-white hover:bg-slate-800" onClick={addAllFiltered}>Add all</button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded border">
            <div className="px-2 py-1 text-xs font-medium border-b bg-gray-50">All styles</div>
            <div className="max-h-96 overflow-auto divide-y text-xs">
              {(filteredStyles as any[] ?? []).filter((s)=>!selectedForUser.has(s.style_no)).map((s) => {
                const name = (s.style_name && s.style_name.trim()) ? s.style_name : '—';
                return (
                  <div key={s.id} className="flex items-center justify-between px-2 py-1 hover:bg-slate-50">
                    <div className="flex items-center gap-2 min-w-0">
                      <Thumb src={s.image_url || ''} />
                      <div className="truncate">
                        <div className="font-medium text-gray-900 truncate">{s.style_no}</div>
                        <div className="text-gray-700 truncate">{name}</div>
                        <ColorsLine styleId={s.id} colorsByStyle={colorsByStyle} colorSeasons={colorSeasons} seasonCodeById={seasonCodeById} hiddenSeasonSet={hiddenSeasonSet} />
                      </div>
                    </div>
                    <button
                      className="text-[11px] px-2 py-1 border rounded bg-slate-900 text-white hover:bg-slate-800 shrink-0"
                      onClick={async ()=>{ await toggleStyleForUser(s.style_no); }}
                    >Add</button>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="rounded border">
            <div className="px-2 py-1 text-xs font-medium border-b bg-gray-50">Often scraped</div>
            <div className="max-h-96 overflow-auto divide-y text-xs">
              {(styles ?? []).filter((s)=>selectedForUser.has(s.style_no)).map((s) => {
                const name = (s.style_name && s.style_name.trim()) ? s.style_name : '—';
                return (
                  <div key={s.id} className="flex items-center justify-between px-2 py-1 hover:bg-slate-50">
                    <div className="flex items-center gap-2 min-w-0">
                      <Thumb src={s.image_url || ''} />
                      <div className="truncate">
                        <div className="font-medium text-gray-900 truncate">{s.style_no}</div>
                        <div className="text-gray-700 truncate">{name}</div>
                        <ColorsLine styleId={s.id} colorsByStyle={colorsByStyle} colorSeasons={colorSeasons} seasonCodeById={seasonCodeById} hiddenSeasonSet={hiddenSeasonSet} />
                      </div>
                    </div>
                    <button
                      className="text-[11px] px-2 py-1 border rounded bg-white text-slate-900 hover:bg-slate-100 shrink-0"
                      onClick={async ()=>{ await toggleStyleForUser(s.style_no); }}
                    >Remove</button>
                  </div>
                );
              })}
              {(styles ?? []).filter((s)=>selectedForUser.has(s.style_no)).length === 0 && (
                <div className="px-2 py-2 text-[11px] text-gray-500">No styles selected.</div>
              )}
            </div>
            {has('admin') && (
              <div className="flex justify-end p-2">
                <button className="text-[11px] text-gray-600 hover:text-black underline" onClick={clearAll}>Clear</button>
              </div>
            )}
          </div>
        </div>
      </div>
      )}

      {/* Colors per style removed */}

      {isAdmin && (
      <div className="rounded-md border bg-white p-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Runs</div>
          <a
            href="/styles/runs"
            className="text-xs px-2 py-1 border rounded bg-slate-900 text-white hover:bg-slate-800"
          >
            Open runs
          </a>
        </div>
        <div className="mt-2 text-xs text-gray-600">Run all style-related tasks from the Runs page.</div>
      </div>
      )}

      {isAdmin && (
      <div className="rounded-md border bg-white p-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Deep Scrape</div>
          <a
            href="/styles/runs"
            className="text-xs px-2 py-1 border rounded bg-slate-900 text-white hover:bg-slate-800"
          >
            Open runs
          </a>
        </div>
        <div className="mt-2 text-xs text-gray-600">Deep scrape controls moved to Runs.</div>
        {deepJobId && (
          <div className="mt-2 flex items-center gap-2">
            <div className="w-56"><ProgressBar value={(() => {
              const p = deepProgress;
              if (!p || !p.total) return 5;
              return Math.max(5, Math.min(99, Math.round((p.index / p.total) * 100)));
            })()} /></div>
            <div>{deepProgress ? `${Math.min(deepProgress.index, deepProgress.total)}/${deepProgress.total || '?'}` : ''}{deepDone ? ' Done' : ''}</div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}

function Thumb({ src }: { src: string }) {
  const React = require('react') as typeof import('react');
  const [imgSrc, setImgSrc] = React.useState<string>(src);
  const [attempt, setAttempt] = React.useState<number>(0);
  React.useEffect(() => { setImgSrc(src); setAttempt(0); }, [src]);
  if (!imgSrc) return <div className="w-7 h-7 rounded border bg-gray-100" />;
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={imgSrc}
      alt=""
      className="w-7 h-7 rounded object-cover border"
      onError={() => {
        // Try smaller transforms, then drop transform, then hide
        if (attempt === 0 && /tr:n-s1024/i.test(imgSrc)) {
          setImgSrc(imgSrc.replace(/tr:n-s1024/ig, 'tr:n-s512'));
          setAttempt(1);
          return;
        }
        if (attempt === 1 && /tr:n-s512/i.test(imgSrc)) {
          setImgSrc(imgSrc.replace(/tr:n-s512/ig, 'tr:n-s256'));
          setAttempt(2);
          return;
        }
        if (attempt === 2 && /\/tr:n-s\d+\//i.test(imgSrc)) {
          setImgSrc(imgSrc.replace(/\/tr:n-s\d+\//ig, '/'));
          setAttempt(3);
          return;
        }
        // Give up, show placeholder
        setImgSrc('');
      }}
    />
  );
}

function ColorsLine({
  styleId,
  colorsByStyle,
  colorSeasons,
  seasonCodeById,
  hiddenSeasonSet,
}: {
  styleId: string;
  colorsByStyle: Map<string, Array<{ id: string; color: string; visible: boolean | null; updated_at: string }>> | undefined;
  colorSeasons: Map<string, string[]> | undefined;
  seasonCodeById: Map<string, string> | undefined;
  hiddenSeasonSet: Set<string> | undefined;
}) {
  const React = require('react') as typeof import('react');
  const colors = (colorsByStyle?.get(styleId) || []) as Array<{ id: string; color: string }>;
  if (!colors.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {colors.map((c) => {
        const seasonIds = (colorSeasons?.get(c.id) || []).filter((sid) => !(hiddenSeasonSet?.has(sid)));
        const labels = seasonIds.map((sid) => seasonCodeById?.get(sid) || sid);
        return (
          <span key={c.id} className="inline-flex items-center gap-1 border rounded px-1 py-0.5 bg-white">
            <span className="text-[11px] text-gray-800">{c.color}</span>
            <span className="text-[10px] text-gray-500">{labels.join(' / ') || '—'}</span>
          </span>
        );
      })}
    </div>
  );
}


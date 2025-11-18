'use client';
import * as React from 'react';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { SearchSelect } from '../../../components/SearchSelect';

type TabKey = 'scraping' | 'stock-lists';

export default function StylesSettingsPage() {
  const [tab, setTab] = React.useState<TabKey>('scraping');
  const supabase = createClientComponentClient();

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Styles</div>
        <h1 className="text-xl font-semibold">Settings</h1>
      </div>

      <div className="rounded-md border bg-white">
        <div className="flex items-center gap-1 border-b px-2 pt-2">
          <TabButton active={tab==='scraping'} onClick={()=>setTab('scraping')}>Scraping</TabButton>
          <TabButton active={tab==='stock-lists'} onClick={()=>setTab('stock-lists')}>Stock Lists</TabButton>
        </div>
        <div className="p-4">
          {tab === 'scraping' && (
            <ScrapingTab supabase={supabase} />
          )}
          {tab === 'stock-lists' && (
            <div className="text-sm text-gray-700">
              Placeholder — Stock Lists management will live here.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ScrapingTab({ supabase }: { supabase: any }) {
  const ReactNS = React as typeof import('react');
  // Load styles
  type StyleRow = { id: string; style_no: string; style_name: string | null; supplier: string | null; image_url: string | null };
  const { data: styles } = useSWR('styles:all:scraping', async () => {
    const { data, error } = await supabase
      .from('styles')
      .select('id, style_no, style_name, supplier, image_url')
      .order('style_no', { ascending: true })
      .limit(2000);
    if (error) throw error;
    return (data ?? []) as StyleRow[];
  }, { refreshInterval: 0 });
  // Colors
  const { data: colorsByStyle } = useSWR('style_colors:map', async () => {
    const pageSize = 1000;
    const rows: any[] = [];
    let from = 0;
    while (true) {
      const to = from + pageSize - 1;
      const { data, error } = await supabase.from('style_colors').select('id, style_id, color').order('color').range(from, to);
      if (error) throw error;
      const batch = data ?? [];
      rows.push(...batch);
      if (batch.length < pageSize) break;
      from += pageSize;
    }
    const map = new Map<string, Array<{ id: string; color: string }>>();
    for (const r of rows) {
      const arr = map.get(r.style_id) || [];
      arr.push({ id: r.id, color: r.color });
      map.set(r.style_id, arr);
    }
    return map;
  }, { refreshInterval: 0 });
  // Seasons
  const { data: seasons } = useSWR('seasons:list:min', async () => {
    const { data, error } = await supabase.from('seasons').select('id, name, year, hidden').order('year', { ascending: false });
    if (error) throw error;
    return (data ?? []) as Array<{ id: string; name: string | null; year: number | null; hidden?: boolean | null }>;
  }, { refreshInterval: 0 });
  const seasonCodeById = ReactNS.useMemo(() => {
    const m = new Map<string, string>();
    for (const s of (seasons ?? [])) {
      const parts = String(s.name || '').trim().split(/\s+/).filter(Boolean);
      const letters = parts.map((w) => w[0]?.toUpperCase() ?? '').join('');
      const yy = s.year != null ? String(s.year).slice(-2) : '';
      m.set(String(s.id), `${letters}${yy}`);
    }
    return m;
  }, [seasons && seasons.length]);
  const seasonLabelById = ReactNS.useMemo(() => {
    // style_seasons stores labels like "25 WINTER"
    const m = new Map<string, string>();
    for (const s of (seasons ?? [])) {
      const yy = s.year != null ? String(s.year).slice(-2) : '';
      const name = String(s.name || '').toUpperCase();
      if (yy && name) m.set(String(s.id), `${yy} ${name}`);
    }
    return m;
  }, [seasons && seasons.length]);
  const hiddenSeasonSet = ReactNS.useMemo(() => {
    const st = new Set<string>();
    for (const s of (seasons ?? [])) if ((s as any).hidden) st.add(String(s.id));
    return st;
  }, [seasons && seasons.length]);
  // Color -> seasons map
  const { data: colorSeasons } = useSWR('style_color_seasons:map', async () => {
    const pageSize = 2000;
    const out = new Map<string, string[]>();
    let from = 0;
    while (true) {
      const to = from + pageSize - 1;
      const { data, error } = await supabase.from('style_color_seasons').select('style_color_id, season_id').range(from, to);
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
  // style_seasons for filtering
  const { data: styleSeasons } = useSWR('style_seasons:byStyle', async () => {
    const { data, error } = await supabase.from('style_seasons').select('style_no, seasons').limit(5000);
    if (error) throw error;
    const byStyle = new Map<string, string[]>();
    const labels = new Set<string>();
    for (const r of (data ?? []) as any[]) {
      const arr = Array.isArray(r.seasons) ? (r.seasons as string[]) : [];
      byStyle.set(r.style_no, arr);
      for (const s of arr) labels.add(String(s));
    }
    return { byStyle, labels: Array.from(labels).sort() } as { byStyle: Map<string, string[]>; labels: string[] };
  }, { refreshInterval: 0 });
  // Per-user selection
  const { data: selectionMap, mutate: mutateSelection } = useSWR('app-settings:styles-user-selection', async () => {
    const { data } = await supabase.from('app_settings').select('id, value').eq('key', 'styles_user_selection').maybeSingle();
    return { id: data?.id ?? null, value: ((data?.value as any) || {}) as Record<string, string[]> };
  });
  const [currentUserId, setCurrentUserId] = ReactNS.useState<string | null>(null);
  ReactNS.useEffect(() => { (async () => { const { data: { session } } = await supabase.auth.getSession(); setCurrentUserId(session?.user?.id ?? null); })(); }, []);
  const selectedSet = ReactNS.useMemo(() => {
    if (!currentUserId) return new Set<string>();
    return new Set<string>(selectionMap?.value?.[currentUserId] || []);
  }, [selectionMap, currentUserId]);
  async function toggle(styleNo: string) {
    if (!currentUserId) return;
    const map = { ...(selectionMap?.value || {}) } as Record<string, string[]>;
    const list = new Set<string>(map[currentUserId] || []);
    if (list.has(styleNo)) list.delete(styleNo); else list.add(styleNo);
    map[currentUserId] = Array.from(list);
    if (selectionMap?.id) await supabase.from('app_settings').update({ value: map }).eq('id', selectionMap.id as any);
    else await supabase.from('app_settings').insert({ key: 'styles_user_selection', value: map } as any);
    await mutateSelection();
  }
  // Filters
  const [qLeft, setQLeft] = ReactNS.useState('');
  const [qRight, setQRight] = ReactNS.useState('');
  const [seasonLeft, setSeasonLeft] = ReactNS.useState<string>('');
  const [seasonRight, setSeasonRight] = ReactNS.useState<string>('');
  function applyFilter(list: StyleRow[], q: string, seasonId: string) {
    let out = list;
    const target = seasonId ? (seasonLabelById.get(seasonId) || '') : '';
    if (target) {
      out = out.filter((s) => {
        const arr = styleSeasons?.byStyle.get(s.style_no) || [];
        return arr.includes(target);
      });
    }
    const qq = q.trim().toLowerCase();
    if (!qq) return out;
    return out.filter((s) => {
      const name = (s.style_name || '').toLowerCase();
      const no = (s.style_no || '').toLowerCase();
      return name.includes(qq) || no.includes(qq);
    });
  }
  const leftItems = ReactNS.useMemo(() => applyFilter(styles ?? [], qLeft, seasonLeft), [styles, qLeft, seasonLeft, styleSeasons && (styleSeasons.labels || []).length]);
  const rightItems = ReactNS.useMemo(() => {
    const selected = (styles ?? []).filter((s) => selectedSet.has(s.style_no));
    return applyFilter(selected, qRight, seasonRight);
  }, [styles, selectedSet.size, qRight, seasonRight, styleSeasons && (styleSeasons.labels || []).length]);
  const seasonSelectItems = ReactNS.useMemo(() => {
    return (seasons ?? [])
      .filter((s) => !(s as any).hidden)
      .map((s) => ({ value: String(s.id), label: seasonCodeById.get(String(s.id)) || String(s.id) }));
  }, [seasons && seasons.length, seasonCodeById && Array.from(seasonCodeById.keys()).length]);

  // Manual run: enqueue selected scrape and measure elapsed seconds
  const [runBusy, setRunBusy] = ReactNS.useState(false);
  const [runJobId, setRunJobId] = ReactNS.useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = ReactNS.useState<number>(0);
  const [completedSec, setCompletedSec] = ReactNS.useState<number | null>(null);
  ReactNS.useEffect(() => {
    let t: any;
    if (runJobId && !completedSec) {
      t = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    }
    return () => { if (t) clearInterval(t); };
  }, [runJobId, completedSec]);
  ReactNS.useEffect(() => {
    if (!runJobId) return;
    let t: any;
    const poll = async () => {
      try {
        const { data } = await supabase.from('jobs').select('status, started_at, finished_at').eq('id', runJobId).maybeSingle();
        const st = (data as any)?.status as string | undefined;
        const startedAt = (data as any)?.started_at ? new Date((data as any).started_at).getTime() : null;
        const finishedAt = (data as any)?.finished_at ? new Date((data as any).finished_at).getTime() : null;
        if (st && (st === 'succeeded' || st === 'failed' || st === 'cancelled')) {
          let secs: number;
          if (startedAt && finishedAt) secs = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
          else secs = elapsedSec;
          setCompletedSec(secs);
          setRunBusy(false);
          return;
        }
      } catch {}
    };
    t = setInterval(poll, 1200);
    return () => { if (t) clearInterval(t); };
  }, [runJobId, elapsedSec]);

  return (
    <div className="text-sm text-gray-700">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs text-gray-600">Run scraping for “Often scraped” selection.</div>
        <button
          className={"text-xs px-2 py-1 border rounded " + (runBusy ? 'bg-slate-300 text-gray-800' : 'bg-slate-900 text-white hover:bg-slate-800')}
          disabled={runBusy}
          onClick={async () => {
            try {
              setRunBusy(true);
              setRunJobId(null);
              setElapsedSec(0);
              setCompletedSec(null);
              const { data: { session } } = await supabase.auth.getSession();
              if (!session) throw new Error('Not signed in');
              const res = await fetch('/api/enqueue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
                body: JSON.stringify({ type: 'update_style_stock', payload: { requestedBy: session.user.email, mode: 'selected' } })
              });
              const js = await res.json().catch(() => ({}));
              if (!res.ok || !js?.jobId) throw new Error(js?.error || 'Failed to enqueue');
              setRunJobId(js.jobId as string);
            } catch (e: any) {
              alert(e?.message || 'Failed to enqueue run');
              setRunBusy(false);
            }
          }}
        >
          {runBusy ? 'Running…' : 'Run selected now'}
        </button>
      </div>
      {runJobId && (
        <div className="mb-3 text-xs text-gray-700">
          Job: <span className="font-mono">{runJobId.slice(0,8)}…</span> · Elapsed: {completedSec ?? elapsedSec}s {completedSec != null ? '(completed)' : ''}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded border">
          <div className="px-2 py-1 text-xs font-medium border-b bg-gray-50">All styles</div>
          <div className="p-2 flex items-center gap-2">
            <input className="text-xs border rounded px-2 py-1 w-56" placeholder="Search style no / name" value={qLeft} onChange={(e)=>setQLeft(e.target.value)} />
            <SearchSelect items={seasonSelectItems} value={seasonLeft} onChange={setSeasonLeft} placeholder="All seasons" clearable />
          </div>
          <div className="max-h-96 overflow-auto divide-y">
            {(leftItems ?? []).map((s) => {
              const added = selectedSet.has(s.style_no);
              return (
                <div key={s.id} className={"flex items-start justify-between gap-2 px-2 py-2 " + (added ? 'bg-slate-50' : '')}>
                  <div className="flex items-start gap-2 min-w-0">
                    <Thumb src={s.image_url || ''} />
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate">{s.style_no}</div>
                      <div className="text-gray-700 truncate">{s.style_name ?? '—'}</div>
                      <ColorsLine styleId={s.id} colorsByStyle={colorsByStyle} colorSeasons={colorSeasons} seasonCodeById={seasonCodeById} hiddenSeasonSet={hiddenSeasonSet} />
                    </div>
                  </div>
                  <button className={"text-[11px] px-2 py-1 rounded border " + (added ? 'bg-slate-300 text-gray-800' : 'bg-slate-900 text-white hover:bg-slate-800')} onClick={()=>toggle(s.style_no)}>{added ? 'Added' : 'Add'}</button>
        </div>
                );
              })}
          </div>
        </div>
        <div className="rounded border">
          <div className="px-2 py-1 text-xs font-medium border-b bg-gray-50">Often scraped</div>
          <div className="p-2 flex items-center gap-2">
            <input className="text-xs border rounded px-2 py-1 w-56" placeholder="Search style no / name" value={qRight} onChange={(e)=>setQRight(e.target.value)} />
            <SearchSelect items={seasonSelectItems} value={seasonRight} onChange={setSeasonRight} placeholder="All seasons" clearable />
          </div>
          <div className="max-h-96 overflow-auto divide-y">
            {(rightItems ?? []).map((s) => (
              <div key={s.id} className="flex items-start justify-between gap-2 px-2 py-2">
                <div className="flex items-start gap-2 min-w-0">
                  <Thumb src={s.image_url || ''} />
                  <div className="min-w-0">
                    <div className="font-medium text-gray-900 truncate">{s.style_no}</div>
                    <div className="text-gray-700 truncate">{s.style_name ?? '—'}</div>
                    <ColorsLine styleId={s.id} colorsByStyle={colorsByStyle} colorSeasons={colorSeasons} seasonCodeById={seasonCodeById} hiddenSeasonSet={hiddenSeasonSet} />
      </div>
        </div>
                <button className="text-[11px] px-2 py-1 rounded border bg-white text-slate-900 hover:bg-slate-100" onClick={()=>toggle(s.style_no)}>Remove</button>
      </div>
            ))}
            {(rightItems ?? []).length === 0 && (
              <div className="px-2 py-2 text-[11px] text-gray-500">No styles selected.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={
        "rounded-t-md px-3 py-1.5 text-xs " +
        (active ? "bg-slate-900 text-white" : "bg-white text-slate-900 border")
      }
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function Thumb({ src }: { src: string }) {
  const ReactNS = React as typeof import('react');
  const [imgSrc, setImgSrc] = ReactNS.useState<string>(src);
  const [attempt, setAttempt] = ReactNS.useState<number>(0);
  ReactNS.useEffect(() => { setImgSrc(src); setAttempt(0); }, [src]);
  if (!imgSrc) return <div className="w-7 h-7 rounded border bg-gray-100" />;
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={imgSrc}
      alt=""
      className="w-7 h-7 rounded object-cover border"
      onError={() => {
        if (attempt === 0 && /tr:n-s1024/i.test(imgSrc)) { setImgSrc(imgSrc.replace(/tr:n-s1024/ig, 'tr:n-s512')); setAttempt(1); return; }
        if (attempt === 1 && /tr:n-s512/i.test(imgSrc)) { setImgSrc(imgSrc.replace(/tr:n-s512/ig, 'tr:n-s256')); setAttempt(2); return; }
        if (attempt === 2 && /\/tr:n-s\d+\//i.test(imgSrc)) { setImgSrc(imgSrc.replace(/\/tr:n-s\d+\//ig, '/')); setAttempt(3); return; }
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
  colorsByStyle: Map<string, Array<{ id: string; color: string }>> | undefined;
  colorSeasons: Map<string, string[]> | undefined;
  seasonCodeById: Map<string, string> | undefined;
  hiddenSeasonSet: Set<string> | undefined;
}) {
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



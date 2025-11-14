'use client';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { useRoles } from '../../../lib/supabaseClient';
import { useRouter } from 'next/navigation';

export default function StyleDetailPage({ params }: { params: { styleNo: string } }) {
  const supabase = createClientComponentClient();
  const router = useRouter();
  const styleNo = decodeURIComponent(params.styleNo);

  const { data: meta, mutate: mutateMeta } = useSWR(['style:meta', styleNo], async () => {
    const { data, error } = await supabase
      .from('styles')
      .select('id, style_no, style_name, supplier, image_url, link_href, updated_at')
      .eq('style_no', styleNo)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data as { id: string; style_no: string; style_name: string | null; supplier: string | null; image_url: string | null; link_href: string | null; updated_at: string } | null;
  });

  const { data: colors, mutate: mutateColors } = useSWR(['style:colors', styleNo, meta?.id], async () => {
    if (!meta?.id) return [] as Array<{ id: string; color: string; visible: boolean | null; updated_at: string | null }>;
    try {
      const { data, error } = await supabase
        .from('style_colors')
        .select('id, color, visible, updated_at')
        .eq('style_id', meta.id)
        .order('color');
      if (error) throw error as any;
      return (data ?? []) as Array<{ id: string; color: string; visible: boolean | null; updated_at: string | null }>;
    } catch (e: any) {
      // Fallback if column `visible` does not exist yet or any error occurs
      const { data } = await supabase
        .from('style_colors')
        .select('id, color, updated_at')
        .eq('style_id', meta.id)
        .order('color');
      return ((data ?? []) as any[]).map((r) => ({ ...r, visible: null })) as Array<{ id: string; color: string; visible: boolean | null; updated_at: string | null }>;
    }
  });
  const { has } = useRoles();

  const { data: colorSeasons } = useSWR(meta?.id ? ['style:color-seasons', meta.id] : null, async () => {
    // Load style_colors ids for this style
    const { data: sc, error: scErr } = await supabase.from('style_colors').select('id, color').eq('style_id', meta!.id).order('color');
    if (scErr) throw scErr as any;
    const ids = (sc ?? []).map((r: any) => r.id as string);
    if (ids.length === 0) return { map: new Map<string, string[]>(), seasons: new Map<string, { name: string; year: number | null }>() };
    const { data: links } = await supabase.from('style_color_seasons').select('style_color_id, season_id').in('style_color_id', ids).limit(100000);
    const seasonIds = Array.from(new Set((links ?? []).map((r: any) => r.season_id as string))).filter(Boolean);
    const { data: seas } = await supabase.from('seasons').select('id, name, year').in('id', seasonIds).limit(100000);
    const map = new Map<string, string[]>();
    for (const r of (links ?? []) as any[]) {
      const arr = map.get(r.style_color_id) || [];
      arr.push(r.season_id as string);
      map.set(r.style_color_id, arr);
    }
    const sMap = new Map<string, { name: string; year: number | null }>();
    for (const s of (seas ?? []) as any[]) sMap.set(s.id as string, { name: s.name as string, year: (s.year as number | null) ?? null });
    return { map, seasons: sMap } as { map: Map<string, string[]>; seasons: Map<string, { name: string; year: number | null }> };
  }, { refreshInterval: 0 });

  async function onDelete() {
    if (!meta?.style_no) return;
    const ok = window.confirm(`Permanently delete style ${meta.style_no} and all related data?\nThis cannot be undone.`);
    if (!ok) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const res = await fetch('/api/styles/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ styleNo: meta.style_no })
      });
      if (!res.ok) {
        const js = await res.json().catch(() => ({}));
        throw new Error(js?.error || 'Delete failed');
      }
      router.push('/styles');
    } catch (e: any) {
      alert(e?.message || 'Failed to delete style');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-4">
          {meta?.image_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={meta.image_url} alt={meta.style_name ?? meta.style_no} className="h-24 w-24 object-cover rounded border" />
          )}
          <div>
            <div className="text-xs text-gray-500">Style</div>
            <h1 className="text-xl font-semibold">{styleNo}</h1>
            <div className="text-sm text-gray-700">{meta?.style_name ?? '—'}</div>
            {meta?.supplier && <div className="text-xs text-gray-500">Supplier: {meta.supplier}</div>}
            {meta?.link_href && (() => {
              const base = (process?.env?.NEXT_PUBLIC_SPY_BASE_URL || '').replace(/\/$/, '');
              let abs = '' as string;
              try {
                // Only build absolute SPY URL; do not fall back to current site origin
                const candidate = base ? new URL(meta.link_href as string, base).toString() : meta.link_href as string;
                if (/^https?:\/\//i.test(candidate)) abs = candidate;
              } catch {}
              if (!abs) return null; // hide links if we cannot ensure SPY absolute URL
              const statUrl = abs.replace(/#.*$/, '') + '#tab=statandstock';
              return (
                <div className="flex items-center gap-3 mt-1">
                  <a className="text-xs underline text-slate-700" href={abs} target="_blank" rel="noopener noreferrer">Open in 2-Biz</a>
                  <a className="text-xs underline text-slate-700" href={statUrl} target="_blank" rel="noopener noreferrer">Stat & Stock</a>
                </div>
              );
            })()}
          </div>
        </div>
        {has('admin') && (
          <button
            className="text-xs px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700"
            onClick={onDelete}
            title="Permanently delete this style"
          >
            Permanently Delete
          </button>
        )}
      </div>

      <div className="rounded-md border bg-white p-3">
        <div className="text-sm font-medium mb-2">Colors</div>
        <div className="flex flex-col gap-2">
          {(colors ?? []).length === 0 && <div className="text-xs text-gray-500">No colors found yet.</div>}
          {(colors ?? []).map((c) => (
            <div key={c.id} className="rounded border px-2 py-1 text-sm bg-gray-50">
              <div className="flex items-center justify-between">
                <div className="font-medium">{c.color}</div>
                {has('admin') && (
                <label className="text-xs flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-slate-900 rounded"
                    checked={c.visible !== false}
                    onChange={async (e) => {
                      try {
                        const next = e.target.checked;
                        // Optimistic update
                        await mutateColors(async (prev: any) => {
                          const arr = Array.isArray(prev) ? prev.slice() : [];
                          for (let i = 0; i < arr.length; i++) {
                            if ((arr[i] as any).id === c.id) { (arr[i] as any).visible = next; break; }
                          }
                          // Persist to DB
                          const { error } = await supabase.from('style_colors').update({ visible: next }).eq('id', c.id);
                          if (error) throw error as any;
                          return arr;
                        }, false);
                      } catch (err: any) {
                        if (err?.code === '42703') {
                          alert('Visibility field not available yet. Please run the database migration for style_colors.visible');
                        } else {
                          alert(err?.message || 'Failed to update visibility');
                          // Revalidate to rollback UI if needed
                          try { await mutateColors(); } catch {}
                        }
                      }
                    }}
                  />
                  <span>Visible on Stock List</span>
                </label>
                )}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {(() => {
                  const ids = colorSeasons?.map.get(c.id) || [];
                  const labels = ids.map((id) => colorSeasons?.seasons.get(id)).filter(Boolean) as Array<{ name: string; year: number | null }>;
                  if (labels.length === 0) return <span className="text-[11px] text-gray-500">No seasons yet.</span>;
                  return labels.map((s, i) => (
                    <span key={i} className="inline-flex items-center rounded border px-1.5 py-0.5 text-[11px]">{s.name}{s.year ? ` ${s.year}` : ''}</span>
                  ));
                })()}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}




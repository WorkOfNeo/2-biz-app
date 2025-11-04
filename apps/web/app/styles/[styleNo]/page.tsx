'use client';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { useRoles } from '../../../lib/supabaseClient';

export default function StyleDetailPage({ params }: { params: { styleNo: string } }) {
  const supabase = createClientComponentClient();
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

  const { data: colors } = useSWR(['style:colors', styleNo, meta?.id], async () => {
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

  return (
    <div className="space-y-4">
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

      <div className="rounded-md border bg-white p-3">
        <div className="text-sm font-medium mb-2">Colors</div>
        <div className="flex flex-col gap-2">
          {(colors ?? []).length === 0 && <div className="text-xs text-gray-500">No colors found yet.</div>}
          {(colors ?? []).map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded border px-2 py-1 text-sm bg-gray-50">
              <div className="font-medium">{c.color}</div>
              {has('admin') && (
                <label className="text-xs flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-slate-900 rounded"
                    checked={c.visible !== false}
                    onChange={async (e) => {
                      try {
                        await supabase.from('style_colors').update({ visible: e.target.checked }).eq('id', c.id);
                      } catch (err: any) {
                        if (err?.code === '42703') {
                          alert('Visibility field not available yet. Please run the database migration for style_colors.visible');
                        }
                      }
                    }}
                  />
                  <span>Visible on Stock List</span>
                </label>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}




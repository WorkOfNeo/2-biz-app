'use client';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

export default function StyleDetailPage({ params }: { params: { styleNo: string } }) {
  const supabase = createClientComponentClient();
  const styleNo = decodeURIComponent(params.styleNo);

  const { data: meta } = useSWR(['style:meta', styleNo], async () => {
    const { data, error } = await supabase
      .from('styles')
      .select('style_no, style_name, supplier, image_url, link_href, updated_at')
      .eq('style_no', styleNo)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data as { style_no: string; style_name: string | null; supplier: string | null; image_url: string | null; link_href: string | null; updated_at: string } | null;
  });

  const { data: colors } = useSWR(['style:colors', styleNo], async () => {
    const { data, error } = await supabase
      .from('style_stock')
      .select('color, scraped_at')
      .eq('style_no', styleNo)
      .order('scraped_at', { ascending: false });
    if (error) throw new Error(error.message);
    // distinct by color, keep most recent scraped_at
    const map = new Map<string, string>();
    for (const r of (data ?? []) as any[]) {
      const c = (r.color || '').toString();
      if (!map.has(c)) map.set(c, r.scraped_at as string);
    }
    return Array.from(map.entries()).map(([color, scraped_at]) => ({ color, scraped_at }));
  });

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
          {meta?.link_href && (
            <a className="text-xs underline text-slate-700" href={meta.link_href} target="_blank" rel="noreferrer">Open in 2-Biz</a>
          )}
        </div>
      </div>

      <div className="rounded-md border bg-white p-3">
        <div className="text-sm font-medium mb-2">Colors</div>
        <div className="flex flex-wrap gap-2">
          {(colors ?? []).length === 0 && <div className="text-xs text-gray-500">No colors found yet.</div>}
          {(colors ?? []).map((c) => (
            <div key={c.color} className="rounded border px-2 py-1 text-sm bg-gray-50">
              <div className="font-medium">{c.color}</div>
              <div className="text-[10px] text-gray-500">Scraped: {new Date(c.scraped_at).toLocaleString()}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}




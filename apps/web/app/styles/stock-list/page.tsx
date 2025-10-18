'use client';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

type Row = {
  style_no: string;
  color: string;
  sizes: string[];
  section: string;
  row_label: string | null;
  values: number[];
  po_link: string | null;
  scraped_at: string;
};

export default function StockListPage() {
  const supabase = createClientComponentClient();
  const { data } = useSWR('style_stock:list', async () => {
    const { data, error } = await supabase
      .from('style_stock')
      .select('style_no, color, sizes, section, row_label, values, po_link, scraped_at')
      .order('scraped_at', { ascending: false })
      .limit(1000);
    if (error) throw new Error(error.message);
    return (data ?? []) as Row[];
  }, { refreshInterval: 15000 });

  // Group by style_no then color
  const grouped = new Map<string, Map<string, Row[]>>();
  for (const r of (data ?? [])) {
    if (!grouped.has(r.style_no)) grouped.set(r.style_no, new Map());
    const byColor = grouped.get(r.style_no)!;
    if (!byColor.has(r.color)) byColor.set(r.color, []);
    byColor.get(r.color)!.push(r);
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Styles</div>
        <h1 className="text-xl font-semibold">Stock List</h1>
      </div>

      {[...grouped.entries()].map(([styleNo, colors]) => (
        <div key={styleNo} className="rounded-md border bg-white">
          <div className="px-3 py-2 text-sm font-semibold border-b">{styleNo}</div>
          {[...colors.entries()].map(([color, rows]) => (
            <div key={color} className="px-3 py-2">
              <div className="text-xs text-gray-600 mb-2">{color}</div>
              <div className="overflow-auto border rounded">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="p-2 text-left border-b">Section</th>
                      <th className="p-2 text-left border-b">Row</th>
                      <th className="p-2 text-left border-b">Values</th>
                      <th className="p-2 text-left border-b">PO</th>
                      <th className="p-2 text-left border-b">Scraped</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td className="p-2 border-b">{r.section}</td>
                        <td className="p-2 border-b">{r.row_label ?? '—'}</td>
                        <td className="p-2 border-b">{r.values.join(', ')}</td>
                        <td className="p-2 border-b">{r.po_link ? <a className="underline" href={r.po_link} target="_blank" rel="noreferrer">Open</a> : '—'}</td>
                        <td className="p-2 border-b">{new Date(r.scraped_at).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}



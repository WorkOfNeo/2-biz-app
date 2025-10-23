'use client';
import useSWR from 'swr';
import { supabase } from '../../../../lib/supabaseClient';

type ExportRow = { id: string; kind: string; title: string | null; path: string; public_url: string | null; created_at: string };

export default function CountriesExportsPage() {
  const { data } = useSWR('exports:countries', async () => {
    const { data, error } = await supabase
      .from('exports')
      .select('id, kind, title, path, public_url, created_at')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []) as ExportRow[];
  }, { refreshInterval: 10000 });

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Exports</div>
        <h1 className="text-xl font-semibold">Generated Files</h1>
      </div>

      <div className="rounded-md border overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-2 text-left border-b">When</th>
              <th className="p-2 text-left border-b">Kind</th>
              <th className="p-2 text-left border-b">Title</th>
              <th className="p-2 text-left border-b">Path</th>
              <th className="p-2 text-left border-b">Link</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((r) => (
              <tr key={r.id}>
                <td className="p-2 border-b whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</td>
                <td className="p-2 border-b">{r.kind}</td>
                <td className="p-2 border-b">{r.title ?? '—'}</td>
                <td className="p-2 border-b font-mono text-[12px]">{r.path}</td>
                <td className="p-2 border-b">{r.public_url ? <a href={r.public_url} target="_blank" rel="noreferrer" className="text-blue-700 underline">Open</a> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}



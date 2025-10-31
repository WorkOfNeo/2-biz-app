'use client';
import React from 'react';
import useSWR from 'swr';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '../../../../lib/supabaseClient';

export default function SalespersonDetailPage() {
  const params = useParams();
  const id = String(params?.id || '');

  const { data: sp, mutate } = useSWR(id ? `salesperson:${id}` : null, async () => {
    const { data, error } = await supabase.from('salespersons').select('id, name, currency, email').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data as any;
  });

  const { data: exportsRows } = useSWR(id ? `exports:by-salesperson:${id}` : null, async () => {
    const { data, error } = await supabase
      .from('exports')
      .select('id, created_at, kind, title, path, public_url, meta')
      .eq('kind', 'general_salesmen_pdfs')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return (data ?? []) as any[];
  }, { refreshInterval: 15000 });

  async function save(field: 'name' | 'email' | 'currency', value: string) {
    if (!sp) return;
    const payload: any = { [field]: value || null };
    const { error } = await supabase.from('salespersons').update(payload).eq('id', sp.id);
    if (error) throw new Error(error.message);
    await mutate();
  }

  async function downloadPath(path: string, publicUrl?: string | null) {
    try {
      const { data: file, error } = await supabase.storage.from('exports').download(path);
      if (error || !file) throw error || new Error('Download failed');
      const blobUrl = URL.createObjectURL(file as unknown as Blob);
      const a = document.createElement('a');
      a.href = blobUrl; a.download = path.split('/').pop() || 'file.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(blobUrl);
    } catch {
      if (publicUrl) window.open(publicUrl, '_blank', 'noopener');
    }
  }

  const myFiles: Array<{ created_at: string; name: string; path: string; publicUrl?: string | null }> = React.useMemo(() => {
    const out: Array<{ created_at: string; name: string; path: string; publicUrl?: string | null }> = [];
    for (const row of (exportsRows ?? [])) {
      const files = (row.meta?.files as Array<any>) || [];
      for (const f of files) {
        if (f.salesperson_id === id) out.push({ created_at: row.created_at, name: f.name, path: f.path, publicUrl: f.publicUrl });
      }
    }
    out.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return out;
  }, [exportsRows, id]);

  if (!id) return <div className="p-4">Missing id</div>;
  if (!sp) return <div className="p-4">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-gray-500"><Link href="/settings/salespersons" className="hover:underline">Salespersons</Link> /</div>
          <h1 className="text-xl font-semibold">{sp.name}</h1>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border rounded-md p-3 space-y-3">
          <div className="text-sm font-medium">Profile</div>
          <label className="block text-sm">
            <div className="text-gray-600 mb-1">Name</div>
            <input className="w-full rounded border px-2 py-1 text-sm" defaultValue={sp.name || ''} onBlur={(e) => save('name', e.target.value)} />
          </label>
          <label className="block text-sm">
            <div className="text-gray-600 mb-1">Email</div>
            <input type="email" className="w-full rounded border px-2 py-1 text-sm" defaultValue={sp.email || ''} placeholder="name@example.com" onBlur={(e) => save('email', e.target.value)} />
          </label>
          <label className="block text-sm">
            <div className="text-gray-600 mb-1">Currency</div>
            <select className="w-full rounded border px-2 py-1 text-sm" defaultValue={sp.currency || 'DKK'} onChange={(e) => save('currency', e.target.value)}>
              {['DKK','SEK','NOK','EUR'].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>

        <div className="border rounded-md p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">My PDFs</div>
          </div>
          {myFiles.length === 0 && (
            <div className="text-sm text-gray-500">No PDFs yet.</div>
          )}
          {myFiles.length > 0 && (
            <div className="divide-y">
              {myFiles.map((f, i) => (
                <div key={i} className="py-2 flex items-center justify-between">
                  <div className="text-sm">
                    <div className="font-medium">{f.name}</div>
                    <div className="text-xs text-gray-500">{new Date(f.created_at).toLocaleString()}</div>
                  </div>
                  <button className="rounded-md border px-2 py-1 text-xs hover:bg-slate-50" onClick={() => downloadPath(f.path, f.publicUrl)}>Download</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}



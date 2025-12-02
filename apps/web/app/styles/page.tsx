'use client';
import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import useSWR from 'swr';

export default function StylesPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [q, setQ] = useState('');
  const supabase = createClientComponentClient();

  const { data: rows, mutate } = useSWR(['styles:list', q], async () => {
    let query = supabase.from('styles').select('id, style_no, style_name, supplier, image_url, link_href, maybe_inactive, inactive').order('updated_at', { ascending: false }).limit(200);
    if (q && q.trim().length > 0) query = query.ilike('style_no', `%${q.trim()}%`);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data as any[];
  });

  async function enqueueUpdate() {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ type: 'scrape_styles', payload: { requestedBy: session.user.email } })
      });
      const js = await res.json().catch(() => ({}));
      // eslint-disable-next-line no-console
      console.log('[styles] enqueue', res.status, js);
      try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('job-started', { detail: { label: 'Update styles — job started' } })); } catch {}
      setMenuOpen(false);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[styles] enqueue error', e);
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-gray-500">Styles</div>
          <h1 className="text-xl font-semibold">STYLES</h1>
        </div>
        <div className="relative">
          <button className="p-1 rounded hover:bg-gray-100" onClick={() => setMenuOpen((v) => !v)}>
            <MoreHorizontal className="h-5 w-5" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 mt-2 w-44 rounded-md border bg-white shadow">
              <button className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50" onClick={enqueueUpdate}>Update styles</button>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-md border bg-white p-3 text-sm">
        <div className="mb-3 flex items-center gap-2">
          <input value={q} onChange={(e)=>setQ(e.target.value)} placeholder="Search style no..." className="border rounded p-2 text-sm w-64" />
        </div>
        <div className="overflow-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-2 border-b">Image</th>
                <th className="text-left p-2 border-b">Style No.</th>
                <th className="text-left p-2 border-b">Style Name</th>
              <th className="text-left p-2 border-b">Supplier</th>
              <th className="text-left p-2 border-b">DG</th>
                <th className="text-left p-2 border-b">Status</th>
                <th className="text-left p-2 border-b">Link</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((r) => (
                <tr key={r.style_no} className="hover:bg-gray-50">
                  <td className="p-2 border-b cursor-pointer" onClick={() => { window.location.href = `/styles/${encodeURIComponent(r.style_no)}`; }}>{r.image_url ? <img src={r.image_url} alt="thumb" className="h-8 w-8 object-cover rounded" /> : null}</td>
                  <td className="p-2 border-b underline text-slate-700 cursor-pointer" onClick={() => { window.location.href = `/styles/${encodeURIComponent(r.style_no)}`; }}>{r.style_no}</td>
                  <td className="p-2 border-b cursor-pointer" onClick={() => { window.location.href = `/styles/${encodeURIComponent(r.style_no)}`; }}>{r.style_name ?? '—'}</td>
                  <td className="p-2 border-b cursor-pointer" onClick={() => { window.location.href = `/styles/${encodeURIComponent(r.style_no)}`; }}>{r.supplier ?? '—'}</td>
                  <td className="p-2 border-b cursor-pointer" onClick={() => { window.location.href = `/styles/${encodeURIComponent(r.style_no)}`; }}>{(r as any).dg ?? '—'}</td>
                  <td className="p-2 border-b">
                    <div className="flex items-center gap-2">
                      {r.maybe_inactive && !r.inactive && <span className="text-[10px] px-1.5 py-0.5 bg-yellow-100 text-yellow-800 rounded">Maybe Inactive</span>}
                      {r.inactive && <span className="text-[10px] px-1.5 py-0.5 bg-red-100 text-red-800 rounded">Inactive</span>}
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            const newInactive = !r.inactive;
                            await supabase.from('styles').update({ inactive: newInactive }).eq('id', r.id);
                            await mutate();
                          } catch (err) {
                            console.error('Failed to toggle inactive', err);
                          }
                        }}
                        className={`text-[10px] px-2 py-1 rounded border ${r.inactive ? 'bg-green-50 text-green-700 border-green-300 hover:bg-green-100' : 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'}`}
                      >
                        {r.inactive ? 'Activate' : 'Set Inactive'}
                      </button>
                    </div>
                  </td>
                  <td className="p-2 border-b">{r.link_href ? <a className="underline" href={r.link_href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open</a> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}



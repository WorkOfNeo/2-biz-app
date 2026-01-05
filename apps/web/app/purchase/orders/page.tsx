"use client";

import { useEffect, useState } from 'react';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

type PoRow = {
  status: string | null;
  po_no: string;
  supplier: string | null;
  styles: number | null;
  ordered: number | null;
  etd: string | null;
  eta: string | null;
  purchaser: string | null;
  po_link: string | null;
};

export default function PurchaseOrdersPage() {
  const supabase = createClientComponentClient();
  const [rows, setRows] = useState<PoRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [itemsByPo, setItemsByPo] = useState<Record<string, Array<{ style_no: string | null; style_name: string | null; color: string | null; qty: number | null; style_link: string | null }>>>({});

  async function fetchRows() {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select('status, po_no, supplier, styles, ordered, etd, eta, purchaser, po_link')
        .order('status', { ascending: true })
        .order('updated_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      setRows((data ?? []) as any);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchRows();
    const id = setInterval(fetchRows, 10000);
    return () => clearInterval(id);
  }, []);

  async function syncPOs() {
    setSyncing(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ type: 'scrape_purchase_orders', payload: { requestedBy: session.user.email } })
      });
      // eslint-disable-next-line no-console
      console.log('[purchase/orders] sync POs enqueue', res.status);
    } finally {
      setSyncing(false);
    }
  }

  async function loadItems(poNo: string) {
    try {
      const { data, error } = await supabase
        .from('purchase_order_items')
        .select('style_no, style_name, color, qty, style_link')
        .eq('po_no', poNo)
        .order('id', { ascending: true })
        .limit(1000);
      if (error) throw error;
      setItemsByPo((prev) => ({ ...prev, [poNo]: (data ?? []) as any }));
    } catch {
      setItemsByPo((prev) => ({ ...prev, [poNo]: [] }));
    }
  }

  function toggleExpand(poNo: string) {
    setExpanded((prev) => {
      const on = !prev[poNo];
      if (on) loadItems(poNo);
      return { ...prev, [poNo]: on };
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Purchase Orders</h1>
        <div className="flex items-center gap-2">
          <button
            className={"text-xs px-3 py-1.5 border rounded bg-slate-900 text-white hover:bg-slate-800 " + (syncing ? 'opacity-60 cursor-not-allowed' : '')}
            onClick={syncPOs}
            disabled={syncing}
          >Sync PO's</button>
        </div>
      </div>

      <div className="rounded-md border bg-white overflow-hidden">
        <table className="min-w-full text-xs">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-2 text-left border-b">Status</th>
              <th className="p-2 text-left border-b"></th>
              <th className="p-2 text-left border-b">PO No.</th>
              <th className="p-2 text-left border-b">Supplier</th>
              <th className="p-2 text-right border-b">Styles</th>
              <th className="p-2 text-right border-b">Ordered</th>
              <th className="p-2 text-left border-b">ETD</th>
              <th className="p-2 text-left border-b">ETA</th>
              <th className="p-2 text-left border-b">Purchaser</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="p-4 text-center text-gray-500">{loading ? 'Loading…' : 'No data'}</td>
              </tr>
            )}
            {rows.map((r) => (
              <>
                <tr key={r.po_no} className="hover:bg-slate-50">
                  <td className="p-2 border-b">{r.status || '—'}</td>
                  <td className="p-2 border-b">
                    <button className="text-slate-600 hover:text-slate-900" onClick={() => toggleExpand(r.po_no)} aria-label="Expand">
                      {expanded[r.po_no] ? '▾' : '▸'}
                    </button>
                  </td>
                  <td className="p-2 border-b">
                    {r.po_link ? (
                      <a className="underline" href={r.po_link} target="_blank" rel="noreferrer">{r.po_no}</a>
                    ) : r.po_no}
                  </td>
                  <td className="p-2 border-b">{r.supplier || '—'}</td>
                  <td className="p-2 border-b text-right">{r.styles ?? '—'}</td>
                  <td className="p-2 border-b text-right">{r.ordered ?? '—'}</td>
                  <td className="p-2 border-b">{r.etd || '—'}</td>
                  <td className="p-2 border-b">{r.eta || '—'}</td>
                  <td className="p-2 border-b">{r.purchaser || '—'}</td>
                </tr>
                {expanded[r.po_no] && (
                  <tr key={r.po_no + ':items'}>
                    <td colSpan={9} className="p-0 border-b">
                      <div className="bg-slate-50 px-3 py-2">
                        <div className="overflow-auto">
                          <table className="min-w-full text-xs">
                            <thead>
                              <tr>
                                <th className="p-2 text-left border-b">Style No.</th>
                                <th className="p-2 text-left border-b">Style Name</th>
                                <th className="p-2 text-left border-b">Color</th>
                                <th className="p-2 text-right border-b">Qty</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(itemsByPo[r.po_no] ?? []).map((it, idx) => (
                                <tr key={r.po_no + ':' + idx}>
                                  <td className="p-2 border-b">
                                    {it.style_link ? (
                                      <a className="underline" href={it.style_link || undefined} target="_blank" rel="noreferrer">{it.style_no || '—'}</a>
                                    ) : (it.style_no || '—')}
                                  </td>
                                  <td className="p-2 border-b">{it.style_name || '—'}</td>
                                  <td className="p-2 border-b">{it.color || '—'}</td>
                                  <td className="p-2 border-b text-right">{it.qty ?? '—'}</td>
                                </tr>
                              ))}
                              {((itemsByPo[r.po_no] ?? []).length === 0) && (
                                <tr>
                                  <td className="p-2 border-b text-slate-500" colSpan={4}>No items yet. Click "Check Orders" to fetch details.</td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}



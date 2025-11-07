"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
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
  const [enqueuing, setEnqueuing] = useState(false);

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

  async function runScrape() {
    setEnqueuing(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ type: 'scrape_purchase_orders', payload: { requestedBy: session.user.email } })
      });
      // eslint-disable-next-line no-console
      console.log('[purchase/orders] enqueue', res.status);
    } finally {
      setEnqueuing(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Purchase Orders</h1>
        <button
          className={"text-xs px-3 py-1.5 border rounded bg-slate-900 text-white hover:bg-slate-800 " + (enqueuing ? 'opacity-60 cursor-not-allowed' : '')}
          onClick={runScrape}
          disabled={enqueuing}
        >Run Scrape</button>
      </div>

      <div className="rounded-md border bg-white overflow-hidden">
        <table className="min-w-full text-xs">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-2 text-left border-b">Status</th>
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
              <tr key={r.po_no} className="hover:bg-slate-50">
                <td className="p-2 border-b">{r.status || '—'}</td>
                <td className="p-2 border-b">
                  {r.po_link ? (
                    <Link className="underline" href={r.po_link} target="_blank" rel="noreferrer">{r.po_no}</Link>
                  ) : r.po_no}
                </td>
                <td className="p-2 border-b">{r.supplier || '—'}</td>
                <td className="p-2 border-b text-right">{r.styles ?? '—'}</td>
                <td className="p-2 border-b text-right">{r.ordered ?? '—'}</td>
                <td className="p-2 border-b">{r.etd || '—'}</td>
                <td className="p-2 border-b">{r.eta || '—'}</td>
                <td className="p-2 border-b">{r.purchaser || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}



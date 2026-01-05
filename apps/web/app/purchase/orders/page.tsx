"use client";

import { useEffect, useState, useMemo } from 'react';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { ChevronDown, ChevronRight, RefreshCw, Package, CheckCircle2, Truck } from 'lucide-react';

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

type PoItem = {
  style_no: string | null;
  style_name: string | null;
  color: string | null;
  qty: number | null;
  style_link: string | null;
};

function StatusIndicator({ status }: { status: string | null }) {
  if (status === 'Running') {
    return (
      <div className="flex items-center gap-1.5">
        <div className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" />
        <span className="text-xs font-medium text-amber-700">Running</span>
      </div>
    );
  }
  if (status === 'Shipped') {
    return (
      <div className="flex items-center gap-1.5">
        <Truck className="w-3.5 h-3.5 text-blue-500" />
        <span className="text-xs font-medium text-blue-700">Shipped</span>
      </div>
    );
  }
  if (status === 'Delivered') {
    return (
      <div className="flex items-center gap-1.5">
        <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
        <span className="text-xs font-medium text-green-700">Delivered</span>
      </div>
    );
  }
  return <span className="text-xs text-slate-400">—</span>;
}

function POTable({ 
  rows, 
  expanded, 
  itemsByPo, 
  onToggle,
  emptyMessage 
}: { 
  rows: PoRow[]; 
  expanded: Record<string, boolean>;
  itemsByPo: Record<string, PoItem[]>;
  onToggle: (poNo: string) => void;
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-slate-500">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b bg-slate-50/50">
            <th className="w-8 p-3"></th>
            <th className="p-3 text-left font-medium text-slate-600">Status</th>
            <th className="p-3 text-left font-medium text-slate-600">PO No.</th>
            <th className="p-3 text-left font-medium text-slate-600">Supplier</th>
            <th className="p-3 text-right font-medium text-slate-600">Styles</th>
            <th className="p-3 text-right font-medium text-slate-600">Ordered</th>
            <th className="p-3 text-left font-medium text-slate-600">ETD</th>
            <th className="p-3 text-left font-medium text-slate-600">ETA</th>
            <th className="p-3 text-left font-medium text-slate-600">Purchaser</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <>
              <tr key={r.po_no} className="hover:bg-slate-50/50 transition-colors">
                <td className="p-3">
                  <button 
                    className="p-1 rounded hover:bg-slate-200 transition-colors" 
                    onClick={() => onToggle(r.po_no)} 
                    aria-label="Expand"
                  >
                    {expanded[r.po_no] ? (
                      <ChevronDown className="w-4 h-4 text-slate-500" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-slate-400" />
                    )}
                  </button>
                </td>
                <td className="p-3">
                  <StatusIndicator status={r.status} />
                </td>
                <td className="p-3">
                  {r.po_link ? (
                    <a 
                      className="font-medium text-blue-600 hover:text-blue-800 hover:underline" 
                      href={r.po_link} 
                      target="_blank" 
                      rel="noreferrer"
                    >
                      {r.po_no}
                    </a>
                  ) : (
                    <span className="font-medium">{r.po_no}</span>
                  )}
                </td>
                <td className="p-3 text-slate-700">{r.supplier || '—'}</td>
                <td className="p-3 text-right tabular-nums text-slate-700">{r.styles ?? '—'}</td>
                <td className="p-3 text-right tabular-nums font-medium">{r.ordered?.toLocaleString() ?? '—'}</td>
                <td className="p-3">
                  {r.etd ? (
                    <Badge className="bg-slate-100 text-slate-700 border-slate-200">{r.etd}</Badge>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="p-3">
                  {r.eta ? (
                    <Badge className="bg-blue-50 text-blue-700 border-blue-200">{r.eta}</Badge>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="p-3 text-slate-600">{r.purchaser || '—'}</td>
              </tr>
              {expanded[r.po_no] && (
                <tr key={r.po_no + ':items'}>
                  <td colSpan={9} className="p-0 bg-slate-50">
                    <div className="px-6 py-4 ml-8 border-l-2 border-slate-200">
                      <div className="text-xs font-medium text-slate-500 mb-2">Line Items</div>
                      {(itemsByPo[r.po_no] ?? []).length === 0 ? (
                        <div className="text-sm text-slate-400 italic">
                          No items loaded. Items are fetched during sync.
                        </div>
                      ) : (
                        <div className="grid gap-2">
                          {(itemsByPo[r.po_no] ?? []).map((it, idx) => (
                            <div 
                              key={r.po_no + ':' + idx} 
                              className="flex items-center gap-4 text-sm bg-white rounded border px-3 py-2"
                            >
                              <div className="flex-1">
                                {it.style_link ? (
                                  <a 
                                    className="font-medium text-blue-600 hover:underline" 
                                    href={it.style_link} 
                                    target="_blank" 
                                    rel="noreferrer"
                                  >
                                    {it.style_no || '—'}
                                  </a>
                                ) : (
                                  <span className="font-medium">{it.style_no || '—'}</span>
                                )}
                                {it.style_name && (
                                  <span className="ml-2 text-slate-500">{it.style_name}</span>
                                )}
                              </div>
                              {it.color && (
                                <Badge className="bg-slate-100 border-slate-200">{it.color}</Badge>
                              )}
                              <div className="tabular-nums font-medium w-16 text-right">
                                {it.qty?.toLocaleString() ?? '—'}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PurchaseOrdersPage() {
  const supabase = createClientComponentClient();
  const [rows, setRows] = useState<PoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [itemsByPo, setItemsByPo] = useState<Record<string, PoItem[]>>({});

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
      setRows((data ?? []) as PoRow[]);
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
      await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ type: 'scrape_purchase_orders', payload: { requestedBy: session.user.email } })
      });
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
      setItemsByPo((prev) => ({ ...prev, [poNo]: (data ?? []) as PoItem[] }));
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

  // Split rows by status
  const { runningRows, deliveredRows } = useMemo(() => {
    const running: PoRow[] = [];
    const delivered: PoRow[] = [];
    for (const r of rows) {
      if (r.status === 'Delivered') {
        delivered.push(r);
      } else {
        running.push(r);
      }
    }
    return { runningRows: running, deliveredRows: delivered };
  }, [rows]);

  // Calculate totals
  const runningTotal = runningRows.reduce((sum, r) => sum + (r.ordered ?? 0), 0);
  const deliveredTotal = deliveredRows.reduce((sum, r) => sum + (r.ordered ?? 0), 0);

  return (
    <div className="p-4 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-slate-500">Purchase</div>
          <h1 className="text-2xl font-semibold">Purchase Orders</h1>
        </div>
        <button
          className={`
            inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
            bg-slate-900 text-white hover:bg-slate-800 transition-colors
            disabled:opacity-60 disabled:cursor-not-allowed
          `}
          onClick={syncPOs}
          disabled={syncing}
        >
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing...' : "Sync PO's"}
        </button>
      </div>

      {loading && rows.length === 0 && (
        <div className="py-12 text-center text-slate-500">Loading...</div>
      )}

      {/* Running Orders */}
      <Card>
        <CardHeader className="bg-amber-50/50">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-100">
              <Package className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <CardTitle className="text-base">Active Orders</CardTitle>
              <div className="text-xs text-slate-500 mt-0.5">
                {runningRows.length} order{runningRows.length !== 1 ? 's' : ''} • {runningTotal.toLocaleString()} pcs
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <POTable
            rows={runningRows}
            expanded={expanded}
            itemsByPo={itemsByPo}
            onToggle={toggleExpand}
            emptyMessage="No active orders"
          />
        </CardContent>
      </Card>

      {/* Delivered Orders */}
      <Card>
        <CardHeader className="bg-green-50/50">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-100">
              <CheckCircle2 className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <CardTitle className="text-base">Delivered Orders</CardTitle>
              <div className="text-xs text-slate-500 mt-0.5">
                {deliveredRows.length} order{deliveredRows.length !== 1 ? 's' : ''} • {deliveredTotal.toLocaleString()} pcs
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <POTable
            rows={deliveredRows}
            expanded={expanded}
            itemsByPo={itemsByPo}
            onToggle={toggleExpand}
            emptyMessage="No delivered orders yet"
          />
        </CardContent>
      </Card>
    </div>
  );
}

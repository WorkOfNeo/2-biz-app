'use client';
import React from 'react';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Modal } from '../../../components/Modal';

type ShopMap = Record<string, string>; // shopId -> customer_id

export default function MakePurchaseOrderPage() {
  const supabase = createClientComponentClient();
  const [activeTab, setActiveTab] = React.useState<'nielsens' | 'other'>('nielsens');
  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Purchase</div>
        <h1 className="text-xl font-semibold">Make Purchase Order</h1>
      </div>
      <div className="flex items-center gap-2">
        <button
          className={'px-3 py-1.5 text-sm rounded border ' + (activeTab==='nielsens' ? 'bg-slate-900 text-white' : 'bg-white')}
          onClick={() => setActiveTab('nielsens')}
        >Nielsens</button>
        <button
          className={'px-3 py-1.5 text-sm rounded border ' + (activeTab==='other' ? 'bg-slate-900 text-white' : 'bg-white')}
          onClick={() => setActiveTab('other')}
        >???</button>
      </div>
      {activeTab === 'nielsens' ? <NielsensPanel /> : (
        <div className="rounded border bg-white p-3 text-sm text-gray-600">Coming soon…</div>
      )}
    </div>
  );
}

function NielsensPanel() {
  const supabase = createClientComponentClient();
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const { data: shopMapResp, mutate: mutateShopMap } = useSWR('purchase:nielsens:shop-map', async () => {
    const { data } = await supabase.from('app_settings').select('id, value').eq('key', 'nielsens_shop_map').maybeSingle();
    return { id: data?.id ?? null, value: ((data?.value as any) || {}) as ShopMap };
  }, { refreshInterval: 0 });

  // Upload + mapping
  const [files, setFiles] = React.useState<File[]>([]);
  const [fileSummaries, setFileSummaries] = React.useState<Array<{ name: string; headers: string[] }>>([]);
  const [headers, setHeaders] = React.useState<string[]>([]);
  const [firstColMismatch, setFirstColMismatch] = React.useState<string | null>(null);
  const [shopIdCol, setShopIdCol] = React.useState<string>('');
  const [eanCol, setEanCol] = React.useState<string>('');
  const [qtyCol, setQtyCol] = React.useState<string>('');
  const [extOrderCol, setExtOrderCol] = React.useState<string>('');
  const [delivery, setDelivery] = React.useState<string>('');
  const [rowsOut, setRowsOut] = React.useState<Array<{ ShopID: string; SpyAccountNo: string; Delivery: string; EAN: string; QTY: number; ExternalOrderNo: string | null }>>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onFilesSelected(list: FileList | null) {
    setError(null);
    if (!list || list.length === 0) { setFiles([]); setFileSummaries([]); setHeaders([]); setFirstColMismatch(null); return; }
    const arr = Array.from(list).slice(0, 20);
    setFiles(arr);
    try {
      const XLSX = await import('xlsx');
      const summaries: Array<{ name: string; headers: string[] }> = [];
      for (const f of arr) {
        const buf = await f.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const first = wb.SheetNames?.[0] || null;
        if (!first) continue;
        const ws = wb.Sheets[first];
        const json = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
        const hdr = (Array.isArray(json?.[0]) ? (json[0] as any[]) : []).map((x) => String(x ?? '').trim());
        summaries.push({ name: f.name, headers: hdr });
      }
      setFileSummaries(summaries);
      // Check first column header identical across files
      const firstCols = summaries.map(s => (s.headers?.[0] ?? '').toLowerCase());
      const base = firstCols[0] || '';
      const mismatch = firstCols.some(h => h !== base);
      setFirstColMismatch(mismatch ? 'First column differs across uploaded files' : null);
      // Provide header options from the first file
      setHeaders(summaries[0]?.headers || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to parse files');
    }
  }

  async function convertFiles() {
    setBusy(true); setError(null);
    try {
      if (!files.length) throw new Error('Upload files first');
      if (!shopIdCol || !eanCol || !qtyCol) throw new Error('Map required columns (ShopID, EAN, QTY)');
      const XLSX = await import('xlsx');
      const map: ShopMap = (shopMapResp?.value || {}) as ShopMap;
      const allRows: Array<{ ShopID: string; SpyAccountNo: string; Delivery: string; EAN: string; QTY: number; ExternalOrderNo: string | null }> = [];
      for (const f of files) {
        const buf = await f.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const first = wb.SheetNames?.[0] || null;
        if (!first) continue;
        const ws = wb.Sheets[first];
        const json = XLSX.utils.sheet_to_json(ws) as Array<Record<string, any>>;
        for (const r of json) {
          const shopIdRaw = String(r[shopIdCol] ?? '').trim();
          if (!shopIdRaw) continue;
          const spyAcc = map?.[shopIdRaw] ?? '';
          const ean = String(r[eanCol] ?? '').trim();
          const qty = Number(r[qtyCol] ?? 0) || 0;
          const ext = extOrderCol ? (String(r[extOrderCol] ?? '').trim() || null) : null;
          allRows.push({
            ShopID: shopIdRaw,
            SpyAccountNo: spyAcc,
            Delivery: delivery || '',
            EAN: ean,
            QTY: qty,
            ExternalOrderNo: ext
          });
        }
      }
      setRowsOut(allRows);
    } catch (e: any) {
      setError(e?.message || 'Failed to convert');
    } finally {
      setBusy(false);
    }
  }

  async function exportExcel() {
    try {
      if (!rowsOut.length) { alert('No converted rows yet'); return; }
      const [XLSX, { default: saveAs }] = await Promise.all([import('xlsx'), import('file-saver')]);
      const header = ['ShopID', 'Spy Account No', 'Delivery', 'EAN', 'QTY', 'External Order No'];
      const data = rowsOut.map(r => [r.ShopID, r.SpyAccountNo, r.Delivery, r.EAN, r.QTY, r.ExternalOrderNo ?? '']);
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
      XLSX.utils.book_append_sheet(wb, ws, 'Nielsens');
      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      saveAs(blob, 'purchase_order_nielsens.xlsx');
    } catch (e: any) {
      alert(e?.message || 'Export failed');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Nielsens</div>
        <button className="rounded border px-2 py-1 text-sm" onClick={() => setSettingsOpen(true)}>☰ Settings</button>
      </div>
      <div className="rounded border bg-white p-3 space-y-3">
        <div className="text-sm font-medium">Upload files</div>
        <input
          type="file"
          accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
          multiple
          onChange={(e) => onFilesSelected(e.target.files)}
        />
        {fileSummaries.length > 0 && (
          <div className="text-xs text-gray-600">
            {fileSummaries.length} file(s) loaded. {firstColMismatch && <span className="text-red-700 ml-2">{firstColMismatch}</span>}
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-2">
            <div className="text-sm font-medium">Column mapping</div>
            <div className="space-y-1">
              <label className="text-xs">ShopID</label>
              <select className="w-full border rounded px-2 py-1 text-sm" value={shopIdCol} onChange={(e)=>setShopIdCol(e.target.value)}>
                <option value="">—</option>
                {headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs">EAN</label>
              <select className="w-full border rounded px-2 py-1 text-sm" value={eanCol} onChange={(e)=>setEanCol(e.target.value)}>
                <option value="">—</option>
                {headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs">QTY</label>
              <select className="w-full border rounded px-2 py-1 text-sm" value={qtyCol} onChange={(e)=>setQtyCol(e.target.value)}>
                <option value="">—</option>
                {headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs">External Order No (optional)</label>
              <select className="w-full border rounded px-2 py-1 text-sm" value={extOrderCol} onChange={(e)=>setExtOrderCol(e.target.value)}>
                <option value="">—</option>
                {headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-sm font-medium">Delivery</div>
            <input
              className="w-full border rounded px-2 py-1 text-sm"
              placeholder="Delivery date/text"
              value={delivery}
              onChange={(e)=>setDelivery(e.target.value)}
            />
            <div className="text-xs text-gray-600">Applied to all rows in the converted file.</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className={"rounded px-3 py-1.5 text-sm border " + (busy ? 'bg-slate-300 text-gray-700' : 'bg-slate-900 text-white hover:bg-slate-800')} disabled={busy} onClick={convertFiles}>
            {busy ? 'Converting…' : 'Convert'}
          </button>
          <button className="rounded px-3 py-1.5 text-sm border" onClick={exportExcel}>Export Excel</button>
          {error && <div className="text-xs text-red-700">{error}</div>}
        </div>
        {rowsOut.length > 0 && (
          <div className="text-xs text-gray-700">{rowsOut.length.toLocaleString('da-DK')} rows prepared.</div>
        )}
      </div>
      <ShopSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        shopMapId={shopMapResp?.id || null}
        shopMapValue={(shopMapResp?.value || {}) as ShopMap}
        onSaved={async () => { await mutateShopMap(); }}
      />
    </div>
  );
}

function ShopSettingsModal({ open, onClose, shopMapId, shopMapValue, onSaved }: { open: boolean; onClose: () => void; shopMapId: string | null; shopMapValue: ShopMap; onSaved: () => Promise<void> }) {
  const supabase = createClientComponentClient();
  const [search, setSearch] = React.useState('');
  const [shopId, setShopId] = React.useState<string>('');
  const [selectedCustomer, setSelectedCustomer] = React.useState<string>(''); // customer_id
  const [saving, setSaving] = React.useState(false);
  const { data: customers } = useSWR(open ? 'purchase:nielsens:customers' : null, async () => {
    const { data, error } = await supabase.from('customers').select('customer_id, company').order('company', { ascending: true }).limit(5000);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ customer_id: string; company: string | null }>;
  });
  const filteredCustomers = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers ?? [];
    return (customers ?? []).filter(c => (c.company || '').toLowerCase().includes(q) || String(c.customer_id || '').includes(q));
  }, [customers, search]);
  const current = shopMapValue || {};
  async function saveMapping() {
    if (!shopId || !selectedCustomer) return;
    try {
      setSaving(true);
      const next = { ...(current || {}) } as ShopMap;
      next[String(shopId)] = String(selectedCustomer);
      if (shopMapId) {
        await supabase.from('app_settings').update({ value: next }).eq('id', shopMapId);
      } else {
        await supabase.from('app_settings').insert({ key: 'nielsens_shop_map', value: next } as any);
      }
      await onSaved();
      setShopId('');
      setSelectedCustomer('');
    } finally {
      setSaving(false);
    }
  }
  async function deleteMapping(key: string) {
    try {
      setSaving(true);
      const next = { ...(current || {}) } as ShopMap;
      delete next[key];
      if (shopMapId) {
        await supabase.from('app_settings').update({ value: next }).eq('id', shopMapId);
      } else {
        await supabase.from('app_settings').insert({ key: 'nielsens_shop_map', value: next } as any);
      }
      await onSaved();
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nielsens · Shop ID matches"
      footer={(
        <div className="flex items-center gap-2">
          <button className="rounded border px-3 py-1.5 text-sm" onClick={onClose}>Close</button>
        </div>
      )}
    >
      <div className="space-y-3">
        <div className="text-sm font-medium">Current matches</div>
        <div className="max-h-40 overflow-auto rounded border">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="p-2 text-left border-b">ShopID</th>
                <th className="p-2 text-left border-b">Customer</th>
                <th className="p-2 text-left border-b">Spy Account No</th>
                <th className="p-2 text-left border-b"></th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(current).length === 0 && (
                <tr><td className="p-2 text-left text-gray-500" colSpan={4}>No mappings yet.</td></tr>
              )}
              {Object.entries(current).map(([sid, custId]) => {
                const c = (customers ?? []).find(x => x.customer_id === custId);
                return (
                  <tr key={sid}>
                    <td className="p-2 border-b">{sid}</td>
                    <td className="p-2 border-b">{c?.company || '—'}</td>
                    <td className="p-2 border-b">{custId}</td>
                    <td className="p-2 border-b text-right">
                      <button className="text-[11px] underline text-red-700 disabled:text-gray-400" onClick={()=>deleteMapping(sid)} disabled={saving}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="text-sm font-medium">Create new match</div>
        <div className="grid grid-cols-1 md:grid-cols-[160px_1fr] gap-2 items-start">
          <div className="space-y-1">
            <label className="text-xs text-gray-700">ShopID</label>
            <input className="w-full border rounded px-2 py-1 text-sm" placeholder="e.g. 1234" value={shopId} onChange={(e)=>setShopId(e.target.value.replace(/[^0-9]/g,''))} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-gray-700">Customer (maps to Spy Account)</label>
            <div className="flex items-center gap-2">
              <input className="w-56 border rounded px-2 py-1 text-sm" placeholder="Search customers…" value={search} onChange={(e)=>setSearch(e.target.value)} />
              <select className="flex-1 border rounded px-2 py-1 text-sm" size={6} value={selectedCustomer} onChange={(e)=>setSelectedCustomer(e.target.value)}>
                <option value="">—</option>
                {filteredCustomers.map(c => (
                  <option key={c.customer_id} value={c.customer_id}>{c.company || '—'} · {c.customer_id}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <div>
          <button className={"rounded px-3 py-1.5 text-sm border " + (saving ? 'bg-slate-300 text-gray-700' : 'bg-slate-900 text-white hover:bg-slate-800')} onClick={saveMapping} disabled={saving || !shopId || !selectedCustomer}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}



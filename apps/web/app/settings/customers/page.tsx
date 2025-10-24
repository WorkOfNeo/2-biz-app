'use client';
import { useCallback, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { supabase } from '../../../lib/supabaseClient';
import useSWR from 'swr';
import type { CustomerRow, SalespersonRow } from '@shared/types';
import { Modal } from '../../../components/Modal';
import { ProgressBar } from '../../../components/ProgressBar';

// Import moved to /settings/customers/import

export default function CustomersSettingsPage() {
  // Bulk update modal state
  const [bulkOpen, setBulkOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [matchFileCol, setMatchFileCol] = useState('');
  const [valueFileCol, setValueFileCol] = useState('');
  const [matchDbCol, setMatchDbCol] = useState('customer_id');
  const [updateDbCol, setUpdateDbCol] = useState('city');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  const { data: customers, mutate } = useSWR('customers', async () => {
    const { data, error } = await supabase
      .from('customers')
      .select('id, company, city, country, phone, priority, customer_id, salespersons(name)')
      .order('company', { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);
    console.log('[customers] fetched', (data ?? []).length);
    return data as any[];
  }, { refreshInterval: 10000 });
  const { data: salespersons } = useSWR('salespersons', async () => {
    const { data, error } = await supabase.from('salespersons').select('*').order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return data as SalespersonRow[];
  });

  const MATCHABLE_DB_COLS = useMemo(() => [
    'customer_id', 'company', 'email'
  ], []);
  const UPDATEABLE_DB_COLS = useMemo(() => [
    'company', 'stats_display_name', 'group_name', 'email', 'city', 'postal', 'country', 'currency', 'excluded', 'nulled', 'permanently_closed'
  ], []);

  const preview = useMemo(() => rows.slice(0, 5), [rows]);

  const parseFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = new Uint8Array(e.target?.result as ArrayBuffer);
      const wb = XLSX.read(data, { type: 'array' });
      const wsname = wb.SheetNames && wb.SheetNames.length > 0 ? wb.SheetNames[0] : undefined;
      if (!wsname) { setRows([]); setHeaders([]); return; }
      const ws = wb.Sheets[wsname as string];
      if (!ws) { setRows([]); setHeaders([]); return; }
      const json: Record<string, any>[] = XLSX.utils.sheet_to_json(ws, { defval: '' });
      setRows(json);
      const headerRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as any[];
      const hdr = Array.isArray(headerRows) && Array.isArray(headerRows[0]) ? (headerRows[0] as string[]) : [];
      setHeaders(hdr);
      // auto-guess first two columns
      setMatchFileCol(hdr[0] || '');
      setValueFileCol(hdr[1] || '');
    };
    reader.readAsArrayBuffer(file);
  }, []);

  async function runBulkUpdate() {
    try {
      setRunning(true);
      setResultMsg(null);
      setProgress(0);
      if (!matchFileCol || !valueFileCol || !matchDbCol || !updateDbCol) throw new Error('Please select mapping.');
      const total = rows.length;
      let ok = 0, fail = 0;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r) { setProgress(i + 1); continue; }
        const matchVal = r[matchFileCol as keyof typeof r];
        const newValRaw = r[valueFileCol as keyof typeof r];
        if (matchVal === undefined || matchVal === null || String(matchVal).trim() === '') { setProgress(i + 1); continue; }
        let newVal: any = newValRaw;
        if (['excluded','nulled','permanently_closed'].includes(updateDbCol)) {
          const s = String(newValRaw).toLowerCase().trim();
          newVal = s === 'true' || s === '1' || s === 'yes' || s === 'y';
        }
        const { error } = await supabase
          .from('customers')
          .update({ [updateDbCol]: newVal })
          .eq(matchDbCol, matchVal as any);
        if (error) { fail++; } else { ok++; }
        setProgress(i + 1);
      }
      setResultMsg(`Updated ${ok}/${total} rows${fail ? `, ${fail} failed` : ''}.`);
      mutate();
    } catch (e: any) {
      setResultMsg(`Error: ${e?.message ?? String(e)}`);
    } finally {
      setRunning(false);
    }
  }
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Customers</h2>
        <div className="relative">
          <details>
            <summary className="list-none inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm hover:bg-slate-50">☰</summary>
            <div className="absolute right-0 z-10 mt-2 w-56 rounded-md border bg-white shadow">
              <div className="py-1 text-sm">
                <button
                  className="block w-full px-3 py-2 text-left hover:bg-gray-50"
                  onClick={() => setBulkOpen(true)}
                >Bulk update (XLSX)</button>
                <button
                  className="block w-full px-3 py-2 text-left hover:bg-gray-50"
                  onClick={async () => {
                    try {
                      const { data: { session } } = await supabase.auth.getSession();
                      if (!session) throw new Error('Not signed in');
                      const token = session.access_token;
                      const res = await fetch('/api/enqueue', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                        body: JSON.stringify({ type: 'scrape_customers', payload: { requestedBy: session.user.email } })
                      });
                      if (!res.ok) throw new Error(await res.text());
                      try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('job-started', { detail: { label: 'Scrape customers — job started' } })); } catch {}
                    } catch (e: any) {
                      alert(e?.message || 'Failed to enqueue');
                    }
                  }}
                >Scrape Customers</button>
              </div>
            </div>
          </details>
        </div>
      </div>
      <div className="space-y-2">
        <h3 className="text-lg font-semibold mt-6">Customers</h3>
        <div className="overflow-auto border rounded-md">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-2 border-b">Customer</th>
                <th className="text-left p-2 border-b">City</th>
                <th className="text-left p-2 border-b">Country</th>
                <th className="text-left p-2 border-b">Phone</th>
                <th className="text-left p-2 border-b">Priority</th>
                <th className="text-left p-2 border-b">Sales Person</th>
              </tr>
            </thead>
            <tbody>
              {(customers ?? []).map((c) => (
                <tr key={c.id}>
                  <td className="p-2 border-b"><a href={`/settings/customers/${c.id}`} className="text-blue-700 hover:underline">{c.company || '-'}</a></td>
                  <td className="p-2 border-b">{c.city || '-'}</td>
                  <td className="p-2 border-b">{c.country || '-'}</td>
                  <td className="p-2 border-b">{c.phone || '-'}</td>
                  <td className="p-2 border-b">{c.priority || '-'}</td>
                  <td className="p-2 border-b text-sm">{c.salespersons?.name || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title="Bulk update customers (XLSX)"
        footer={(
          <div className="flex items-center gap-3 w-full justify-between">
            <div className="flex-1 mr-4">
              {running && <ProgressBar value={progress} max={Math.max(1, rows.length)} />}
              {!running && rows.length > 0 && <div className="text-xs text-gray-500 mt-1">{progress}/{rows.length}</div>}
            </div>
            <div className="flex items-center gap-2">
              <button className="px-3 py-1.5 text-sm" onClick={() => setBulkOpen(false)} disabled={running}>Close</button>
              <button
                disabled={running || rows.length === 0 || !matchFileCol || !valueFileCol}
                className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
                onClick={runBulkUpdate}
              >
                {running ? 'Updating…' : 'Start update'}
              </button>
            </div>
          </div>
        )}
      >
        <div className="space-y-4">
          <div
            className={
              'border-2 border-dashed rounded-lg p-6 text-center transition ' +
              (dragOver ? 'bg-slate-50 border-slate-400' : 'border-slate-300')
            }
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(ev) => { ev.preventDefault(); setDragOver(false); const f = (ev.dataTransfer.files?.[0]); if (f) parseFile(f); }}
          >
            <div className="text-sm text-gray-600">Drag & drop Excel here, or click to browse.</div>
            <div className="mt-3">
              <input
                className="w-full text-sm"
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) parseFile(f); }}
              />
            </div>
          </div>

          {headers.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <label className="text-sm">
                <div className="font-medium">Match column (file)</div>
                <select className="mt-1 w-full border rounded-md p-2 text-sm" value={matchFileCol} onChange={(e) => setMatchFileCol(e.target.value)}>
                  <option value="">—</option>
                  {headers.map((h) => (<option key={h} value={h}>{h}</option>))}
                </select>
              </label>
              <label className="text-sm">
                <div className="font-medium">Match against (DB)</div>
                <select className="mt-1 w-full border rounded-md p-2 text-sm" value={matchDbCol} onChange={(e) => setMatchDbCol(e.target.value)}>
                  {MATCHABLE_DB_COLS.map((c) => (<option key={c} value={c}>{c}</option>))}
                </select>
              </label>
              <label className="text-sm">
                <div className="font-medium">Value column (file)</div>
                <select className="mt-1 w-full border rounded-md p-2 text-sm" value={valueFileCol} onChange={(e) => setValueFileCol(e.target.value)}>
                  <option value="">—</option>
                  {headers.map((h) => (<option key={h} value={h}>{h}</option>))}
                </select>
              </label>
              <label className="text-sm">
                <div className="font-medium">Set column (DB)</div>
                <select className="mt-1 w-full border rounded-md p-2 text-sm" value={updateDbCol} onChange={(e) => setUpdateDbCol(e.target.value)}>
                  {UPDATEABLE_DB_COLS.map((c) => (<option key={c} value={c}>{c}</option>))}
                </select>
              </label>
            </div>
          )}

          {preview.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm text-gray-600">Preview (first 5 rows)</div>
              <div className="overflow-auto border rounded-md">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr>
                      {headers.map((h) => (<th key={h} className="text-left p-2 border-b bg-gray-50">{h}</th>))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((r, idx) => (
                      <tr key={idx}>
                        {headers.map((h) => (<td key={h} className="p-2 border-b">{String(r[h] ?? '')}</td>))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {resultMsg && <div className="text-sm">{resultMsg}</div>}
        </div>
      </Modal>
    </div>
  );
}

function CustomerRowItem({ row, salespersons, onSaved }: { row: any; salespersons: SalespersonRow[]; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [company, setCompany] = useState<string>(row.company ?? '');
  const [statsName, setStatsName] = useState<string>(row.stats_display_name ?? '');
  const [groupName, setGroupName] = useState<string>(row.group_name ?? '');
  const [salespersonName, setSalespersonName] = useState<string>(row.salespersons?.name ?? '');
  const [email, setEmail] = useState<string>(row.email ?? '');
  const [city, setCity] = useState<string>(row.city ?? '');
  const [postal, setPostal] = useState<string>(row.postal ?? '');
  const [country, setCountry] = useState<string>(row.country ?? '');
  const [currency, setCurrency] = useState<string>(row.currency ?? '');
  const [excluded, setExcluded] = useState<boolean>(!!row.excluded);
  const [nulled, setNulled] = useState<boolean>(!!row.nulled);
  const [closed, setClosed] = useState<boolean>(!!row.permanently_closed);
  const [saving, setSaving] = useState(false);
  return (
    <tr>
      <td className="p-2 border-b">{row.company || '-'}</td>
      <td className="p-2 border-b font-mono text-xs">{row.customer_id}</td>
      <td className="p-2 border-b">{row.salespersons?.name || '-'}</td>
      <td className="p-2 border-b">{row.city || '-'}</td>
      <td className="p-2 border-b">{row.country || '-'}</td>
      <td className="p-2 border-b">{row.excluded ? 'Yes' : 'No'}</td>
      <td className="p-2 border-b">
        <button className="text-blue-600 hover:underline" onClick={() => setOpen(true)}>Edit</button>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="Edit Customer"
          footer={(
            <>
              <button className="px-3 py-1.5 text-sm" onClick={() => setOpen(false)}>Cancel</button>
              <button
                disabled={saving}
                className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
                onClick={async () => {
                  try {
                    setSaving(true);
                    const { data: { session } } = await supabase.auth.getSession();
                    if (!session) throw new Error('Not signed in');
                    const token = session.access_token;
                    const res = await fetch(`${process.env.NEXT_PUBLIC_ORCHESTRATOR_URL}/customers/${row.id}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                      body: JSON.stringify({
                        company,
                        stats_display_name: statsName,
                        group_name: groupName,
                        salesperson_name: salespersonName,
                        email, city, postal, country, currency,
                        excluded, nulled, permanently_closed: closed
                      })
                    });
                    if (!res.ok) throw new Error(await res.text());
                    setOpen(false);
                    onSaved();
                  } finally {
                    setSaving(false);
                  }
                }}
              >Save</button>
            </>
          )}
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">Company<input className="mt-1 w-full border rounded p-1 text-sm" value={company} onChange={(e) => setCompany(e.target.value)} /></label>
            <label className="text-sm">Stats Display<input className="mt-1 w-full border rounded p-1 text-sm" value={statsName} onChange={(e) => setStatsName(e.target.value)} /></label>
            <label className="text-sm">Group<input className="mt-1 w-full border rounded p-1 text-sm" value={groupName} onChange={(e) => setGroupName(e.target.value)} /></label>
            <label className="text-sm">Salesperson<input list={`sp-${row.id}`} className="mt-1 w-full border rounded p-1 text-sm" value={salespersonName} onChange={(e) => setSalespersonName(e.target.value)} placeholder="Salesperson name" /></label>
            <datalist id={`sp-${row.id}`}>{salespersons.map((sp) => (<option key={sp.id} value={sp.name} />))}</datalist>
            <label className="text-sm">Email<input className="mt-1 w-full border rounded p-1 text-sm" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="text-sm">City<input className="mt-1 w-full border rounded p-1 text-sm" value={city} onChange={(e) => setCity(e.target.value)} /></label>
            <label className="text-sm">Postal<input className="mt-1 w-full border rounded p-1 text-sm" value={postal} onChange={(e) => setPostal(e.target.value)} /></label>
            <label className="text-sm">Country<input className="mt-1 w-full border rounded p-1 text-sm" value={country} onChange={(e) => setCountry(e.target.value)} /></label>
            <label className="text-sm">Currency<input className="mt-1 w-full border rounded p-1 text-sm" value={currency} onChange={(e) => setCurrency(e.target.value)} /></label>
            <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={excluded} onChange={(e) => setExcluded(e.target.checked)} /> Excluded</label>
            <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={nulled} onChange={(e) => setNulled(e.target.checked)} /> Nulled</label>
            <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} /> Permanently Closed</label>
          </div>
        </Modal>
      </td>
    </tr>
  );
}


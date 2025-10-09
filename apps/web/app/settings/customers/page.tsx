'use client';
import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { supabase } from '../../../lib/supabaseClient';
import useSWR from 'swr';
import type { CustomerRow, SalespersonRow } from '@shared/types';
import { Modal } from '../../../components/Modal';

type Row = Record<string, any>;

const CUSTOMER_FIELDS = [
  'customer_id',
  'company',
  'stats_display_name',
  'group_name',
  'salesperson_name',
  'email',
  'city',
  'postal',
  'country',
  'currency',
  'excluded',
  'nulled',
  'permanently_closed'
];

export default function CustomersSettingsPage() {
  const { data: customers, mutate } = useSWR('customers', async () => {
    const { data, error } = await supabase
      .from('customers')
      .select('*, salespersons(name)')
      .order('company', { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);
    return data as any[];
  }, { refreshInterval: 10000 });
  const { data: salespersons } = useSWR('salespersons', async () => {
    const { data, error } = await supabase.from('salespersons').select('*').order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return data as SalespersonRow[];
  });
  const [rows, setRows] = useState<Row[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<string | null>(null);

  const preview = useMemo(() => rows.slice(0, 5), [rows]);

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = new Uint8Array(e.target?.result as ArrayBuffer);
      const wb = XLSX.read(data, { type: 'array' });
      const wsname = wb.SheetNames && wb.SheetNames.length > 0 ? wb.SheetNames[0] : undefined;
      if (!wsname) {
        setRows([]);
        setHeaders([]);
        setMapping({});
        return;
      }
      const ws = wb.Sheets[wsname as string];
      if (!ws) {
        setRows([]);
        setHeaders([]);
        setMapping({});
        return;
      }
      const json: Row[] = XLSX.utils.sheet_to_json(ws, { defval: '' });
      setRows(json);
      const headerRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as any[];
      const hdr = Array.isArray(headerRows) && Array.isArray(headerRows[0]) ? (headerRows[0] as string[]) : [];
      setHeaders(hdr);
      const auto: Record<string, string> = {};
      for (const h of hdr) {
        const k = String(h ?? '').trim().toLowerCase().replace(/\s+/g, '_');
        const match = CUSTOMER_FIELDS.find((f) => f === k);
        if (match) auto[match] = String(h);
      }
      setMapping(auto);
    };
    reader.readAsArrayBuffer(file);
  }

  async function submit() {
    try {
      setSubmitting(true);
      setSubmitResult(null);
      const {
        data: { session }
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const token = session.access_token;
      const body = rows.map((r) => {
        const obj: Row = {};
        for (const field of CUSTOMER_FIELDS) {
          const source = mapping[field];
          if (source) obj[field] = r[source];
        }
        // Normalize booleans
        for (const b of ['excluded', 'nulled', 'permanently_closed']) {
          if (obj[b] !== undefined) obj[b] = String(obj[b]).toLowerCase() === 'true';
        }
        return obj;
      });
      const res = await fetch(`${process.env.NEXT_PUBLIC_ORCHESTRATOR_URL}/import/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ rows: body })
      });
      const text = await res.text();
      let json: any = null; try { json = text ? JSON.parse(text) : null; } catch {}
      if (!res.ok) throw new Error(json?.error || text || 'Import failed');
      setSubmitResult(`Imported: ${json?.imported ?? 0}, updated: ${json?.updated ?? 0}`);
    } catch (e: any) {
      setSubmitResult(`Error: ${e?.message ?? String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Customers</h2>
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1 border rounded-md p-4 space-y-3">
          <div className="text-lg font-semibold">Import</div>
          <div className="text-sm text-gray-600">Upload your spreadsheet, map columns, preview, then import.</div>
        <input
            className="w-full text-sm"
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          {headers.length > 0 && (
            <div className="space-y-2">
              <div className="font-medium">Field Mapping</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {CUSTOMER_FIELDS.map((f) => (
                  <label key={f} className="text-sm">
                    <div className="font-medium">{f}</div>
                    <select
                      className="mt-1 w-full border rounded-md p-2 text-sm"
                      value={mapping[f] ?? ''}
                      onChange={(e) => setMapping((m) => ({ ...m, [f]: e.target.value }))}
                    >
                      <option value="">—</option>
                      {headers.map((h) => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          )}
      {preview.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm text-gray-600">Preview (first 5 rows)</div>
          <div className="overflow-auto border rounded-md">
            <table className="min-w-full text-sm">
              <thead>
                <tr>
                  {headers.map((h) => (
                    <th key={h} className="text-left p-2 border-b bg-gray-50">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((r, idx) => (
                  <tr key={idx}>
                    {headers.map((h) => (
                      <td key={h} className="p-2 border-b">{String(r[h] ?? '')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div>
        <button
          disabled={submitting || rows.length === 0}
          className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
          onClick={submit}
        >
          {submitting ? 'Importing…' : 'Import mapped rows'}
        </button>
        {submitResult && <div className="mt-2 text-sm">{submitResult}</div>}
      </div>
        </div>
        <div className="lg:col-span-2 space-y-2">
        <h3 className="text-lg font-semibold mt-6">Customers</h3>
        <div className="overflow-auto border rounded-md">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-2 border-b">Company</th>
                <th className="text-left p-2 border-b">Customer ID</th>
                <th className="text-left p-2 border-b">Salesperson</th>
                <th className="text-left p-2 border-b">City</th>
                <th className="text-left p-2 border-b">Country</th>
                <th className="text-left p-2 border-b">Excluded</th>
                <th className="text-left p-2 border-b">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(customers ?? []).map((c) => (
                <CustomerRowItem key={c.id} row={c} salespersons={salespersons ?? []} onSaved={mutate} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </div>
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


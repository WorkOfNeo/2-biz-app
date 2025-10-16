'use client';
import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import useSWR from 'swr';
import { supabase } from '../../../../lib/supabaseClient';

type Row = Record<string, any>;

const STAT_FIELDS = ['salesman', 'account_no', 'customer_name', 'city', 'qty', 'price'];

export default function ImportStatsPage() {
  const { data: seasons } = useSWR('seasons-all', async () => {
    const { data, error } = await supabase.from('seasons').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data as { id: string; name: string; year: number | null }[];
  });
  const [seasonId, setSeasonId] = useState<string>('');
  const [rows, setRows] = useState<Row[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<string | null>(null);
  const [processed, setProcessed] = useState(0);
  const [total, setTotal] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const preview = useMemo(() => rows.slice(0, 5), [rows]);

  function parseFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = new Uint8Array(e.target?.result as ArrayBuffer);
      const wb = XLSX.read(data, { type: 'array' });
      const wsname = wb.SheetNames?.[0];
      if (!wsname) return;
      const ws = wb.Sheets[wsname as string];
      if (!ws) return;
      const json: Row[] = XLSX.utils.sheet_to_json(ws, { defval: '' });
      setRows(json);
      const headerRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as any[];
      const hdr = Array.isArray(headerRows?.[0]) ? (headerRows[0] as string[]) : [];
      setHeaders(hdr);
      const auto: Record<string, string> = {};
      for (const h of hdr) {
        const k = String(h ?? '').trim().toLowerCase().replace(/\s+/g, '_');
        const match = STAT_FIELDS.find((f) => f === k);
        if (match) auto[match] = String(h);
      }
      setMapping(auto);
    };
    reader.readAsArrayBuffer(file);
  }

  function normalizeName(name: string) {
    return String(name || '').trim().toUpperCase();
  }

  function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  async function submit() {
    if (!seasonId) { setSubmitResult('Choose a season'); return; }
    setSubmitting(true);
    setSubmitResult(null);
    setProcessed(0);
    setTotal(rows.length);
    setStartedAt(Date.now());
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const token = session.access_token;
      // Normalize incoming rows
      const normalized = rows.map((r) => {
        const account_no = mapping['account_no'] ? r[mapping['account_no']] : '';
        const customer_name = mapping['customer_name'] ? r[mapping['customer_name']] : null;
        const city = mapping['city'] ? r[mapping['city']] : null;
        const qty = Number(mapping['qty'] ? r[mapping['qty']] : 0) || 0;
        const price = Number(mapping['price'] ? r[mapping['price']] : 0) || 0;
        const salesmanName = mapping['salesman'] ? String(r[mapping['salesman']]) : '';
        return { account_no: String(account_no || ''), customer_name, city, qty, price, salesmanName };
      }).filter((r) => r.account_no);

      // Build unique keys
      const uniqueAccounts = Array.from(new Set(normalized.map((r) => r.account_no)));
      const uniqueSalesNames = Array.from(new Set(normalized.map((r) => normalizeName(r.salesmanName)).filter(Boolean)));

      // Fetch existing salespersons and customers
      const [{ data: spAll }, { data: custAll }] = await Promise.all([
        supabase.from('salespersons').select('id,name'),
        uniqueAccounts.length ? supabase.from('customers').select('id,customer_id,city').in('customer_id', uniqueAccounts) : Promise.resolve({ data: [] as any[] })
      ]);

      const spMap = new Map<string, { id: string; name: string }>();
      for (const sp of (spAll ?? []) as any[]) spMap.set(normalizeName(sp.name), { id: sp.id, name: sp.name });
      const missingSales: string[] = [];
      for (const n of uniqueSalesNames) if (!spMap.has(n)) missingSales.push(n);
      if (missingSales.length) {
        const insertRows = missingSales.map((n) => ({ name: n }));
        const { data: ins } = await supabase.from('salespersons').insert(insertRows).select('id,name');
        for (const sp of (ins ?? []) as any[]) spMap.set(normalizeName(sp.name), { id: sp.id, name: sp.name });
      }

      const custMap = new Map<string, { id: string; city: string | null }>();
      for (const c of (custAll ?? []) as any[]) custMap.set(String(c.customer_id), { id: c.id, city: c.city ?? null });

      // Insert missing customers in bulk
      const toInsertCustomers: { customer_id: string; company: string | null; stats_display_name: string | null; city: string | null }[] = [];
      const firstCityByAccount = new Map<string, string | null>();
      for (const r of normalized) if (!firstCityByAccount.has(r.account_no)) firstCityByAccount.set(r.account_no, r.city ? String(r.city) : null);
      for (const r of normalized) {
        if (!custMap.has(r.account_no) && r.customer_name) {
          toInsertCustomers.push({ customer_id: r.account_no, company: String(r.customer_name), stats_display_name: String(r.customer_name), city: firstCityByAccount.get(r.account_no) ?? null });
          custMap.set(r.account_no, { id: '', city: firstCityByAccount.get(r.account_no) ?? null });
        }
      }
      if (toInsertCustomers.length) {
        const { data: inserted } = await supabase.from('customers').insert(toInsertCustomers).select('id,customer_id,city');
        for (const c of (inserted ?? []) as any[]) custMap.set(String(c.customer_id), { id: c.id, city: c.city ?? null });
      }

      // Update city for existing customers where DB city is null and import has a city
      const cityUpdates: Array<{ customer_id: string; city: string }> = [];
      for (const r of normalized) {
        const cur = custMap.get(r.account_no);
        const importCity = r.city ? String(r.city).trim() : '';
        if (cur && (!cur.city || String(cur.city).trim().length === 0) && importCity.length > 0) {
          cityUpdates.push({ customer_id: r.account_no, city: importCity });
          cur.city = importCity;
        }
      }
      // Perform per-account updates (small loop)
      for (const u of cityUpdates) {
        await supabase.from('customers').update({ city: u.city }).eq('customer_id', u.customer_id).is('city', null);
      }

      // Prepare deduped sales_stats rows (one per account)
      const perAccount = new Map<string, any>();
      for (const r of normalized) {
        const sp = spMap.get(normalizeName(r.salesmanName));
        const cust = custMap.get(r.account_no);
        perAccount.set(r.account_no, {
          season_id: seasonId,
          account_no: String(r.account_no),
          customer_id: cust?.id ?? null,
          customer_name: r.customer_name,
          city: r.city ?? null,
          salesperson_id: sp?.id ?? null,
          salesperson_name: r.salesmanName || null,
          qty: r.qty,
          price: r.price,
          currency: null
        });
      }

      const upsertRows = Array.from(perAccount.values());
      setTotal(upsertRows.length);
      let doneCount = 0;
      for (const part of chunk(upsertRows, 500)) {
        await supabase.from('sales_stats').upsert(part, { onConflict: 'season_id,account_no' });
        doneCount += part.length;
        setProcessed(doneCount);
      }
      setSubmitResult('Import completed');
    } catch (e: any) {
      setSubmitResult(`Error: ${e?.message ?? String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Import Statistics</h1>
      <div className="flex items-end gap-3">
        <div>
          <label className="text-sm">Season</label>
          <select className="mt-1 border rounded p-1 text-sm" value={seasonId} onChange={(e) => setSeasonId(e.target.value)}>
            <option value="">—</option>
            {(seasons ?? []).map((s) => (
              <option key={s.id} value={s.id}>{s.name} {s.year ?? ''}</option>
            ))}
          </select>
        </div>
        <input className="border rounded p-2 text-sm" type="file" accept=".xlsx,.xls,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) parseFile(f); }} />
      </div>

      {headers.length > 0 && (
        <div className="space-y-2">
          <div className="font-medium">Field Mapping</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {STAT_FIELDS.map((f) => (
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
            <table className="min-w-full text-xs">
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
          disabled={submitting || rows.length === 0 || !seasonId}
          className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
          onClick={submit}
        >
          {submitting ? 'Importing…' : 'Import mapped rows'}
        </button>
        {submitResult && <div className="mt-2 text-sm">{submitResult}</div>}
      </div>

      {submitting || processed > 0 ? (
        <div className="mt-3">
          <div className="flex justify-between text-xs text-gray-600 mb-1">
            <div>{processed}/{total} rows</div>
            <div>{Math.round(total ? (processed / Math.max(1,total)) * 100 : 0)}%</div>
          </div>
          <div className="h-1.5 w-full rounded bg-gray-200 overflow-hidden">
            <div className="h-full bg-slate-900 transition-[width] duration-300 ease-out" style={{ width: `${Math.round(total ? (processed / Math.max(1,total)) * 100 : 0)}%` }} />
          </div>
        </div>
      ) : null}
    </div>
  );
}



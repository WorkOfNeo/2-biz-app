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
      let count = 0;
      for (const r of rows) {
        const account_no = mapping['account_no'] ? r[mapping['account_no']] : '';
        if (!account_no) continue;
        const customer_name = mapping['customer_name'] ? r[mapping['customer_name']] : null;
        const city = mapping['city'] ? r[mapping['city']] : null;
        const qty = Number(mapping['qty'] ? r[mapping['qty']] : 0) || 0;
        const price = Number(mapping['price'] ? r[mapping['price']] : 0) || 0;
        const salesmanName = mapping['salesman'] ? String(r[mapping['salesman']]) : '';

        // resolve or create salesperson
        let salesperson_id: string | null = null;
        if (salesmanName) {
          const { data: spFind } = await supabase.from('salespersons').select('id').ilike('name', salesmanName).maybeSingle();
          if (spFind?.id) salesperson_id = spFind.id as string;
          else {
            const { data: spIns, error: spErr } = await supabase.from('salespersons').insert({ name: salesmanName }).select('id').single();
            if (!spErr) salesperson_id = spIns!.id as string;
          }
        }

        // resolve customer by account_no, create stub if missing
        let customer_id: string | null = null;
        const { data: cFind } = await supabase.from('customers').select('id, city').eq('customer_id', String(account_no)).maybeSingle();
        if (cFind?.id) {
          customer_id = cFind.id as string;
          // If DB city is empty but import has city, update it
          const dbCity = (cFind as any).city ? String((cFind as any).city) : '';
          if ((!dbCity || dbCity.trim().length === 0) && city && String(city).trim().length > 0) {
            await supabase.from('customers').update({ city: String(city) }).eq('id', cFind.id as string);
          }
        }
        else if (customer_name) {
          const { data: cIns } = await supabase
            .from('customers')
            .insert({ customer_id: String(account_no), company: String(customer_name), stats_display_name: String(customer_name), city: city ?? null })
            .select('id')
            .single();
          if (cIns?.id) customer_id = cIns.id as string;
        }

        // upsert into sales_stats by (season_id, account_no)
        await supabase.from('sales_stats').upsert({
          season_id: seasonId,
          account_no: String(account_no),
          customer_id,
          customer_name,
          city,
          salesperson_id,
          salesperson_name: salesmanName || null,
          qty,
          price,
          currency: null
        }, { onConflict: 'season_id,account_no' });
        count++;
        setProcessed(count);
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



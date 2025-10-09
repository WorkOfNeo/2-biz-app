'use client';
import { useMemo, useState, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { supabase } from '../../../../lib/supabaseClient';

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

export default function CustomersImportPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const preview = useMemo(() => rows.slice(0, 5), [rows]);

  const parseFile = useCallback((file: File) => {
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
  }, []);

  function onDrop(ev: React.DragEvent<HTMLDivElement>) {
    ev.preventDefault();
    setDragOver(false);
    const f = ev.dataTransfer.files?.[0];
    if (f) parseFile(f);
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
      <h2 className="text-xl font-semibold">Customers Import</h2>
      <div
        className={
          'border-2 border-dashed rounded-lg p-8 text-center transition ' +
          (dragOver ? 'bg-slate-50 border-slate-400' : 'border-slate-300')
        }
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className="text-sm text-gray-600">Drag and drop your Excel file here, or click to browse.</div>
        <div className="mt-3">
          <input
            className="w-full text-sm"
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) parseFile(f);
            }}
          />
        </div>
      </div>

      {headers.length > 0 && (
        <div className="space-y-2">
          <div className="font-medium">Field Mapping</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
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
          disabled={submitting || rows.length === 0}
          className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
          onClick={submit}
        >
          {submitting ? 'Importing…' : 'Import mapped rows'}
        </button>
        {submitResult && <div className="mt-2 text-sm">{submitResult}</div>}
      </div>
    </div>
  );
}



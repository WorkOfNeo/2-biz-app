'use client';

import { useMemo, useState } from 'react';
import { extractPdf } from '../../../lib/packinglists/pdf';
import { PACKINGLIST_TEMPLATES } from '../../../lib/packinglists/templates';
import type { PackinglistParseResult } from '../../../lib/packinglists/types';
import { Dropzone } from '../../../components/ui/dropzone';

export default function PackinglistsPage() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PackinglistParseResult | null>(null);

  const rows = useMemo(() => {
    if (!result) return [];
    const out: Array<{ bizPoNo: string; bellRainOrderNo: string; model: string; color: string | null; totalQty: number }> = [];
    for (const sec of result.sections) {
      for (const line of sec.lines) {
        out.push({
          bizPoNo: sec.bizPoNo || '—',
          bellRainOrderNo: sec.bellRainOrderNo || '—',
          model: line.model,
          color: line.color,
          totalQty: line.totalQty
        });
      }
    }
    return out;
  }, [result]);

  async function parse(nextFile?: File) {
    const f = nextFile || file;
    if (!f) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const pdf = await extractPdf(f);
      const template = PACKINGLIST_TEMPLATES.find((t) => t.canParse(pdf));
      if (!template) {
        throw new Error('No matching template found for this PDF (only Bell Rain supported right now).');
      }
      const parsed = template.parse(pdf);
      setResult(parsed);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error('[packinglists] parse error', e);
      setError(e?.message || 'Failed to parse PDF');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-slate-500">Purchase</div>
        <h1 className="text-2xl font-semibold">Packinglists</h1>
        <div className="text-sm text-slate-600">
          Upload a packing slip PDF and parse it using a template (starting with Bell Rain).
        </div>
      </div>

      <div className="rounded-lg border bg-white p-4 space-y-3">
        <div className="text-sm font-medium">Upload PDF</div>
        <Dropzone
          accept="application/pdf,.pdf"
          multiple={false}
          onFiles={(files) => {
            const f = files?.[0] || null;
            setFile(f);
            if (f) void parse(f);
          }}
        >
          <div className="space-y-1">
            <div className="text-sm font-medium text-slate-800">Drag & drop a PDF here</div>
            <div className="text-xs text-slate-500">…or click to browse</div>
            {file && <div className="text-xs text-slate-600 mt-2">Selected: {file.name}</div>}
          </div>
        </Dropzone>
        <div className="flex items-center gap-2">
          <button
            className="rounded border px-3 py-1.5 text-sm bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
            disabled={!file || busy}
            onClick={() => parse()}
          >
            {busy ? 'Parsing…' : 'Parse'}
          </button>
          {file && <div className="text-xs text-slate-500">{file.name}</div>}
        </div>
        {error && <div className="text-sm text-red-600">{error}</div>}
      </div>

      {result && (
        <div className="rounded-lg border bg-white p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-sm">
              <span className="text-slate-500">Template:</span>{' '}
              <span className="font-medium">{result.templateName}</span>
            </div>
            <div className="text-sm">
              <span className="text-slate-500">Delivery date:</span>{' '}
              <span className="font-medium">{result.deliveryDate || '—'}</span>
            </div>
          </div>

          <div className="overflow-auto rounded border">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="p-2 text-left font-medium text-slate-600">2-Biz PO</th>
                  <th className="p-2 text-left font-medium text-slate-600">Bell Rain Order</th>
                  <th className="p-2 text-left font-medium text-slate-600">Model</th>
                  <th className="p-2 text-left font-medium text-slate-600">Color</th>
                  <th className="p-2 text-right font-medium text-slate-600">Qty (calc)</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r, idx) => (
                  <tr key={idx}>
                    <td className="p-2">{r.bizPoNo}</td>
                    <td className="p-2">{r.bellRainOrderNo}</td>
                    <td className="p-2 font-medium">{r.model}</td>
                    <td className="p-2">{r.color || '—'}</td>
                    <td className="p-2 text-right tabular-nums">{r.totalQty.toLocaleString('da-DK')}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td className="p-4 text-slate-500" colSpan={5}>
                      No rows parsed. (This usually means the PDF is a template we don&apos;t support yet.)
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <details className="text-sm">
            <summary className="cursor-pointer select-none text-slate-600">Raw parsed JSON</summary>
            <pre className="mt-2 max-h-[50vh] overflow-auto rounded border bg-slate-50 p-3 text-[12px]">
{JSON.stringify(result, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}



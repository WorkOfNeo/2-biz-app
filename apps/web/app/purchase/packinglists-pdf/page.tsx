'use client';

import { useMemo, useState } from 'react';
import type { PackinglistParseResult, PackinglistSectionLine } from '../../../lib/packinglists/types';
import { Dropzone } from '../../../components/ui/dropzone';

const SIZES = ['34', '36', '38', '40', '42', '44', '46'] as const;

function extractStyleName(line: PackinglistSectionLine): string {
  if (line.articleNumber) {
    const parts = line.articleNumber.split('/').map(s => s.trim());
    return parts[0] || line.model;
  }
  return line.model;
}

export default function PackinglistsPdfPage() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PackinglistParseResult | null>(null);

  const rows = useMemo(() => {
    if (!result) return [];
    const out: Array<{
      bizPoNo: string;
      bellRainOrderNo: string;
      styleName: string;
      styleAndOrderNo: string;
      color: string | null;
      sizes: Record<string, number>;
      totalQty: number;
    }> = [];
    for (const sec of result.sections) {
      for (const line of sec.lines) {
        out.push({
          bizPoNo: sec.bizPoNo || '—',
          bellRainOrderNo: sec.bellRainOrderNo || '—',
          styleName: extractStyleName(line),
          styleAndOrderNo: line.articleNumber || line.model,
          color: line.color,
          sizes: line.sizes,
          totalQty: line.totalQty
        });
      }
    }
    return out;
  }, [result]);

  function downloadCSV() {
    if (!result || rows.length === 0) return;
    const headers = ['2-Biz PO', 'Bell Rain Order', 'Style Name', 'Style + Order No', 'Color', ...SIZES, 'Total'];
    const csvRows = [
      headers.join(','),
      ...rows.map(r => [
        r.bizPoNo,
        r.bellRainOrderNo,
        r.styleName,
        r.styleAndOrderNo,
        r.color || '',
        ...SIZES.map(s => String(r.sizes[s] || 0)),
        String(r.totalQty)
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    ];
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `packinglist-${result.deliveryDate?.replace(/\s+/g, '-') || 'export'}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function copyJSON() {
    if (!result) return;
    navigator.clipboard.writeText(JSON.stringify(result, null, 2)).then(() => {
      alert('JSON copied to clipboard');
    }).catch(() => {
      alert('Failed to copy JSON');
    });
  }

  async function parse(nextFile?: File) {
    const f = nextFile || file;
    if (!f) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // Use AI-based parsing via API route
      const formData = new FormData();
      formData.append('file', f);

      const response = await fetch('/api/packinglists/parse-pdf', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Failed to parse PDF' }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const parsed: PackinglistParseResult = await response.json();
      setResult(parsed);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error('[packinglists-pdf] parse error', e);
      setError(e?.message || 'Failed to parse PDF');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-slate-500">Purchase</div>
        <h1 className="text-2xl font-semibold">Packinglists (PDF)</h1>
        <div className="text-sm text-slate-600">
          Upload a packing slip PDF and parse it using AI (GPT-4o). Supports Bell Rain format and other packing slip formats.
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
          <div className="flex flex-wrap items-center justify-between gap-3">
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
            <div className="flex items-center gap-2">
              <button
                onClick={downloadCSV}
                disabled={rows.length === 0}
                className="rounded border px-3 py-1.5 text-sm bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Download CSV
              </button>
              <button
                onClick={copyJSON}
                className="rounded border px-3 py-1.5 text-sm bg-white text-slate-700 hover:bg-slate-50"
              >
                Copy JSON
              </button>
            </div>
          </div>

          <div className="overflow-auto rounded border">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="p-2 text-left font-medium text-slate-600">2-Biz PO</th>
                  <th className="p-2 text-left font-medium text-slate-600">Bell Rain Order</th>
                  <th className="p-2 text-left font-medium text-slate-600">Style Name</th>
                  <th className="p-2 text-left font-medium text-slate-600">Style + Order No</th>
                  <th className="p-2 text-left font-medium text-slate-600">Color</th>
                  {SIZES.map(size => (
                    <th key={size} className="p-2 text-right font-medium text-slate-600">{size}</th>
                  ))}
                  <th className="p-2 text-right font-medium text-slate-600">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r, idx) => (
                  <tr key={idx}>
                    <td className="p-2">{r.bizPoNo}</td>
                    <td className="p-2">{r.bellRainOrderNo}</td>
                    <td className="p-2 font-medium">{r.styleName}</td>
                    <td className="p-2">{r.styleAndOrderNo}</td>
                    <td className="p-2">{r.color || '—'}</td>
                    {SIZES.map(size => (
                      <td key={size} className="p-2 text-right tabular-nums">{r.sizes[size] || 0}</td>
                    ))}
                    <td className="p-2 text-right tabular-nums font-medium">{r.totalQty.toLocaleString('da-DK')}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td className="p-4 text-slate-500" colSpan={9 + SIZES.length}>
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

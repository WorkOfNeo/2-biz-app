'use client';
import React, { useState, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';

type Row = Record<string, any>;

const REQUIRED_FIELDS = ['style_no', 'color', 'date', 'size', 'quantity'];

export default function HistoricalSalesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<string | null>(null);
  const [processed, setProcessed] = useState(0);
  const [total, setTotal] = useState(0);

  const preview = useMemo(() => rows.slice(0, 10), [rows]);

  function parseFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array' });
        const wsname = wb.SheetNames?.[0];
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
        const hdr = Array.isArray(headerRows?.[0]) ? (headerRows[0] as string[]) : [];
        setHeaders(hdr);
        
        // Auto-map columns
        const auto: Record<string, string> = {};
        for (const h of hdr) {
          const k = String(h ?? '').trim().toLowerCase().replace(/\s+/g, '_');
          const match = REQUIRED_FIELDS.find((f) => f === k || k.includes(f));
          if (match) auto[match] = String(h);
        }
        setMapping(auto);
        setSubmitResult(null);
      } catch (err: any) {
        setSubmitResult(`Error parsing file: ${err.message}`);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  async function uploadData() {
    setSubmitting(true);
    setSubmitResult(null);
    setProcessed(0);
    setTotal(rows.length);

    try {
      // Validate mapping
      for (const field of REQUIRED_FIELDS) {
        if (!mapping[field]) {
          throw new Error(`Missing required field mapping: ${field}`);
        }
      }

      // Map rows to expected format
      const mapped = rows.map((r) => ({
        style_no: String(r[mapping.style_no] ?? '').trim(),
        color: String(r[mapping.color] ?? '').trim(),
        date: String(r[mapping.date] ?? '').trim(),
        size: String(r[mapping.size] ?? '').trim(),
        quantity: Number(r[mapping.quantity] ?? 0)
      }));

      // Upload in batches
      const batchSize = 500;
      let successTotal = 0;
      let errorTotal = 0;
      const allErrors: string[] = [];

      for (let i = 0; i < mapped.length; i += batchSize) {
        const batch = mapped.slice(i, i + batchSize);
        
        const response = await fetch('/api/historical-sales/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: batch })
        });

        const result = await response.json();
        
        if (response.ok) {
          successTotal += result.successCount || 0;
          errorTotal += result.errorCount || 0;
          if (result.errors && Array.isArray(result.errors)) {
            allErrors.push(...result.errors);
          }
        } else {
          errorTotal += batch.length;
          allErrors.push(result.error || 'Unknown error');
        }

        setProcessed(Math.min(i + batchSize, mapped.length));
      }

      let message = `Upload complete: ${successTotal} records inserted/updated`;
      if (errorTotal > 0) {
        message += `, ${errorTotal} errors`;
      }
      if (allErrors.length > 0) {
        message += `\n\nFirst errors:\n${allErrors.slice(0, 10).join('\n')}`;
      }
      
      setSubmitResult(message);
    } catch (err: any) {
      setSubmitResult(`Error: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="p-4 space-y-4 max-w-7xl mx-auto">
      <div>
        <div className="text-xs text-slate-500">Settings</div>
        <h1 className="text-2xl font-semibold">Historical Sales Data</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Upload Historical Sales</CardTitle>
          <CardDescription>
            Import historical sales data to use in purchase order calculations. 
            Upload a CSV or Excel file with columns: Style_No, Color, Date, Size, Quantity.
            Date can be a single date (2025-01-15) or range (2025-01-01 to 2025-01-31).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Select File (CSV or Excel)
            </label>
            <Input
              type="file"
              accept=".csv, .xlsx, .xls, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel, text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) parseFile(file);
              }}
            />
          </div>

          {headers.length > 0 && (
            <>
              <div className="border-t pt-4">
                <h3 className="text-sm font-semibold mb-3">Map Columns</h3>
                <div className="grid grid-cols-2 gap-3">
                  {REQUIRED_FIELDS.map((field) => (
                    <div key={field} className="space-y-1">
                      <label className="text-xs font-medium text-slate-700 capitalize">
                        {field.replace(/_/g, ' ')}
                      </label>
                      <select
                        className="w-full h-9 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm"
                        value={mapping[field] || ''}
                        onChange={(e) => setMapping({ ...mapping, [field]: e.target.value })}
                      >
                        <option value="">-- Select Column --</option>
                        {headers.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-t pt-4">
                <h3 className="text-sm font-semibold mb-2">Preview (first 10 rows)</h3>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs border">
                    <thead className="bg-slate-50">
                      <tr>
                        {REQUIRED_FIELDS.map((field) => (
                          <th key={field} className="p-2 text-left font-semibold border">
                            {field.replace(/_/g, ' ')}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((row, i) => (
                        <tr key={i} className="border-t">
                          {REQUIRED_FIELDS.map((field) => (
                            <td key={field} className="p-2 border">
                              {String(row[mapping[field]] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="text-xs text-slate-600 mt-2">
                  Total rows: <strong>{rows.length}</strong>
                </div>
              </div>

              <div className="border-t pt-4">
                <Button
                  onClick={uploadData}
                  disabled={submitting || !REQUIRED_FIELDS.every((f) => mapping[f])}
                >
                  {submitting ? `Uploading... (${processed}/${total})` : 'Upload Data'}
                </Button>
              </div>
            </>
          )}

          {submitResult && (
            <div className={`p-3 rounded-md text-sm whitespace-pre-wrap ${
              submitResult.includes('Error') ? 'bg-red-50 text-red-900 border border-red-200' : 'bg-green-50 text-green-900 border border-green-200'
            }`}>
              {submitResult}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>File Format Guide</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <strong>Required Columns:</strong>
            <ul className="list-disc list-inside mt-1 text-slate-600">
              <li><strong>Style_No</strong> - Style number (must exist in system)</li>
              <li><strong>Color</strong> - Color name</li>
              <li><strong>Date</strong> - Single date or date range</li>
              <li><strong>Size</strong> - Size label (e.g., 34, 36, XS, M)</li>
              <li><strong>Quantity</strong> - Number of items sold</li>
            </ul>
          </div>
          
          <div>
            <strong>Date Format Examples:</strong>
            <ul className="list-disc list-inside mt-1 text-slate-600">
              <li>Single date: <code className="bg-slate-100 px-1 rounded">2025-01-15</code></li>
              <li>Date range: <code className="bg-slate-100 px-1 rounded">2025-01-01 to 2025-01-31</code></li>
              <li>Date range: <code className="bg-slate-100 px-1 rounded">2025-01-01 - 2025-01-31</code></li>
            </ul>
            <p className="text-slate-600 mt-1 text-xs">
              For date ranges, the quantity will be divided evenly across all days in the range.
            </p>
          </div>

          <div>
            <strong>Example Data (Tall Format):</strong>
            <div className="mt-2 overflow-x-auto">
              <table className="text-xs border">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="p-2 border">Style_No</th>
                    <th className="p-2 border">Color</th>
                    <th className="p-2 border">Date</th>
                    <th className="p-2 border">Size</th>
                    <th className="p-2 border">Quantity</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="p-2 border">1007952</td>
                    <td className="p-2 border">CAPTAINS BLUE</td>
                    <td className="p-2 border">2025-01-15</td>
                    <td className="p-2 border">34</td>
                    <td className="p-2 border">5</td>
                  </tr>
                  <tr>
                    <td className="p-2 border">1007952</td>
                    <td className="p-2 border">CAPTAINS BLUE</td>
                    <td className="p-2 border">2025-01-15</td>
                    <td className="p-2 border">36</td>
                    <td className="p-2 border">8</td>
                  </tr>
                  <tr>
                    <td className="p-2 border">1007952</td>
                    <td className="p-2 border">CAPTAINS BLUE</td>
                    <td className="p-2 border">2025-01-01 to 2025-01-31</td>
                    <td className="p-2 border">38</td>
                    <td className="p-2 border">310</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}


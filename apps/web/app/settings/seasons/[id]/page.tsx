'use client';
import { useParams } from 'next/navigation';
import { useState, useEffect, useMemo } from 'react';
import useSWR from 'swr';
import { supabase } from '../../../../lib/supabaseClient';
import { Dropzone } from '../../../../components/ui/dropzone';
import {
  matchCustomers,
  autoDetectHeaders,
  generateUnmatchedCsv,
  type Customer,
  type ParsedRow,
  type MatchResult
} from '../../../../lib/customerMatching';

type MappingState = {
  name: string;
  city: string;
  qty: string;
  price: string;
};

export default function SeasonDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { data: season } = useSWR(id ? `season:${id}` : null, async () => {
    const { data, error } = await supabase.from('seasons').select('*').eq('id', id).single();
    if (error) throw new Error(error.message);
    return data as { id: string; name: string; year: number | null; created_at: string };
  });
  const { data: rates, mutate } = useSWR(id ? `season:${id}:currency-rates` : null, async () => {
    const key = `currency_rates:${id}`;
    const { data, error } = await supabase.from('app_settings').select('id, value').eq('key', key).maybeSingle();
    if (error) throw new Error(error.message);
    const val = (data?.value as any) || {};
    return { id: data?.id ?? null, value: { EUR: Number(val.EUR || 0) || 0, NOK: Number(val.NOK || 0) || 0, SEK: Number(val.SEK || 0) || 0 } } as { id: string | null; value: Record<string, number> };
  });

  // Fetch customers for matching
  const { data: customers } = useSWR('customers:all', async () => {
    const { data, error } = await supabase.from('customers').select('customer_id, company, city');
    if (error) throw new Error(error.message);
    return (data ?? []) as Customer[];
  });
  
  const [localRates, setLocalRates] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // Upload state
  const [uploadedHeaders, setUploadedHeaders] = useState<string[]>([]);
  const [uploadedRows, setUploadedRows] = useState<any[]>([]);
  const [mapping, setMapping] = useState<MappingState>({ name: '', city: '', qty: '', price: '' });
  const [validationError, setValidationError] = useState<string | null>(null);
  const [matchResults, setMatchResults] = useState<MatchResult[] | null>(null);
  const [isMatching, setIsMatching] = useState(false);

  // Override state for review rows
  const [overrides, setOverrides] = useState<Map<number, string | null>>(new Map());

  // Import state
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<any | null>(null);
  
  useEffect(() => {
    if (rates?.value) {
      setLocalRates(rates.value);
      setHasChanges(false);
    }
  }, [rates?.value]);
  
  async function saveRates() {
    if (!id) return;
    setSaving(true);
    setSaveSuccess(false);
    try {
      const key = `currency_rates:${id}`;
      if (rates?.id) {
        await supabase.from('app_settings').update({ value: localRates }).eq('id', rates.id);
      } else {
        await supabase.from('app_settings').insert({ key, value: localRates });
      }
      await mutate();
      setHasChanges(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      alert(err?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }
  
  function handleRateChange(code: string, value: number) {
    setLocalRates(prev => ({ ...prev, [code]: value }));
    setHasChanges(true);
    setSaveSuccess(false);
  }

  // Handle file upload
  async function handleFileUpload(files: File[]) {
    const file = files[0];
    if (!file) return;

    setValidationError(null);
    setMatchResults(null);
    setImportResult(null);
    setOverrides(new Map());

    try {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheetNames: string[] = Array.isArray(wb.SheetNames) ? wb.SheetNames : [];
      const first = sheetNames.length > 0 ? sheetNames[0] : null;
      
      if (!first) {
        setValidationError('No sheets found in the file');
        return;
      }

      const ws = (wb.Sheets as any)[first];
      const rows = XLSX.utils.sheet_to_json(ws) as any[];
      
      if (rows.length === 0) {
        setValidationError('No data rows found in the file');
        return;
      }

      const headers = Object.keys(rows[0] || {});
      setUploadedHeaders(headers);
      setUploadedRows(rows);

      // Auto-detect header mappings
      const detected = autoDetectHeaders(headers);
      setMapping({
        name: detected.name || '',
        city: detected.city || '',
        qty: detected.qty || '',
        price: detected.price || ''
      });
    } catch (err: any) {
      setValidationError(err?.message || 'Failed to parse file');
    }
  }

  // Validate mapping and run matching
  function runMatching() {
    if (!mapping.name) {
      setValidationError('Please map the Name/Customer column');
      return;
    }
    if (!mapping.city) {
      setValidationError('Please map the City column');
      return;
    }
    if (!mapping.qty) {
      setValidationError('Please map the Qty column');
      return;
    }
    if (!mapping.price) {
      setValidationError('Please map the Price column');
      return;
    }
    if (!customers || customers.length === 0) {
      setValidationError('No customers loaded from database');
      return;
    }

    setValidationError(null);
    setIsMatching(true);

    try {
      // Parse rows according to mapping
      const parsedRows: ParsedRow[] = uploadedRows.map(row => ({
        name: String(row[mapping.name] || '').trim(),
        city: String(row[mapping.city] || '').trim(),
        qty: Number(row[mapping.qty] || 0) || 0,
        price: Number(row[mapping.price] || 0) || 0,
        originalRow: row
      })).filter(r => r.name && (r.qty || r.price)); // Filter out empty rows

      if (parsedRows.length === 0) {
        setValidationError('No valid rows found after parsing (need name and qty/price)');
        setIsMatching(false);
        return;
      }

      // Run matching
      const results = matchCustomers(parsedRows, customers);
      setMatchResults(results);
    } catch (err: any) {
      setValidationError(err?.message || 'Matching failed');
    } finally {
      setIsMatching(false);
    }
  }

  // Categorize results
  const { matched, review, unmatched } = useMemo(() => {
    if (!matchResults) return { matched: [], review: [], unmatched: [] };
    return {
      matched: matchResults.filter(r => r.status === 'matched'),
      review: matchResults.filter(r => r.status === 'review'),
      unmatched: matchResults.filter(r => r.status === 'unmatched')
    };
  }, [matchResults]);

  // Handle override for a review row
  function handleOverride(rowIndex: number, customerId: string | null) {
    setOverrides(prev => {
      const next = new Map(prev);
      if (customerId === null) {
        next.delete(rowIndex);
      } else {
        next.set(rowIndex, customerId);
      }
      return next;
    });
  }

  // Download unmatched as CSV
  function downloadUnmatchedCsv() {
    if (!matchResults) return;
    const csv = generateUnmatchedCsv(matchResults);
    if (!csv) {
      alert('No unmatched rows to download');
      return;
    }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `unmatched_rows_${season?.name || 'season'}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Confirm import
  async function confirmImport() {
    if (!id || !matchResults) return;

    setIsImporting(true);
    setImportResult(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');

      // Build rows to import
      const rowsToImport: any[] = [];

      // Add matched rows
      for (const r of matched) {
        if (r.bestMatch) {
          rowsToImport.push({
            account_no: r.bestMatch.customerId,
            customer_name: r.originalName,
            city: r.originalCity,
            qty: r.qty,
            price: r.price
          });
        }
      }

      // Add review rows that have been confirmed (either via override or keeping best match)
      for (const r of review) {
        const overrideId = overrides.get(r.rowIndex);
        const customerId = overrideId !== undefined ? overrideId : r.bestMatch?.customerId;
        if (customerId) {
          rowsToImport.push({
            account_no: customerId,
            customer_name: r.originalName,
            city: r.originalCity,
            qty: r.qty,
            price: r.price
          });
        }
      }

      if (rowsToImport.length === 0) {
        setValidationError('No rows to import');
        setIsImporting(false);
        return;
      }

      const res = await fetch('/api/statistics/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ seasonId: id, lookup: 'account', rows: rowsToImport })
      });

      if (!res.ok) throw new Error(await res.text());
      const result = await res.json();
      setImportResult(result);

      // Clear the upload state after successful import
      // Keep results visible for reference
    } catch (err: any) {
      setValidationError(err?.message || 'Import failed');
    } finally {
      setIsImporting(false);
    }
  }

  // Reset upload state
  function resetUpload() {
    setUploadedHeaders([]);
    setUploadedRows([]);
    setMapping({ name: '', city: '', qty: '', price: '' });
    setValidationError(null);
    setMatchResults(null);
    setOverrides(new Map());
    setImportResult(null);
  }

  const canRunMatching = mapping.name && mapping.city && mapping.qty && mapping.price && uploadedRows.length > 0;
  const canImport = matchResults && (matched.length > 0 || (review.length > 0 && review.some(r => r.bestMatch || overrides.has(r.rowIndex))));

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Season</h2>
      {season && (
        <div className="border rounded-md p-4">
          <div><strong>Name:</strong> {season.name}</div>
          <div><strong>Year:</strong> {season.year ?? '-'}</div>
          <div><strong>Created:</strong> {new Date(season.created_at).toLocaleString()}</div>
        </div>
      )}
      <div className="border rounded-md p-4 space-y-3">
        <div className="text-sm font-medium text-gray-700">Currency conversion to DKK (for this season)</div>
        <div className="text-xs text-gray-500">Enter how many DKK equals 1 unit of the foreign currency.</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {(['EUR','NOK','SEK'] as const).map((code) => (
            <label key={code} className="block text-sm">
              <div className="mb-1 text-gray-600">{code} → DKK</div>
              <input
                className="w-full rounded border px-2 py-1 text-sm"
                type="number"
                step="0.0001"
                value={localRates[code] ?? 0}
                onChange={(e) => {
                  const v = Number(e.target.value || 0) || 0;
                  handleRateChange(code, v);
                }}
              />
            </label>
          ))}
        </div>
        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={saveRates}
            disabled={!hasChanges || saving}
            className={
              'rounded-md px-4 py-2 text-sm font-medium transition-colors ' +
              (hasChanges && !saving
                ? 'bg-slate-900 text-white hover:bg-slate-800'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed')
            }
          >
            {saving ? 'Saving...' : 'Save Currency Rates'}
          </button>
          {saveSuccess && (
            <span className="text-sm text-green-600 font-medium">✓ Saved successfully!</span>
          )}
          {hasChanges && !saving && !saveSuccess && (
            <span className="text-sm text-amber-600">Unsaved changes</span>
          )}
        </div>
      </div>

      {/* Upload Customer Stats Section */}
      <div className="border rounded-md p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-gray-700">Upload Customer Statistics</div>
            <div className="text-xs text-gray-500">Upload a CSV/XLSX with customer names, cities, quantities, and prices. We'll auto-match to existing customers.</div>
          </div>
          {(uploadedRows.length > 0 || matchResults) && (
            <button
              onClick={resetUpload}
              className="text-sm text-gray-500 hover:text-gray-700 underline"
            >
              Reset
            </button>
          )}
        </div>

        {/* Dropzone */}
        {!matchResults && uploadedRows.length === 0 && (
          <Dropzone
            accept=".csv,.xlsx,.xls"
            onFiles={handleFileUpload}
            className="border-2 border-dashed border-slate-300 hover:border-slate-400 transition-colors"
          >
            <div className="text-center py-4">
              <div className="text-sm text-gray-600">Drop CSV or Excel file here, or click to browse</div>
              <div className="text-xs text-gray-400 mt-1">Required columns: Name, City, Qty, Price</div>
            </div>
          </Dropzone>
        )}

        {/* Validation Error */}
        {validationError && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {validationError}
          </div>
        )}

        {/* Column Mapping */}
        {uploadedRows.length > 0 && !matchResults && (
          <div className="space-y-3">
            <div className="text-sm font-medium text-gray-700">Column Mapping</div>
            <div className="text-xs text-gray-500">Loaded {uploadedRows.length} rows. Map the columns below:</div>
            
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <label className="block text-sm">
                <div className="mb-1 text-gray-600">Name/Customer *</div>
                <select
                  className="w-full rounded border px-2 py-1.5 text-sm"
                  value={mapping.name}
                  onChange={(e) => setMapping(prev => ({ ...prev, name: e.target.value }))}
                >
                  <option value="">Select...</option>
                  {uploadedHeaders.map(h => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <div className="mb-1 text-gray-600">City *</div>
                <select
                  className="w-full rounded border px-2 py-1.5 text-sm"
                  value={mapping.city}
                  onChange={(e) => setMapping(prev => ({ ...prev, city: e.target.value }))}
                >
                  <option value="">Select...</option>
                  {uploadedHeaders.map(h => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <div className="mb-1 text-gray-600">Qty *</div>
                <select
                  className="w-full rounded border px-2 py-1.5 text-sm"
                  value={mapping.qty}
                  onChange={(e) => setMapping(prev => ({ ...prev, qty: e.target.value }))}
                >
                  <option value="">Select...</option>
                  {uploadedHeaders.map(h => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <div className="mb-1 text-gray-600">Price *</div>
                <select
                  className="w-full rounded border px-2 py-1.5 text-sm"
                  value={mapping.price}
                  onChange={(e) => setMapping(prev => ({ ...prev, price: e.target.value }))}
                >
                  <option value="">Select...</option>
                  {uploadedHeaders.map(h => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </label>
            </div>

            {/* Sample preview */}
            {mapping.name && (
              <div className="text-xs text-gray-500">
                Sample: {uploadedRows.slice(0, 3).map((r, i) => (
                  <span key={i} className="inline-block bg-gray-100 rounded px-2 py-0.5 mr-2">
                    {r[mapping.name]} {mapping.city && r[mapping.city] ? `(${r[mapping.city]})` : ''}
                  </span>
                ))}
              </div>
            )}

            <button
              onClick={runMatching}
              disabled={!canRunMatching || isMatching}
              className={
                'rounded-md px-4 py-2 text-sm font-medium transition-colors ' +
                (canRunMatching && !isMatching
                  ? 'bg-slate-900 text-white hover:bg-slate-800'
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed')
              }
            >
              {isMatching ? 'Matching...' : 'Run Matching'}
            </button>
          </div>
        )}

        {/* Import Result */}
        {importResult && (
          <div className="rounded-md border border-green-200 bg-green-50 p-4 space-y-2">
            <div className="text-sm font-medium text-green-800">Import Complete</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm text-green-700">
              <div>Total rows: {importResult.totalRows ?? '—'}</div>
              <div>Upserted: {importResult.upserted ?? 0}</div>
              <div>Resolved: {importResult.resolvedAccounts ?? 0}</div>
              <div>Unresolved: {importResult.unresolved ?? 0}</div>
              {(importResult.seasonalNulled ?? 0) > 0 && <div>Nulled: {importResult.seasonalNulled}</div>}
              {(importResult.permClosed ?? 0) > 0 && <div>Perm closed: {importResult.permClosed}</div>}
            </div>
            <button
              onClick={resetUpload}
              className="mt-2 text-sm text-green-700 hover:text-green-900 underline"
            >
              Upload another file
            </button>
          </div>
        )}

        {/* Match Results */}
        {matchResults && !importResult && (
          <div className="space-y-4">
            {/* Summary */}
            <div className="flex items-center gap-4 text-sm">
              <span className="inline-flex items-center gap-1">
                <span className="w-3 h-3 rounded-full bg-green-500"></span>
                Matched: {matched.length}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-3 h-3 rounded-full bg-amber-500"></span>
                Needs Review: {review.length}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-3 h-3 rounded-full bg-red-500"></span>
                Unmatched: {unmatched.length}
              </span>
            </div>

            {/* Matched Section */}
            {matched.length > 0 && (
              <details open className="border rounded-md">
                <summary className="px-3 py-2 bg-green-50 cursor-pointer font-medium text-sm text-green-800">
                  Matched ({matched.length}) — will be imported
                </summary>
                <div className="max-h-60 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="text-left p-2 border-b">Excel Name</th>
                        <th className="text-left p-2 border-b">Excel City</th>
                        <th className="text-left p-2 border-b">Matched Customer</th>
                        <th className="text-left p-2 border-b">Matched City</th>
                        <th className="text-right p-2 border-b">Confidence</th>
                        <th className="text-right p-2 border-b">Qty</th>
                        <th className="text-right p-2 border-b">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {matched.map((r) => (
                        <tr key={r.rowIndex} className="hover:bg-gray-50">
                          <td className="p-2 border-b">{r.originalName}</td>
                          <td className="p-2 border-b">{r.originalCity}</td>
                          <td className="p-2 border-b text-green-700">{r.bestMatch?.company}</td>
                          <td className="p-2 border-b text-gray-500">{r.bestMatch?.city}</td>
                          <td className="p-2 border-b text-right font-mono text-green-600">
                            {Math.round(r.confidence * 100)}%
                          </td>
                          <td className="p-2 border-b text-right">{r.qty}</td>
                          <td className="p-2 border-b text-right">{r.price.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}

            {/* Review Section */}
            {review.length > 0 && (
              <details open className="border rounded-md">
                <summary className="px-3 py-2 bg-amber-50 cursor-pointer font-medium text-sm text-amber-800">
                  Needs Review ({review.length}) — select correct customer or skip
                </summary>
                <div className="max-h-80 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="text-left p-2 border-b">Excel Name</th>
                        <th className="text-left p-2 border-b">Excel City</th>
                        <th className="text-left p-2 border-b">Best Match</th>
                        <th className="text-left p-2 border-b">Select Customer</th>
                        <th className="text-right p-2 border-b">Qty</th>
                        <th className="text-right p-2 border-b">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {review.map((r) => {
                        const currentOverride = overrides.get(r.rowIndex);
                        const selectedId = currentOverride !== undefined ? currentOverride : r.bestMatch?.customerId;
                        return (
                          <tr key={r.rowIndex} className="hover:bg-gray-50">
                            <td className="p-2 border-b font-medium">{r.originalName}</td>
                            <td className="p-2 border-b">{r.originalCity}</td>
                            <td className="p-2 border-b">
                              {r.bestMatch && (
                                <span className="text-amber-700">
                                  {r.bestMatch.company} ({r.bestMatch.city}) — {Math.round(r.bestMatch.score * 100)}%
                                </span>
                              )}
                            </td>
                            <td className="p-2 border-b">
                              <select
                                className="w-full rounded border px-2 py-1 text-sm"
                                value={selectedId || ''}
                                onChange={(e) => handleOverride(r.rowIndex, e.target.value || null)}
                              >
                                <option value="">Skip (don't import)</option>
                                {r.topCandidates.map((c) => (
                                  <option key={c.customerId} value={c.customerId}>
                                    {c.company} ({c.city}) — {Math.round(c.score * 100)}%
                                  </option>
                                ))}
                                <optgroup label="All customers">
                                  {(customers || []).slice(0, 100).map((c) => (
                                    <option key={c.customer_id} value={c.customer_id}>
                                      {c.company} ({c.city})
                                    </option>
                                  ))}
                                </optgroup>
                              </select>
                            </td>
                            <td className="p-2 border-b text-right">{r.qty}</td>
                            <td className="p-2 border-b text-right">{r.price.toLocaleString()}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </details>
            )}

            {/* Unmatched Section */}
            {unmatched.length > 0 && (
              <details className="border rounded-md">
                <summary className="px-3 py-2 bg-red-50 cursor-pointer font-medium text-sm text-red-800">
                  Unmatched ({unmatched.length}) — will NOT be imported
                </summary>
                <div className="p-3 space-y-2">
                  <button
                    onClick={downloadUnmatchedCsv}
                    className="text-sm text-red-700 hover:text-red-900 underline"
                  >
                    Download unmatched as CSV
                  </button>
                  <div className="max-h-60 overflow-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="text-left p-2 border-b">Excel Name</th>
                          <th className="text-left p-2 border-b">Excel City</th>
                          <th className="text-left p-2 border-b">Best Guess</th>
                          <th className="text-right p-2 border-b">Score</th>
                          <th className="text-right p-2 border-b">Qty</th>
                          <th className="text-right p-2 border-b">Price</th>
                        </tr>
                      </thead>
                      <tbody>
                        {unmatched.map((r) => (
                          <tr key={r.rowIndex} className="hover:bg-gray-50">
                            <td className="p-2 border-b font-medium text-red-700">{r.originalName}</td>
                            <td className="p-2 border-b">{r.originalCity}</td>
                            <td className="p-2 border-b text-gray-500">
                              {r.bestMatch ? `${r.bestMatch.company} (${r.bestMatch.city})` : '—'}
                            </td>
                            <td className="p-2 border-b text-right font-mono text-red-600">
                              {r.bestMatch ? `${Math.round(r.bestMatch.score * 100)}%` : '—'}
                            </td>
                            <td className="p-2 border-b text-right">{r.qty}</td>
                            <td className="p-2 border-b text-right">{r.price.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </details>
            )}

            {/* Import Button */}
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={confirmImport}
                disabled={!canImport || isImporting}
                className={
                  'rounded-md px-4 py-2 text-sm font-medium transition-colors ' +
                  (canImport && !isImporting
                    ? 'bg-green-600 text-white hover:bg-green-700'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed')
                }
              >
                {isImporting ? 'Importing...' : `Confirm Import (${matched.length + review.filter(r => r.bestMatch || overrides.has(r.rowIndex)).length} rows)`}
              </button>
              <button
                onClick={resetUpload}
                className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

'use client';
import { useParams } from 'next/navigation';
import { useState, useEffect, useMemo } from 'react';
import useSWR from 'swr';
import { supabase } from '../../../../lib/supabaseClient';
import { Dropzone } from '../../../../components/ui/dropzone';
import { SearchSelect } from '../../../../components/SearchSelect';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '../../../../components/ui/card';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Badge } from '../../../../components/ui/badge';
import { cn } from '../../../../lib/cn';
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

/**
 * Parse a number that may use European formatting (. as thousands separator)
 * "46.238" -> 46238 (not 46.238)
 * "1.234.567" -> 1234567
 * Strips all dots and commas, then parses as integer
 */
function parseEuroNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Math.round(value);

  // Remove all dots and commas (treat as thousands separators)
  const cleaned = String(value).replace(/[.,\s]/g, '').trim();

  // Remove any non-digit characters except minus
  const digitsOnly = cleaned.replace(/[^\d-]/g, '');

  return parseInt(digitsOnly, 10) || 0;
}

type SeasonData = {
  id: string;
  name: string;
  year: number | null;
  created_at: string;
  start_sale: string | null;
  end_sale: string | null;
  latest_delivery: string | null;
};

export default function SeasonDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { data: season, mutate: mutateSeason } = useSWR(id ? `season:${id}` : null, async () => {
    const { data, error } = await supabase.from('seasons').select('*').eq('id', id).single();
    if (error) throw new Error(error.message);
    return data as SeasonData;
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
    const { data, error } = await supabase.from('customers').select('customer_id, company, city, salesperson_id');
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<Customer & { salesperson_id?: string | null }>;
  });

  // Fetch salespersons for clear data section
  const { data: salespersons } = useSWR('salespersons:all', async () => {
    const { data, error } = await supabase.from('salespersons').select('id, name').order('name');
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; name: string }[];
  });

  // Fetch all seasons for move target selection
  const { data: allSeasons } = useSWR('seasons:all', async () => {
    const { data } = await supabase.from('seasons').select('id, name, year, hidden').order('created_at', { ascending: false });
    return (data ?? []) as { id: string; name: string; year: number | null; hidden?: boolean | null }[];
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

  // Clear salesperson data state
  const [clearSalespersonId, setClearSalespersonId] = useState<string>('');
  const [isClearing, setIsClearing] = useState(false);
  const [clearResult, setClearResult] = useState<{ success: boolean; message: string } | null>(null);

  // Season dates state
  const [startSale, setStartSale] = useState<string>('');
  const [endSale, setEndSale] = useState<string>('');
  const [latestDelivery, setLatestDelivery] = useState<string>('');
  const [savingDates, setSavingDates] = useState(false);
  const [datesChanged, setDatesChanged] = useState(false);
  const [datesSaveSuccess, setDatesSaveSuccess] = useState(false);

  // Compare data state
  const [compareSalespersonId, setCompareSalespersonId] = useState<string>('');
  const [compareInput, setCompareInput] = useState<string>('');
  const [isComparing, setIsComparing] = useState(false);
  const [isFixing, setIsFixing] = useState(false);
  const [fixResult, setFixResult] = useState<{ success: boolean; message: string } | null>(null);
  const [compareResults, setCompareResults] = useState<{
    matches: Array<{ name: string; city: string; excelQty: number; excelPrice: number; dbQty: number; dbPrice: number; customerId: string }>;
    mismatches: Array<{ name: string; city: string; excelQty: number; excelPrice: number; dbQty: number; dbPrice: number; customerId: string; qtyDiff: number; priceDiff: number }>;
    notInDb: Array<{ name: string; city: string; qty: number; price: number; bestMatch: string | null; matchedCustomerId: string | null; suggestedCustomerId?: string | null }>;
    notInExcel: Array<{ name: string; city: string; qty: number; price: number; customerId: string }>;
  } | null>(null);
  
  // State for managing notInDb row mappings: Map<rowIndex, { status: 'accepted' | 'declined' | 'skip', manualCustomerId?: string }>
  const [notInDbMappings, setNotInDbMappings] = useState<Map<number, { status: 'accepted' | 'declined' | 'skip'; manualCustomerId?: string }>>(new Map());

  // Move records state
  const [moveToSeasonId, setMoveToSeasonId] = useState<string>('');
  const [isMoving, setIsMoving] = useState(false);
  const [moveResult, setMoveResult] = useState<{ success: boolean; message: string } | null>(null);
  const [moveConfirmStep, setMoveConfirmStep] = useState(false);

  // Clear all season records state
  const [isClearingAll, setIsClearingAll] = useState(false);
  const [clearAllResult, setClearAllResult] = useState<{ success: boolean; message: string } | null>(null);
  const [clearAllConfirmStep, setClearAllConfirmStep] = useState(false);

  useEffect(() => {
    if (rates?.value) {
      setLocalRates(rates.value);
      setHasChanges(false);
    }
  }, [rates?.value]);

  // Initialize season dates from fetched season
  useEffect(() => {
    if (season) {
      setStartSale(season.start_sale || '');
      setEndSale(season.end_sale || '');
      setLatestDelivery(season.latest_delivery || '');
      setDatesChanged(false);
    }
  }, [season?.id, season?.start_sale, season?.end_sale, season?.latest_delivery]);

  async function saveSeasonDates() {
    if (!id) return;
    setSavingDates(true);
    setDatesSaveSuccess(false);
    try {
      const { error } = await supabase.from('seasons').update({
        start_sale: startSale || null,
        end_sale: endSale || null,
        latest_delivery: latestDelivery || null,
      }).eq('id', id);
      if (error) throw new Error(error.message);
      await mutateSeason();
      setDatesChanged(false);
      setDatesSaveSuccess(true);
      setTimeout(() => setDatesSaveSuccess(false), 3000);
    } catch (err: any) {
      alert(err?.message || 'Failed to save dates');
    } finally {
      setSavingDates(false);
    }
  }

  function handleDateChange(field: 'start_sale' | 'end_sale' | 'latest_delivery', value: string) {
    if (field === 'start_sale') setStartSale(value);
    if (field === 'end_sale') setEndSale(value);
    if (field === 'latest_delivery') setLatestDelivery(value);
    setDatesChanged(true);
    setDatesSaveSuccess(false);
  }

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
      // Use parseEuroNumber to handle European number formatting (46.238 = 46238)
      const parsedRows: ParsedRow[] = uploadedRows.map(row => ({
        name: String(row[mapping.name] || '').trim(),
        city: String(row[mapping.city] || '').trim(),
        qty: parseEuroNumber(row[mapping.qty]),
        price: parseEuroNumber(row[mapping.price]),
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

  // Prepare customer items for SearchSelect
  const customerItems = useMemo(() => {
    return (customers || []).map(c => ({
      value: c.customer_id,
      label: c.company || c.customer_id,
      description: c.city || undefined
    }));
  }, [customers]);

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

      // Add unmatched rows that have been manually assigned a customer
      for (const r of unmatched) {
        const overrideId = overrides.get(r.rowIndex);
        if (overrideId) {
          rowsToImport.push({
            account_no: overrideId,
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

  // Clear salesperson data for this season
  async function clearSalespersonData() {
    if (!id || !clearSalespersonId) return;

    const salesperson = salespersons?.find(sp => sp.id === clearSalespersonId);
    const spName = salesperson?.name || clearSalespersonId;

    if (!confirm(`Are you sure you want to delete ALL sales statistics for "${spName}" in this season?\n\nThis action cannot be undone.`)) {
      return;
    }

    setIsClearing(true);
    setClearResult(null);

    try {
      // Delete all sales_stats entries for this salesperson + season
      const { data: deleted, error, count } = await supabase
        .from('sales_stats')
        .delete()
        .eq('season_id', id)
        .eq('salesperson_id', clearSalespersonId)
        .select('id');

      if (error) throw new Error(error.message);

      const deletedCount = deleted?.length ?? 0;

      setClearResult({
        success: true,
        message: `Successfully deleted ${deletedCount} entries for ${spName}`
      });

      console.log('[clearSalespersonData]', { seasonId: id, salespersonId: clearSalespersonId, deletedCount });
    } catch (err: any) {
      console.error('[clearSalespersonData] Error:', err);
      setClearResult({
        success: false,
        message: err?.message || 'Failed to clear data'
      });
    } finally {
      setIsClearing(false);
    }
  }

  // Compare pasted data against database
  async function runComparison() {
    if (!id || !compareSalespersonId || !compareInput.trim()) return;

    setIsComparing(true);
    setCompareResults(null);
    setNotInDbMappings(new Map()); // Clear previous mappings

    try {
      // Parse tab-separated input (expects: Name\tCity\tQty\tPrice per line)
      const lines = compareInput.trim().split('\n').filter(line => line.trim());

      // Skip header row if it looks like headers
      const firstLine = lines[0]?.toLowerCase() || '';
      const hasHeader = firstLine.includes('name') || firstLine.includes('customer') || firstLine.includes('qty');
      const dataLines = hasHeader ? lines.slice(1) : lines;

      // Use parseEuroNumber to handle European number formatting (46.238 = 46238)
      const excelRows = dataLines.map(line => {
        const parts = line.split('\t');
        return {
          name: (parts[0] || '').trim(),
          city: (parts[1] || '').trim(),
          qty: parseEuroNumber(parts[2]),
          price: parseEuroNumber(parts[3]),
        };
      }).filter(r => r.name && (r.qty || r.price));

      if (excelRows.length === 0) {
        alert('No valid data rows found. Expected format: Name\\tCity\\tQty\\tPrice (tab-separated)');
        setIsComparing(false);
        return;
      }

      // Fetch existing sales_stats for this salesperson + season
      const { data: dbStats, error } = await supabase
        .from('sales_stats')
        .select('account_no, customer_name, city, qty, price')
        .eq('season_id', id)
        .eq('salesperson_id', compareSalespersonId);

      if (error) throw new Error(error.message);

      // Build lookup from DB stats by normalized name+city
      const dbByKey = new Map<string, typeof dbStats[0]>();
      const dbByAccount = new Map<string, typeof dbStats[0]>();
      for (const row of (dbStats || [])) {
        const key = `${(row.customer_name || '').toLowerCase().trim()}||${(row.city || '').toLowerCase().trim()}`;
        dbByKey.set(key, row);
        if (row.account_no) dbByAccount.set(row.account_no, row);
      }

      // Use our matching logic for fuzzy matching
      const { matchCustomers, normalize } = await import('../../../../lib/customerMatching');

      // Match excel rows to customers
      const parsedRows = excelRows.map(r => ({
        name: r.name,
        city: r.city,
        qty: r.qty,
        price: r.price,
        originalRow: r
      }));

      const matchResults = matchCustomers(parsedRows, customers || []);

      type MatchEntry = { name: string; city: string; excelQty: number; excelPrice: number; dbQty: number; dbPrice: number; customerId: string };
      type MismatchEntry = MatchEntry & { qtyDiff: number; priceDiff: number };
      type NotInDbEntry = { name: string; city: string; qty: number; price: number; bestMatch: string | null; matchedCustomerId: string | null; suggestedCustomerId?: string | null };
      type NotInExcelEntry = { name: string; city: string; qty: number; price: number; customerId: string };

      const matches: MatchEntry[] = [];
      const mismatches: MismatchEntry[] = [];
      const notInDb: NotInDbEntry[] = [];
      const matchedDbAccounts = new Set<string>();

      for (let i = 0; i < excelRows.length; i++) {
        const excel = excelRows[i];
        const match = matchResults[i];

        if (!excel) continue;

        // Try to find in DB by matched customer_id or by name+city
        let dbRow: typeof dbStats[0] | undefined;

        if (match?.bestMatch && match.confidence >= 0.65) {
          dbRow = dbByAccount.get(match.bestMatch.customerId);
        }

        if (!dbRow) {
          // Fallback to exact name+city match
          const key = `${excel.name.toLowerCase().trim()}||${excel.city.toLowerCase().trim()}`;
          dbRow = dbByKey.get(key);
        }

        if (dbRow) {
          matchedDbAccounts.add(dbRow.account_no);
          const qtyDiff = excel.qty - (dbRow.qty || 0);
          const priceDiff = excel.price - (dbRow.price || 0);

          if (Math.abs(qtyDiff) < 0.01 && Math.abs(priceDiff) < 0.01) {
            matches.push({
              name: excel.name,
              city: excel.city,
              excelQty: excel.qty,
              excelPrice: excel.price,
              dbQty: dbRow.qty || 0,
              dbPrice: dbRow.price || 0,
              customerId: dbRow.account_no
            });
          } else {
            mismatches.push({
              name: excel.name,
              city: excel.city,
              excelQty: excel.qty,
              excelPrice: excel.price,
              dbQty: dbRow.qty || 0,
              dbPrice: dbRow.price || 0,
              customerId: dbRow.account_no,
              qtyDiff,
              priceDiff
            });
          }
        } else {
          notInDb.push({
            name: excel.name,
            city: excel.city,
            qty: excel.qty,
            price: excel.price,
            bestMatch: match?.bestMatch ? `${match.bestMatch.company} (${Math.round(match.confidence * 100)}%)` : null,
            matchedCustomerId: (match?.bestMatch && match.confidence >= 0.65) ? match.bestMatch.customerId : null,
            suggestedCustomerId: match?.bestMatch?.customerId || null // Store suggestion even if confidence is low
          });
        }
      }

      // Find DB entries not in Excel
      const notInExcel: NotInExcelEntry[] = [];
      for (const dbRow of (dbStats || [])) {
        if (!matchedDbAccounts.has(dbRow.account_no)) {
          notInExcel.push({
            name: dbRow.customer_name || '',
            city: dbRow.city || '',
            qty: dbRow.qty || 0,
            price: dbRow.price || 0,
            customerId: dbRow.account_no
          });
        }
      }

      setCompareResults({ matches, mismatches, notInDb, notInExcel });

      console.log('[runComparison]', {
        excelRows: excelRows.length,
        dbStats: dbStats?.length,
        matches: matches.length,
        mismatches: mismatches.length,
        notInDb: notInDb.length,
        notInExcel: notInExcel.length
      });
    } catch (err: any) {
      console.error('[runComparison] Error:', err);
      alert(err?.message || 'Comparison failed');
    } finally {
      setIsComparing(false);
    }
  }

  // Fix mismatches: update DB values to match Excel (source of truth)
  async function fixMismatches() {
    if (!id || !compareSalespersonId || !compareResults?.mismatches.length) return;

    const count = compareResults.mismatches.length;
    if (!confirm(`Update ${count} entries in the database to match Excel values?\n\nThis will overwrite the current qty and price values.`)) {
      return;
    }

    setIsFixing(true);
    setFixResult(null);

    try {
      let updated = 0;
      for (const mismatch of compareResults.mismatches) {
        const { error } = await supabase
          .from('sales_stats')
          .update({ qty: mismatch.excelQty, price: mismatch.excelPrice })
          .eq('season_id', id)
          .eq('account_no', mismatch.customerId);

        if (error) {
          console.error('[fixMismatches] Error updating', mismatch.customerId, error);
        } else {
          updated++;
        }
      }

      setFixResult({
        success: true,
        message: `Updated ${updated}/${count} entries to match Excel values`
      });

      // Re-run comparison to show updated state
      await runComparison();
    } catch (err: any) {
      console.error('[fixMismatches] Error:', err);
      setFixResult({
        success: false,
        message: err?.message || 'Failed to fix mismatches'
      });
    } finally {
      setIsFixing(false);
    }
  }

  // Handle accepting auto-matched customer
  function handleAcceptMatch(rowIndex: number) {
    setNotInDbMappings(prev => {
      const next = new Map(prev);
      next.set(rowIndex, { status: 'accepted' });
      return next;
    });
  }

  // Bulk accept all suggestions
  function handleBulkAcceptSuggestions() {
    if (!compareResults?.notInDb) return;
    
    setNotInDbMappings(prev => {
      const next = new Map(prev);
      compareResults.notInDb.forEach((e, i) => {
        // Only accept if there's a suggestion and it hasn't been declined or manually mapped
        const existing = prev.get(i);
        if (!existing && (e.matchedCustomerId || e.suggestedCustomerId)) {
          next.set(i, { status: 'accepted' });
        }
      });
      return next;
    });
  }

  // Handle declining auto-matched customer
  function handleDeclineMatch(rowIndex: number) {
    setNotInDbMappings(prev => {
      const next = new Map(prev);
      next.set(rowIndex, { status: 'declined' });
      return next;
    });
  }

  // Handle manual customer mapping
  function handleManualMapping(rowIndex: number, customerId: string | null) {
    setNotInDbMappings(prev => {
      const next = new Map(prev);
      if (customerId) {
        next.set(rowIndex, { status: 'declined', manualCustomerId: customerId });
      } else {
        // If cleared, set to skip
        next.set(rowIndex, { status: 'skip' });
      }
      return next;
    });
  }

  // Add missing entries: insert Excel data for entries not in DB
  async function addMissingEntries() {
    if (!id || !compareSalespersonId || !compareResults?.notInDb.length) return;

    // Build list of entries to add based on mappings
    const entriesToAdd: Array<{ name: string; city: string; qty: number; price: number; customerId: string }> = [];
    
    compareResults.notInDb.forEach((e, index) => {
      const mapping = notInDbMappings.get(index);
      
      // If accepted, use the matched/suggested customer
      if (mapping?.status === 'accepted') {
        const customerId = e.matchedCustomerId || e.suggestedCustomerId;
        if (customerId) {
          entriesToAdd.push({
            name: e.name,
            city: e.city,
            qty: e.qty,
            price: e.price,
            customerId: customerId
          });
        }
      }
      // If no mapping and has matchedCustomerId (high confidence auto-match), use it
      else if (!mapping && e.matchedCustomerId) {
        entriesToAdd.push({
          name: e.name,
          city: e.city,
          qty: e.qty,
          price: e.price,
          customerId: e.matchedCustomerId
        });
      }
      // If declined with manual mapping, use the manual customer
      else if (mapping?.status === 'declined' && mapping.manualCustomerId) {
        entriesToAdd.push({
          name: e.name,
          city: e.city,
          qty: e.qty,
          price: e.price,
          customerId: mapping.manualCustomerId
        });
      }
      // Skip if status is 'skip' or declined without manual mapping
    });

    if (entriesToAdd.length === 0) {
      alert('No entries to add. Please accept auto-matched entries or manually map declined entries.');
      return;
    }

    // Detect and merge duplicates (same customerId)
    const mergedByCustomerId = new Map<string, { name: string; city: string; qty: number; price: number; count: number }>();
    
    for (const entry of entriesToAdd) {
      const existing = mergedByCustomerId.get(entry.customerId);
      if (existing) {
        // Merge: sum qty and price
        existing.qty += entry.qty;
        existing.price += entry.price;
        existing.count += 1;
      } else {
        mergedByCustomerId.set(entry.customerId, {
          name: entry.name,
          city: entry.city,
          qty: entry.qty,
          price: entry.price,
          count: 1
        });
      }
    }

    const mergedCount = mergedByCustomerId.size;
    const originalCount = entriesToAdd.length;
    const hasDuplicates = originalCount > mergedCount;

    const confirmMsg = hasDuplicates
      ? `Found ${originalCount} entries mapping to ${mergedCount} unique customers.\n\n` +
        `Duplicates will be merged (qty and price summed).\n\n` +
        `Continue?`
      : `Add ${originalCount} new entries to the database?\n\nThis includes accepted auto-matches and manually mapped entries.`;

    if (!confirm(confirmMsg)) {
      return;
    }

    setIsFixing(true);
    setFixResult(null);

    try {
      const rowsToInsert = Array.from(mergedByCustomerId.entries()).map(([customerId, data]) => ({
        season_id: id,
        account_no: customerId,
        customer_name: data.name,
        city: data.city,
        qty: data.qty,
        price: data.price,
        salesperson_id: compareSalespersonId,
        currency: 'DKK',
        frozen: false
      }));

      const { error } = await supabase
        .from('sales_stats')
        .upsert(rowsToInsert as any, { onConflict: 'season_id,account_no' });

      if (error) throw new Error(error.message);

      const resultMsg = hasDuplicates
        ? `Added ${mergedCount} unique customers (merged ${originalCount} entries)`
        : `Added ${originalCount} entries from Excel`;

      setFixResult({
        success: true,
        message: resultMsg
      });

      // Clear mappings and re-run comparison
      setNotInDbMappings(new Map());
      await runComparison();
    } catch (err: any) {
      console.error('[addMissingEntries] Error:', err);
      setFixResult({
        success: false,
        message: err?.message || 'Failed to add entries'
      });
    } finally {
      setIsFixing(false);
    }
  }

  // Add unmatched entries to "Z. ÆLDRE POSTERINGER" (old entries) customer
  const OLD_ENTRIES_CUSTOMER_NAME = 'Z. ÆLDRE POSTERINGER';

  async function addToOldEntries() {
    if (!id || !compareSalespersonId || !compareResults?.notInDb.length) return;

    // Get entries that couldn't be matched
    const unmatchedEntries = compareResults.notInDb.filter(e => !e.matchedCustomerId);

    if (unmatchedEntries.length === 0) {
      alert('No unmatched entries to add. All entries either matched or can be added individually.');
      return;
    }

    // Calculate totals
    const totalQty = unmatchedEntries.reduce((sum, e) => sum + e.qty, 0);
    const totalPrice = unmatchedEntries.reduce((sum, e) => sum + e.price, 0);

    if (!confirm(`Add ${unmatchedEntries.length} unmatched entries to "${OLD_ENTRIES_CUSTOMER_NAME}"?\n\nTotal Qty: ${totalQty.toLocaleString()}\nTotal Price: ${totalPrice.toLocaleString()}\n\nThis will create the customer if it doesn't exist for this salesperson.`)) {
      return;
    }

    setIsFixing(true);
    setFixResult(null);

    try {
      // Check if the old entries customer exists for this salesperson
      const { data: existingCustomers } = await supabase
        .from('customers')
        .select('customer_id, company, salesperson_id')
        .eq('salesperson_id', compareSalespersonId)
        .ilike('company', OLD_ENTRIES_CUSTOMER_NAME)
        .limit(1);

      let customerId: string;

      const firstCustomer = existingCustomers?.[0];
      if (firstCustomer) {
        // Use existing customer
        customerId = firstCustomer.customer_id;
        console.log('[addToOldEntries] Found existing customer:', customerId);
      } else {
        // Create new customer for this salesperson
        // Generate a unique customer_id
        const timestamp = Date.now().toString(36).toUpperCase();
        const newCustomerId = `OLD-${compareSalespersonId.slice(0, 8)}-${timestamp}`;

        const salesperson = salespersons?.find(sp => sp.id === compareSalespersonId);

        const { error: insertError } = await supabase
          .from('customers')
          .insert({
            customer_id: newCustomerId,
            company: OLD_ENTRIES_CUSTOMER_NAME,
            city: 'Diverse',
            salesperson_id: compareSalespersonId,
            nulled: false,
            excluded: false,
            permanently_closed: false
          });

        if (insertError) {
          throw new Error(`Failed to create customer: ${insertError.message}`);
        }

        customerId = newCustomerId;
        console.log('[addToOldEntries] Created new customer:', customerId, 'for salesperson:', salesperson?.name);
      }

      // Now add/update the sales_stats entry for this customer + season
      const { data: existingStats } = await supabase
        .from('sales_stats')
        .select('id, qty, price')
        .eq('season_id', id)
        .eq('account_no', customerId)
        .maybeSingle();

      if (existingStats) {
        // Update existing entry by adding to it
        const newQty = (existingStats.qty || 0) + totalQty;
        const newPrice = (existingStats.price || 0) + totalPrice;

        const { error: updateError } = await supabase
          .from('sales_stats')
          .update({ qty: newQty, price: newPrice })
          .eq('id', existingStats.id);

        if (updateError) throw new Error(updateError.message);

        console.log('[addToOldEntries] Updated existing stats:', { oldQty: existingStats.qty, oldPrice: existingStats.price, newQty, newPrice });
      } else {
        // Insert new entry
        const { error: insertError } = await supabase
          .from('sales_stats')
          .insert({
            season_id: id,
            account_no: customerId,
            customer_name: OLD_ENTRIES_CUSTOMER_NAME,
            city: 'Diverse',
            qty: totalQty,
            price: totalPrice,
            salesperson_id: compareSalespersonId,
            currency: 'DKK',
            frozen: false
          });

        if (insertError) throw new Error(insertError.message);

        console.log('[addToOldEntries] Inserted new stats entry');
      }

      setFixResult({
        success: true,
        message: `Added ${unmatchedEntries.length} entries to "${OLD_ENTRIES_CUSTOMER_NAME}" (Qty: ${totalQty.toLocaleString()}, Price: ${totalPrice.toLocaleString()})`
      });

      // Re-run comparison to show updated state
      await runComparison();
    } catch (err: any) {
      console.error('[addToOldEntries] Error:', err);
      setFixResult({
        success: false,
        message: err?.message || 'Failed to add to old entries'
      });
    } finally {
      setIsFixing(false);
    }
  }

  // Move all records from this season to another season
  async function moveRecordsToSeason() {
    if (!id || !moveToSeasonId) return;

    setIsMoving(true);
    setMoveResult(null);

    try {
      // Fetch all records for current season
      const { data: records, error: fetchError } = await supabase
        .from('sales_stats')
        .select('*')
        .eq('season_id', id);

      if (fetchError) throw new Error(fetchError.message);

      if (!records || records.length === 0) {
        setMoveResult({ success: false, message: 'No records found in this season to move' });
        setIsMoving(false);
        return;
      }

      // Upsert records into target season (overwrite conflicts)
      // Strip id and created_at so Postgres generates new primary keys
      const targetRecords = records.map(({ id: _id, created_at: _ca, ...rest }) => ({ ...rest, season_id: moveToSeasonId }));
      const { error: upsertError } = await supabase
        .from('sales_stats')
        .upsert(targetRecords, { onConflict: 'season_id,account_no' });

      if (upsertError) throw new Error(upsertError.message);

      // Delete from current season
      const { data: deleted, error: deleteError } = await supabase
        .from('sales_stats')
        .delete()
        .eq('season_id', id)
        .select('id');

      if (deleteError) throw new Error(deleteError.message);
      console.log('[moveRecordsToSeason] Deleted', deleted?.length ?? 0, 'records from source season');

      const targetSeason = allSeasons?.find(s => s.id === moveToSeasonId);
      const targetName = targetSeason ? `${targetSeason.name}${targetSeason.year ? ` (${targetSeason.year})` : ''}` : moveToSeasonId;
      setMoveResult({
        success: true,
        message: `Successfully moved ${records.length} records to "${targetName}"`
      });
      setMoveConfirmStep(false);
      setMoveToSeasonId('');
    } catch (err: any) {
      console.error('[moveRecordsToSeason] Error:', err);
      setMoveResult({ success: false, message: err?.message || 'Failed to move records' });
    } finally {
      setIsMoving(false);
    }
  }

  // Clear ALL sales_stats for this season
  async function clearAllSeasonRecords() {
    if (!id) return;

    setIsClearingAll(true);
    setClearAllResult(null);

    try {
      // First, get count of records to delete
      const { count: recordCount, error: countError } = await supabase
        .from('sales_stats')
        .select('*', { count: 'exact', head: true })
        .eq('season_id', id);

      if (countError) throw new Error(countError.message);

      console.log('[clearAllSeasonRecords] Found', recordCount, 'records for season', id);

      if (recordCount === 0) {
        setClearAllResult({ success: true, message: 'No records found for this season' });
        setClearAllConfirmStep(false);
        setIsClearingAll(false);
        return;
      }

      // Now delete all records
      const { error: deleteError } = await supabase
        .from('sales_stats')
        .delete()
        .eq('season_id', id);

      if (deleteError) throw new Error(deleteError.message);

      setClearAllResult({ success: true, message: `Deleted ${recordCount} records from this season` });
      setClearAllConfirmStep(false);
      console.log('[clearAllSeasonRecords] Successfully deleted', recordCount, 'records from season', id);
    } catch (err: any) {
      console.error('[clearAllSeasonRecords] Error:', err);
      setClearAllResult({ success: false, message: err?.message || 'Failed to clear records' });
    } finally {
      setIsClearingAll(false);
    }
  }

  const canRunMatching = mapping.name && mapping.city && mapping.qty && mapping.price && uploadedRows.length > 0;

  // Count importable rows
  const importableCount = useMemo(() => {
    if (!matchResults) return 0;
    let count = matched.length;
    count += review.filter(r => r.bestMatch || overrides.has(r.rowIndex)).length;
    count += unmatched.filter(r => overrides.has(r.rowIndex)).length;
    return count;
  }, [matchResults, matched, review, unmatched, overrides]);

  const canImport = matchResults && importableCount > 0;

  // Prepare customer items for the compare salesperson (filtered by salesperson)
  const compareCustomerItems = useMemo(() => {
    if (!customers || !compareSalespersonId) return [];
    return customers
      .filter(c => c.salesperson_id === compareSalespersonId)
      .map(c => ({
        value: c.customer_id,
        label: c.company || c.customer_id,
        description: c.city || undefined
      }));
  }, [customers, compareSalespersonId]);

  const selectClass = 'h-9 w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2';

  return (
    <div className="space-y-4 max-w-4xl">
      {/* Season Header */}
      {season && (
        <div className="flex items-start gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">{season.name}</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              {season.year ? `Year ${season.year} · ` : ''}Created {new Date(season.created_at).toLocaleDateString()}
            </p>
          </div>
        </div>
      )}

      {/* Currency Conversion Rates */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Currency Conversion Rates</CardTitle>
            <CardDescription className="mt-0.5">Enter how many DKK equals 1 unit of each foreign currency for this season.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {(['EUR', 'NOK', 'SEK'] as const).map((code) => (
              <div key={code} className="space-y-1.5">
                <label className="text-xs font-medium text-slate-600">{code} → DKK</label>
                <Input
                  type="number"
                  step="0.0001"
                  value={localRates[code] ?? 0}
                  onChange={(e) => {
                    const v = Number(e.target.value || 0) || 0;
                    handleRateChange(code, v);
                  }}
                />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={saveRates}
              disabled={!hasChanges || saving}
            >
              {saving ? 'Saving...' : 'Save Currency Rates'}
            </Button>
            {saveSuccess && <span className="text-sm text-green-600 font-medium">Saved</span>}
            {hasChanges && !saving && !saveSuccess && (
              <span className="text-sm text-amber-600">Unsaved changes</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Season Dates */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Season Dates</CardTitle>
            <CardDescription className="mt-0.5">Define the sale period and delivery deadline for purchase planning.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-600">Start Sale</label>
              <Input
                type="date"
                value={startSale}
                onChange={(e) => handleDateChange('start_sale', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-600">End Sale</label>
              <Input
                type="date"
                value={endSale}
                onChange={(e) => handleDateChange('end_sale', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-600">Latest Delivery</label>
              <Input
                type="date"
                value={latestDelivery}
                onChange={(e) => handleDateChange('latest_delivery', e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={saveSeasonDates}
              disabled={!datesChanged || savingDates}
            >
              {savingDates ? 'Saving...' : 'Save Dates'}
            </Button>
            {datesSaveSuccess && <span className="text-sm text-green-600 font-medium">Saved</span>}
            {datesChanged && !savingDates && !datesSaveSuccess && (
              <span className="text-sm text-amber-600">Unsaved changes</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Upload Customer Stats */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Upload Customer Statistics</CardTitle>
            <CardDescription className="mt-0.5">Upload a CSV/XLSX with customer names, cities, quantities, and prices. We'll auto-match to existing customers.</CardDescription>
          </div>
          {(uploadedRows.length > 0 || matchResults) && (
            <Button variant="ghost" size="sm" onClick={resetUpload} className="text-slate-500">
              Reset
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Dropzone */}
          {!matchResults && uploadedRows.length === 0 && (
            <Dropzone
              accept=".csv,.xlsx,.xls"
              onFiles={handleFileUpload}
              className="border-2 border-dashed border-slate-200 hover:border-slate-400 transition-colors rounded-md"
            >
              <div className="text-center py-6">
                <div className="text-sm text-slate-600">Drop CSV or Excel file here, or click to browse</div>
                <div className="text-xs text-slate-400 mt-1">Required columns: Name, City, Qty, Price</div>
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
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium text-slate-700">Column Mapping</p>
                <p className="text-xs text-slate-500 mt-0.5">Loaded {uploadedRows.length} rows. Map the columns below:</p>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {(['name', 'city', 'qty', 'price'] as const).map((field) => (
                  <div key={field} className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-600 capitalize">{field === 'name' ? 'Name/Customer' : field} *</label>
                    <select
                      className={selectClass}
                      value={mapping[field]}
                      onChange={(e) => setMapping(prev => ({ ...prev, [field]: e.target.value }))}
                    >
                      <option value="">Select...</option>
                      {uploadedHeaders.map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              {/* Sample preview */}
              {mapping.name && (
                <div className="flex flex-wrap gap-1.5 text-xs text-slate-500">
                  <span className="font-medium">Sample:</span>
                  {uploadedRows.slice(0, 3).map((r, i) => (
                    <span key={i} className="inline-block bg-slate-100 rounded px-2 py-0.5 text-slate-700">
                      {r[mapping.name]}{mapping.city && r[mapping.city] ? ` · ${r[mapping.city]}` : ''}
                    </span>
                  ))}
                </div>
              )}

              <Button
                onClick={runMatching}
                disabled={!canRunMatching || isMatching}
              >
                {isMatching ? 'Matching...' : 'Run Matching'}
              </Button>
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
              {/* Summary badges */}
              <div className="flex items-center gap-2 flex-wrap">
                <Badge className="bg-green-50 border-green-200 text-green-700">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 mr-1.5 inline-block" />
                  Matched: {matched.length}
                </Badge>
                <Badge className="bg-amber-50 border-amber-200 text-amber-700">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 mr-1.5 inline-block" />
                  Needs Review: {review.length}
                </Badge>
                <Badge className="bg-red-50 border-red-200 text-red-700">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 mr-1.5 inline-block" />
                  Unmatched: {unmatched.length}
                </Badge>
              </div>

              {/* Matched Section */}
              {matched.length > 0 && (
                <details open className="border rounded-md overflow-hidden">
                  <summary className="px-3 py-2 bg-green-50 cursor-pointer font-medium text-xs text-green-800 select-none">
                    Matched ({matched.length}) — will be imported
                  </summary>
                  <div className="max-h-60 overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          <th className="text-left p-1.5 border-b font-medium text-slate-600">Excel Name</th>
                          <th className="text-left p-1.5 border-b font-medium text-slate-600">Excel City</th>
                          <th className="text-left p-1.5 border-b font-medium text-slate-600">Matched Customer</th>
                          <th className="text-left p-1.5 border-b font-medium text-slate-600">Matched City</th>
                          <th className="text-right p-1.5 border-b font-medium text-slate-600">Conf.</th>
                          <th className="text-right p-1.5 border-b font-medium text-slate-600">Qty</th>
                          <th className="text-right p-1.5 border-b font-medium text-slate-600">Price</th>
                        </tr>
                      </thead>
                      <tbody>
                        {matched.map((r) => (
                          <tr key={r.rowIndex} className="hover:bg-slate-50">
                            <td className="p-1.5 border-b">{r.originalName}</td>
                            <td className="p-1.5 border-b">{r.originalCity}</td>
                            <td className="p-1.5 border-b text-green-700">{r.bestMatch?.company}</td>
                            <td className="p-1.5 border-b text-slate-500">{r.bestMatch?.city}</td>
                            <td className="p-1.5 border-b text-right font-mono text-green-600">
                              {Math.round(r.confidence * 100)}%
                            </td>
                            <td className="p-1.5 border-b text-right">{r.qty}</td>
                            <td className="p-1.5 border-b text-right">{r.price.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}

              {/* Review Section */}
              {review.length > 0 && (
                <details open className="border rounded-md overflow-hidden">
                  <summary className="px-3 py-2 bg-amber-50 cursor-pointer font-medium text-xs text-amber-800 select-none">
                    Needs Review ({review.length}) — select correct customer or skip
                  </summary>
                  <div className="max-h-80 overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          <th className="text-left p-1.5 border-b font-medium text-slate-600">Excel Name</th>
                          <th className="text-left p-1.5 border-b font-medium text-slate-600">Excel City</th>
                          <th className="text-left p-1.5 border-b font-medium text-slate-600">Best Match</th>
                          <th className="text-left p-1.5 border-b font-medium text-slate-600 min-w-[200px]">Select Customer</th>
                          <th className="text-right p-1.5 border-b font-medium text-slate-600">Qty</th>
                          <th className="text-right p-1.5 border-b font-medium text-slate-600">Price</th>
                        </tr>
                      </thead>
                      <tbody>
                        {review.map((r) => {
                          const currentOverride = overrides.get(r.rowIndex);
                          const selectedId = currentOverride !== undefined ? currentOverride : r.bestMatch?.customerId;
                          return (
                            <tr key={r.rowIndex} className="hover:bg-slate-50">
                              <td className="p-1.5 border-b font-medium">{r.originalName}</td>
                              <td className="p-1.5 border-b">{r.originalCity}</td>
                              <td className="p-1.5 border-b">
                                {r.bestMatch && (
                                  <span className="text-amber-700">
                                    {r.bestMatch.company} ({r.bestMatch.city}) — {Math.round(r.bestMatch.score * 100)}%
                                  </span>
                                )}
                              </td>
                              <td className="p-1.5 border-b">
                                <SearchSelect
                                  items={customerItems}
                                  value={selectedId || ''}
                                  onChange={(val) => handleOverride(r.rowIndex, val || null)}
                                  placeholder="Select customer..."
                                  clearable
                                />
                              </td>
                              <td className="p-1.5 border-b text-right">{r.qty}</td>
                              <td className="p-1.5 border-b text-right">{r.price.toLocaleString()}</td>
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
                <details open className="border rounded-md overflow-hidden">
                  <summary className="px-3 py-2 bg-red-50 cursor-pointer font-medium text-xs text-red-800 select-none">
                    Unmatched ({unmatched.length}) — manually assign or skip
                  </summary>
                  <div className="p-3 space-y-2">
                    <button
                      onClick={downloadUnmatchedCsv}
                      className="text-xs text-red-700 hover:text-red-900 underline"
                    >
                      Download unmatched as CSV
                    </button>
                    <div className="max-h-72 overflow-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50 sticky top-0">
                          <tr>
                            <th className="text-left p-1.5 border-b font-medium text-slate-600">Excel Name</th>
                            <th className="text-left p-1.5 border-b font-medium text-slate-600">Excel City</th>
                            <th className="text-left p-1.5 border-b font-medium text-slate-600">Best Guess</th>
                            <th className="text-left p-1.5 border-b font-medium text-slate-600 min-w-[200px]">Assign Customer</th>
                            <th className="text-right p-1.5 border-b font-medium text-slate-600">Qty</th>
                            <th className="text-right p-1.5 border-b font-medium text-slate-600">Price</th>
                          </tr>
                        </thead>
                        <tbody>
                          {unmatched.map((r) => {
                            const assignedId = overrides.get(r.rowIndex) || '';
                            return (
                              <tr key={r.rowIndex} className={assignedId ? 'bg-green-50 hover:bg-green-100' : 'hover:bg-slate-50'}>
                                <td className="p-1.5 border-b font-medium text-red-700">{r.originalName}</td>
                                <td className="p-1.5 border-b">{r.originalCity}</td>
                                <td className="p-1.5 border-b text-slate-500">
                                  {r.bestMatch ? (
                                    <span>{r.bestMatch.company} ({r.bestMatch.city}) — <span className="font-mono text-red-600">{Math.round(r.bestMatch.score * 100)}%</span></span>
                                  ) : '—'}
                                </td>
                                <td className="p-1.5 border-b">
                                  <SearchSelect
                                    items={customerItems}
                                    value={assignedId}
                                    onChange={(val) => handleOverride(r.rowIndex, val || null)}
                                    placeholder="Search customer..."
                                    clearable
                                  />
                                </td>
                                <td className="p-1.5 border-b text-right">{r.qty}</td>
                                <td className="p-1.5 border-b text-right">{r.price.toLocaleString()}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </details>
              )}

              {/* Import Button */}
              <div className="flex items-center gap-3 pt-1">
                <Button
                  onClick={confirmImport}
                  disabled={!canImport || isImporting}
                  className={cn(!canImport && 'opacity-50')}
                >
                  {isImporting ? 'Importing...' : `Confirm Import (${importableCount} rows)`}
                </Button>
                <Button variant="outline" onClick={resetUpload}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Clear Salesperson Data */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Clear Salesperson Data</CardTitle>
            <CardDescription className="mt-0.5">Remove all sales statistics entries for a specific salesperson in this season. This action cannot be undone.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="flex-1 max-w-xs space-y-1.5">
              <label className="text-xs font-medium text-slate-600">Select Salesperson</label>
              <select
                className={selectClass}
                value={clearSalespersonId}
                onChange={(e) => {
                  setClearSalespersonId(e.target.value);
                  setClearResult(null);
                }}
              >
                <option value="">Select...</option>
                {(salespersons ?? []).map(sp => (
                  <option key={sp.id} value={sp.id}>{sp.name}</option>
                ))}
              </select>
            </div>
            <Button
              variant="destructive"
              onClick={clearSalespersonData}
              disabled={!clearSalespersonId || isClearing}
            >
              {isClearing ? 'Clearing...' : 'Clear Data'}
            </Button>
          </div>

          {clearResult && (
            <div className={cn(
              'rounded-md border px-3 py-2 text-sm',
              clearResult.success
                ? 'border-green-200 bg-green-50 text-green-700'
                : 'border-red-200 bg-red-50 text-red-700'
            )}>
              {clearResult.message}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Compare Customer Statistics */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Compare Customer Statistics</CardTitle>
            <CardDescription className="mt-0.5">
              Paste tab-separated data from Excel (Name, City, Qty, Price) to compare against existing data for a salesperson.
              Excel data is the source of truth — use "Fix" buttons to update the database to match.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="flex-1 max-w-xs space-y-1.5">
              <label className="text-xs font-medium text-slate-600">Select Salesperson</label>
              <select
                className={selectClass}
                value={compareSalespersonId}
                onChange={(e) => {
                  setCompareSalespersonId(e.target.value);
                  setCompareResults(null);
                }}
              >
                <option value="">Select...</option>
                {(salespersons ?? []).map(sp => (
                  <option key={sp.id} value={sp.id}>{sp.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-600">
              Paste data (tab-separated: Name → City → Qty → Price)
            </label>
            <textarea
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-xs font-mono h-32 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2"
              placeholder={"Customer Name\tCity\tQty\tPrice\nAcme Corp\tCopenhagen\t100\t5000\nBest Shop\tOslo\t50\t2500"}
              value={compareInput}
              onChange={(e) => {
                setCompareInput(e.target.value);
                setCompareResults(null);
              }}
            />
          </div>

          <Button
            onClick={runComparison}
            disabled={!compareSalespersonId || !compareInput.trim() || isComparing}
          >
            {isComparing ? 'Comparing...' : 'Compare'}
          </Button>

          {/* Compare Results */}
          {compareResults && (
            <div className="space-y-3 pt-1">
              {/* Summary badges */}
              <div className="flex items-center gap-2 flex-wrap">
                <Badge className="bg-green-50 border-green-200 text-green-700">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 mr-1.5 inline-block" />
                  Matches: {compareResults.matches.length}
                </Badge>
                <Badge className="bg-red-50 border-red-200 text-red-700">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 mr-1.5 inline-block" />
                  Mismatches: {compareResults.mismatches.length}
                </Badge>
                <Badge className="bg-amber-50 border-amber-200 text-amber-700">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 mr-1.5 inline-block" />
                  Not in DB: {compareResults.notInDb.length}
                </Badge>
                <Badge className="bg-blue-50 border-blue-200 text-blue-700">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 mr-1.5 inline-block" />
                  Not in Excel: {compareResults.notInExcel.length}
                </Badge>
              </div>

              {/* Fix Result */}
              {fixResult && (
                <div className={cn(
                  'rounded-md border px-3 py-2 text-xs',
                  fixResult.success
                    ? 'border-green-200 bg-green-50 text-green-700'
                    : 'border-red-200 bg-red-50 text-red-700'
                )}>
                  {fixResult.message}
                </div>
              )}

              {/* Mismatches */}
              {compareResults.mismatches.length > 0 && (
                <details open className="border rounded-md overflow-hidden">
                  <summary className="px-3 py-2 bg-red-50 cursor-pointer font-medium text-xs text-red-800 select-none">
                    Mismatches ({compareResults.mismatches.length}) — values differ between Excel and DB
                  </summary>
                  <div className="px-3 py-2 border-b bg-red-50/50 flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={fixMismatches}
                      disabled={isFixing}
                    >
                      {isFixing ? 'Fixing...' : `Fix All (${compareResults.mismatches.length})`}
                    </Button>
                    <span className="text-xs text-red-700">Update DB values to match Excel</span>
                  </div>
                  <div className="max-h-60 overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          <th className="text-left p-1.5 border-b font-medium text-slate-600">Customer</th>
                          <th className="text-left p-1.5 border-b font-medium text-slate-600">City</th>
                          <th className="text-right p-1.5 border-b font-medium text-slate-600">Excel Qty</th>
                          <th className="text-right p-1.5 border-b font-medium text-slate-600">DB Qty</th>
                          <th className="text-right p-1.5 border-b font-medium text-slate-600">Diff</th>
                          <th className="text-right p-1.5 border-b font-medium text-slate-600">Excel Price</th>
                          <th className="text-right p-1.5 border-b font-medium text-slate-600">DB Price</th>
                          <th className="text-right p-1.5 border-b font-medium text-slate-600">Diff</th>
                        </tr>
                      </thead>
                      <tbody>
                        {compareResults.mismatches.map((r, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <td className="p-1.5 border-b font-medium">{r.name}</td>
                            <td className="p-1.5 border-b">{r.city}</td>
                            <td className="p-1.5 border-b text-right">{r.excelQty}</td>
                            <td className="p-1.5 border-b text-right">{r.dbQty}</td>
                            <td className={cn('p-1.5 border-b text-right font-mono', r.qtyDiff !== 0 && 'text-red-600 font-medium')}>
                              {r.qtyDiff > 0 ? '+' : ''}{r.qtyDiff.toFixed(0)}
                            </td>
                            <td className="p-1.5 border-b text-right">{r.excelPrice.toLocaleString()}</td>
                            <td className="p-1.5 border-b text-right">{r.dbPrice.toLocaleString()}</td>
                            <td className={cn('p-1.5 border-b text-right font-mono', r.priceDiff !== 0 && 'text-red-600 font-medium')}>
                              {r.priceDiff > 0 ? '+' : ''}{r.priceDiff.toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}

              {/* Not in DB */}
              {compareResults.notInDb.length > 0 && (
                <details className="border rounded-md overflow-hidden">
                  <summary className="px-3 py-2 bg-amber-50 cursor-pointer font-medium text-xs text-amber-800 select-none">
                    Not in DB ({compareResults.notInDb.length}) — in Excel but not found in database
                  </summary>
                  <div className="px-3 py-2 border-b bg-amber-50/50 flex flex-wrap items-center gap-2">
                    {(() => {
                      const acceptedCount = compareResults.notInDb.filter((e, i) => {
                        const mapping = notInDbMappings.get(i);
                        // Count accepted suggestions
                        if (mapping?.status === 'accepted' && (e.matchedCustomerId || e.suggestedCustomerId)) return true;
                        // Count high-confidence auto-matches that weren't explicitly declined
                        if (!mapping && e.matchedCustomerId) return true;
                        // Count manual mappings
                        if (mapping?.status === 'declined' && mapping.manualCustomerId) return true;
                        return false;
                      }).length;
                      
                      const suggestionsCount = compareResults.notInDb.filter((e, i) => {
                        const mapping = notInDbMappings.get(i);
                        return !mapping && (e.matchedCustomerId || e.suggestedCustomerId);
                      }).length;
                      
                      return (
                        <>
                          {suggestionsCount > 0 && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={handleBulkAcceptSuggestions}
                                disabled={isFixing}
                                className="border-green-300 text-green-700 hover:bg-green-50"
                              >
                                Accept All Suggestions ({suggestionsCount})
                              </Button>
                              <div className="w-px h-6 bg-slate-300" />
                            </>
                          )}
                          {acceptedCount > 0 && (
                            <>
                              <Button
                                size="sm"
                                onClick={addMissingEntries}
                                disabled={isFixing}
                                className="bg-amber-600 hover:bg-amber-700 text-white"
                              >
                                {isFixing ? 'Adding...' : `Add Selected (${acceptedCount})`}
                              </Button>
                              <span className="text-xs text-amber-700 mr-4">Add accepted suggestions and manual mappings</span>
                            </>
                          )}
                        </>
                      );
                    })()}
                    {(() => {
                      const unmatchedSkippedCount = compareResults.notInDb.filter((e, i) => {
                        const mapping = notInDbMappings.get(i);
                        return (!e.matchedCustomerId && !mapping?.manualCustomerId) || 
                               (mapping?.status === 'skip');
                      }).length;
                      
                      return unmatchedSkippedCount > 0 && (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={addToOldEntries}
                            disabled={isFixing}
                          >
                            {isFixing ? 'Adding...' : `Add to "Z. ÆLDRE POSTERINGER" (${unmatchedSkippedCount})`}
                          </Button>
                          <span className="text-xs text-slate-600">Collect unmatched/skipped as old entries</span>
                        </>
                      );
                    })()}
                  </div>
                  <div className="max-h-96 overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          <th className="text-left p-1.5 border-b font-medium text-slate-600">Customer</th>
                          <th className="text-left p-1.5 border-b font-medium text-slate-600">City</th>
                          <th className="text-right p-1.5 border-b font-medium text-slate-600">Qty</th>
                          <th className="text-right p-1.5 border-b font-medium text-slate-600">Price</th>
                          <th className="text-left p-1.5 border-b font-medium text-slate-600 min-w-[180px]">Auto Match</th>
                          <th className="text-left p-1.5 border-b font-medium text-slate-600 min-w-[220px]">Manual Mapping</th>
                          <th className="text-center p-1.5 border-b font-medium text-slate-600">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {compareResults.notInDb.map((r, i) => {
                          const mapping = notInDbMappings.get(i);
                          const isAccepted = mapping?.status === 'accepted';
                          const isDeclined = mapping?.status === 'declined' || mapping?.status === 'skip';
                          const hasManualMapping = mapping?.manualCustomerId;
                          const isSkipped = mapping?.status === 'skip';
                          
                          return (
                            <tr 
                              key={i} 
                              className={cn(
                                'hover:bg-slate-50',
                                isAccepted && 'bg-green-50',
                                isDeclined && !hasManualMapping && 'bg-slate-50',
                                hasManualMapping && 'bg-blue-50'
                              )}
                            >
                              <td className="p-1.5 border-b font-medium text-amber-700">{r.name}</td>
                              <td className="p-1.5 border-b">{r.city}</td>
                              <td className="p-1.5 border-b text-right">{r.qty}</td>
                              <td className="p-1.5 border-b text-right">{r.price.toLocaleString()}</td>
                              <td className="p-1.5 border-b">
                                {r.bestMatch ? (
                                  <div className="flex items-center gap-1">
                                    <span className={cn(
                                      'text-xs',
                                      isAccepted ? 'text-green-700 font-medium' : 
                                      r.matchedCustomerId ? 'text-slate-600' : 'text-amber-600'
                                    )}>
                                      {r.bestMatch}
                                    </span>
                                    {isAccepted && <span className="text-green-600">✓</span>}
                                    {isDeclined && <span className="text-red-600">✕</span>}
                                  </div>
                                ) : (
                                  <span className="text-slate-400 text-xs">No match found</span>
                                )}
                              </td>
                              <td className="p-1.5 border-b">
                                {isDeclined && (
                                  <SearchSelect
                                    items={compareCustomerItems}
                                    value={mapping?.manualCustomerId || ''}
                                    onChange={(val) => handleManualMapping(i, val || null)}
                                    placeholder="Select customer..."
                                    clearable
                                  />
                                )}
                              </td>
                              <td className="p-1.5 border-b">
                                <div className="flex items-center justify-center gap-1">
                                  {r.bestMatch && !isAccepted && !isDeclined && (
                                    <>
                                      <button
                                        onClick={() => handleAcceptMatch(i)}
                                        className="rounded p-1 hover:bg-green-100 text-green-600"
                                        title="Accept suggestion"
                                      >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                        </svg>
                                      </button>
                                      <button
                                        onClick={() => handleDeclineMatch(i)}
                                        className="rounded p-1 hover:bg-red-100 text-red-600"
                                        title="Decline and map manually"
                                      >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                        </svg>
                                      </button>
                                      <button
                                        onClick={() => handleDeclineMatch(i)}
                                        className="rounded px-2 py-1 text-xs bg-slate-100 hover:bg-slate-200 text-slate-700"
                                        title="Map manually"
                                      >
                                        Map
                                      </button>
                                    </>
                                  )}
                                  {!r.bestMatch && !isDeclined && (
                                    <button
                                      onClick={() => handleDeclineMatch(i)}
                                      className="rounded px-2 py-1 text-xs bg-slate-100 hover:bg-slate-200 text-slate-700"
                                      title="Map manually"
                                    >
                                      Map
                                    </button>
                                  )}
                                  {isSkipped && (
                                    <span className="text-slate-400 text-xs" title="Skipped">
                                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                                      </svg>
                                    </span>
                                  )}
                                  {(isAccepted || hasManualMapping) && (
                                    <button
                                      onClick={() => {
                                        setNotInDbMappings(prev => {
                                          const next = new Map(prev);
                                          next.delete(i);
                                          return next;
                                        });
                                      }}
                                      className="rounded p-1 hover:bg-slate-100 text-slate-500"
                                      title="Reset"
                                    >
                                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                      </svg>
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}

              {/* Not in Excel */}
              {compareResults.notInExcel.length > 0 && (
                <details className="border rounded-md overflow-hidden">
                  <summary className="px-3 py-2 bg-blue-50 cursor-pointer font-medium text-xs text-blue-800 select-none">
                    Not in Excel ({compareResults.notInExcel.length}) — in DB but not in pasted data
                  </summary>
                  <div className="max-h-48 overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          <th className="text-left p-1.5 border-b font-medium text-slate-600">Customer</th>
                          <th className="text-left p-1.5 border-b font-medium text-slate-600">City</th>
                          <th className="text-right p-1.5 border-b font-medium text-slate-600">Qty</th>
                          <th className="text-right p-1.5 border-b font-medium text-slate-600">Price</th>
                        </tr>
                      </thead>
                      <tbody>
                        {compareResults.notInExcel.map((r, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <td className="p-1.5 border-b font-medium text-blue-700">{r.name}</td>
                            <td className="p-1.5 border-b">{r.city}</td>
                            <td className="p-1.5 border-b text-right">{r.qty}</td>
                            <td className="p-1.5 border-b text-right">{r.price.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}

              {/* Matches */}
              {compareResults.matches.length > 0 && (
                <details className="border rounded-md overflow-hidden">
                  <summary className="px-3 py-2 bg-green-50 cursor-pointer font-medium text-xs text-green-800 select-none">
                    Matches ({compareResults.matches.length}) — values match exactly
                  </summary>
                  <div className="max-h-48 overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          <th className="text-left p-1.5 border-b font-medium text-slate-600">Customer</th>
                          <th className="text-left p-1.5 border-b font-medium text-slate-600">City</th>
                          <th className="text-right p-1.5 border-b font-medium text-slate-600">Qty</th>
                          <th className="text-right p-1.5 border-b font-medium text-slate-600">Price</th>
                        </tr>
                      </thead>
                      <tbody>
                        {compareResults.matches.map((r, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <td className="p-1.5 border-b text-green-700">{r.name}</td>
                            <td className="p-1.5 border-b">{r.city}</td>
                            <td className="p-1.5 border-b text-right">{r.excelQty}</td>
                            <td className="p-1.5 border-b text-right">{r.excelPrice.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Move Records to Another Season */}
      <Card className="border-amber-200">
        <CardHeader>
          <div>
            <CardTitle>Move Records to Another Season</CardTitle>
            <CardDescription className="mt-0.5">
              Move all sales statistics records from this season to a different season. Existing records in the target season for the same customer will be overwritten.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="flex-1 max-w-xs space-y-1.5">
              <label className="text-xs font-medium text-slate-600">Target Season</label>
              <select
                className={selectClass}
                value={moveToSeasonId}
                onChange={(e) => {
                  setMoveToSeasonId(e.target.value);
                  setMoveConfirmStep(false);
                  setMoveResult(null);
                }}
              >
                <option value="">Select season...</option>
                {(allSeasons ?? []).filter(s => s.id !== id && !s.hidden).map(s => (
                  <option key={s.id} value={s.id}>{s.name}{s.year ? ` (${s.year})` : ''}</option>
                ))}
              </select>
            </div>
            {!moveConfirmStep ? (
              <Button
                variant="outline"
                onClick={() => setMoveConfirmStep(true)}
                disabled={!moveToSeasonId || isMoving}
                className="border-amber-300 text-amber-700 hover:bg-amber-50"
              >
                Move Records
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <Button
                  variant="destructive"
                  onClick={moveRecordsToSeason}
                  disabled={isMoving}
                >
                  {isMoving ? 'Moving...' : 'Confirm Move'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setMoveConfirmStep(false)}
                  disabled={isMoving}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>

          {moveConfirmStep && moveToSeasonId && (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2.5 text-sm text-amber-800">
              <span className="font-medium">Warning:</span> This will move ALL sales statistics records from this season to{' '}
              <span className="font-semibold">{(() => { const t = allSeasons?.find(s => s.id === moveToSeasonId); return t ? `${t.name}${t.year ? ` (${t.year})` : ''}` : ''; })()}</span>.
              Records for the same customer already in the target season will be overwritten. This action cannot be undone.
            </div>
          )}

          {moveResult && (
            <div className={cn(
              'rounded-md border px-3 py-2 text-sm',
              moveResult.success
                ? 'border-green-200 bg-green-50 text-green-700'
                : 'border-red-200 bg-red-50 text-red-700'
            )}>
              {moveResult.message}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Clear All Season Records */}
      <Card className="border-red-200">
        <CardHeader>
          <div>
            <CardTitle>Clear All Season Records</CardTitle>
            <CardDescription className="mt-0.5">
              Delete all sales statistics records for this season. This action cannot be undone.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            {!clearAllConfirmStep ? (
              <Button
                variant="outline"
                onClick={() => { setClearAllConfirmStep(true); setClearAllResult(null); }}
                disabled={isClearingAll}
                className="border-red-300 text-red-700 hover:bg-red-50"
              >
                Clear All Records
              </Button>
            ) : (
              <>
                <Button
                  variant="destructive"
                  onClick={clearAllSeasonRecords}
                  disabled={isClearingAll}
                >
                  {isClearingAll ? 'Clearing...' : 'Yes, Delete All'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setClearAllConfirmStep(false)}
                  disabled={isClearingAll}
                >
                  Cancel
                </Button>
              </>
            )}
          </div>

          {clearAllConfirmStep && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2.5 text-sm text-red-800">
              <span className="font-medium">Warning:</span> This will permanently delete ALL sales statistics records for{' '}
              <span className="font-semibold">{season?.name}</span>. This action cannot be undone.
            </div>
          )}

          {clearAllResult && (
            <div className={cn(
              'rounded-md border px-3 py-2 text-sm',
              clearAllResult.success
                ? 'border-green-200 bg-green-50 text-green-700'
                : 'border-red-200 bg-red-50 text-red-700'
            )}>
              {clearAllResult.message}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

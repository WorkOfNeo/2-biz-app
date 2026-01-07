'use client';
import { useParams } from 'next/navigation';
import { useState, useEffect, useMemo } from 'react';
import useSWR from 'swr';
import { supabase } from '../../../../lib/supabaseClient';
import { Dropzone } from '../../../../components/ui/dropzone';
import { SearchSelect } from '../../../../components/SearchSelect';
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

  // Fetch salespersons for clear data section
  const { data: salespersons } = useSWR('salespersons:all', async () => {
    const { data, error } = await supabase.from('salespersons').select('id, name').order('name');
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; name: string }[];
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

  // Compare data state
  const [compareSalespersonId, setCompareSalespersonId] = useState<string>('');
  const [compareInput, setCompareInput] = useState<string>('');
  const [isComparing, setIsComparing] = useState(false);
  const [isFixing, setIsFixing] = useState(false);
  const [fixResult, setFixResult] = useState<{ success: boolean; message: string } | null>(null);
  const [compareResults, setCompareResults] = useState<{
    matches: Array<{ name: string; city: string; excelQty: number; excelPrice: number; dbQty: number; dbPrice: number; customerId: string }>;
    mismatches: Array<{ name: string; city: string; excelQty: number; excelPrice: number; dbQty: number; dbPrice: number; customerId: string; qtyDiff: number; priceDiff: number }>;
    notInDb: Array<{ name: string; city: string; qty: number; price: number; bestMatch: string | null; matchedCustomerId: string | null }>;
    notInExcel: Array<{ name: string; city: string; qty: number; price: number; customerId: string }>;
  } | null>(null);
  
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
      type NotInDbEntry = { name: string; city: string; qty: number; price: number; bestMatch: string | null; matchedCustomerId: string | null };
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
            matchedCustomerId: (match?.bestMatch && match.confidence >= 0.65) ? match.bestMatch.customerId : null
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

  // Add missing entries: insert Excel data for entries not in DB
  async function addMissingEntries() {
    if (!id || !compareSalespersonId || !compareResults?.notInDb.length) return;

    // Only add entries that have a matched customer ID
    const entriesToAdd = compareResults.notInDb.filter(e => e.matchedCustomerId);
    
    if (entriesToAdd.length === 0) {
      alert('No entries with matched customers to add. Entries need at least 65% confidence match to be added.');
      return;
    }

    if (!confirm(`Add ${entriesToAdd.length} new entries to the database?\n\nThese are entries from Excel that were matched to customers but don't exist in the DB yet.`)) {
      return;
    }

    setIsFixing(true);
    setFixResult(null);

    try {
      const rowsToInsert = entriesToAdd.map(e => ({
        season_id: id,
        account_no: e.matchedCustomerId,
        customer_name: e.name,
        city: e.city,
        qty: e.qty,
        price: e.price,
        salesperson_id: compareSalespersonId,
        currency: 'DKK',
        frozen: false
      }));

      const { error } = await supabase
        .from('sales_stats')
        .upsert(rowsToInsert as any, { onConflict: 'season_id,account_no' });

      if (error) throw new Error(error.message);

      setFixResult({
        success: true,
        message: `Added ${entriesToAdd.length} entries from Excel`
      });

      // Re-run comparison to show updated state
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
            <div className="flex items-center gap-4 text-xs">
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full bg-green-500"></span>
                Matched: {matched.length}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span>
                Needs Review: {review.length}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500"></span>
                Unmatched: {unmatched.length}
              </span>
            </div>

            {/* Matched Section */}
            {matched.length > 0 && (
              <details open className="border rounded-md">
                <summary className="px-3 py-2 bg-green-50 cursor-pointer font-medium text-xs text-green-800">
                  Matched ({matched.length}) — will be imported
                </summary>
                <div className="max-h-60 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="text-left p-1.5 border-b">Excel Name</th>
                        <th className="text-left p-1.5 border-b">Excel City</th>
                        <th className="text-left p-1.5 border-b">Matched Customer</th>
                        <th className="text-left p-1.5 border-b">Matched City</th>
                        <th className="text-right p-1.5 border-b">Conf.</th>
                        <th className="text-right p-1.5 border-b">Qty</th>
                        <th className="text-right p-1.5 border-b">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {matched.map((r) => (
                        <tr key={r.rowIndex} className="hover:bg-gray-50">
                          <td className="p-1.5 border-b">{r.originalName}</td>
                          <td className="p-1.5 border-b">{r.originalCity}</td>
                          <td className="p-1.5 border-b text-green-700">{r.bestMatch?.company}</td>
                          <td className="p-1.5 border-b text-gray-500">{r.bestMatch?.city}</td>
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
              <details open className="border rounded-md">
                <summary className="px-3 py-2 bg-amber-50 cursor-pointer font-medium text-xs text-amber-800">
                  Needs Review ({review.length}) — select correct customer or skip
                </summary>
                <div className="max-h-80 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="text-left p-1.5 border-b">Excel Name</th>
                        <th className="text-left p-1.5 border-b">Excel City</th>
                        <th className="text-left p-1.5 border-b">Best Match</th>
                        <th className="text-left p-1.5 border-b min-w-[200px]">Select Customer</th>
                        <th className="text-right p-1.5 border-b">Qty</th>
                        <th className="text-right p-1.5 border-b">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {review.map((r) => {
                        const currentOverride = overrides.get(r.rowIndex);
                        const selectedId = currentOverride !== undefined ? currentOverride : r.bestMatch?.customerId;
                        return (
                          <tr key={r.rowIndex} className="hover:bg-gray-50">
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
              <details open className="border rounded-md">
                <summary className="px-3 py-2 bg-red-50 cursor-pointer font-medium text-xs text-red-800">
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
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="text-left p-1.5 border-b">Excel Name</th>
                          <th className="text-left p-1.5 border-b">Excel City</th>
                          <th className="text-left p-1.5 border-b">Best Guess</th>
                          <th className="text-left p-1.5 border-b min-w-[200px]">Assign Customer</th>
                          <th className="text-right p-1.5 border-b">Qty</th>
                          <th className="text-right p-1.5 border-b">Price</th>
                        </tr>
                      </thead>
                      <tbody>
                        {unmatched.map((r) => {
                          const assignedId = overrides.get(r.rowIndex) || '';
                          return (
                            <tr key={r.rowIndex} className={assignedId ? 'bg-green-50 hover:bg-green-100' : 'hover:bg-gray-50'}>
                              <td className="p-1.5 border-b font-medium text-red-700">{r.originalName}</td>
                              <td className="p-1.5 border-b">{r.originalCity}</td>
                              <td className="p-1.5 border-b text-gray-500">
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
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={confirmImport}
                disabled={!canImport || isImporting}
                className={
                  'rounded-md px-4 py-2 text-xs font-medium transition-colors ' +
                  (canImport && !isImporting
                    ? 'bg-green-600 text-white hover:bg-green-700'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed')
                }
              >
                {isImporting ? 'Importing...' : `Confirm Import (${importableCount} rows)`}
              </button>
              <button
                onClick={resetUpload}
                className="rounded-md border px-4 py-2 text-xs font-medium hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Clear Salesperson Data Section */}
      <div className="border rounded-md p-4 space-y-3">
        <div className="text-sm font-medium text-gray-700">Clear Salesperson Data</div>
        <div className="text-xs text-gray-500">
          Remove all sales statistics entries for a specific salesperson in this season. This action cannot be undone.
        </div>
        
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <div className="flex-1 max-w-xs">
            <label className="block text-xs text-gray-600 mb-1">Select Salesperson</label>
            <select
              className="w-full rounded border px-2 py-1.5 text-sm"
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
          <button
            onClick={clearSalespersonData}
            disabled={!clearSalespersonId || isClearing}
            className={
              'rounded-md px-4 py-2 text-sm font-medium transition-colors ' +
              (clearSalespersonId && !isClearing
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed')
            }
          >
            {isClearing ? 'Clearing...' : 'Clear Data'}
          </button>
        </div>

        {clearResult && (
          <div className={
            'rounded-md border px-3 py-2 text-sm ' +
            (clearResult.success
              ? 'border-green-200 bg-green-50 text-green-700'
              : 'border-red-200 bg-red-50 text-red-700')
          }>
            {clearResult.message}
          </div>
        )}
      </div>

      {/* Compare Data Section */}
      <div className="border rounded-md p-4 space-y-3">
        <div className="text-sm font-medium text-gray-700">Compare Customer Statistics</div>
        <div className="text-xs text-gray-500">
          Paste tab-separated data from Excel (Name, City, Qty, Price) to compare against existing data for a salesperson.
          <span className="block mt-1 text-amber-600 font-medium">Excel data is the source of truth — use "Fix" buttons to update DB to match.</span>
        </div>
        
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <div className="flex-1 max-w-xs">
            <label className="block text-xs text-gray-600 mb-1">Select Salesperson</label>
            <select
              className="w-full rounded border px-2 py-1.5 text-sm"
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

        <div>
          <label className="block text-xs text-gray-600 mb-1">
            Paste data (tab-separated: Name → City → Qty → Price)
          </label>
          <textarea
            className="w-full rounded border px-2 py-1.5 text-xs font-mono h-32"
            placeholder={"Customer Name\tCity\tQty\tPrice\nAcme Corp\tCopenhagen\t100\t5000\nBest Shop\tOslo\t50\t2500"}
            value={compareInput}
            onChange={(e) => {
              setCompareInput(e.target.value);
              setCompareResults(null);
            }}
          />
        </div>

        <button
          onClick={runComparison}
          disabled={!compareSalespersonId || !compareInput.trim() || isComparing}
          className={
            'rounded-md px-4 py-2 text-sm font-medium transition-colors ' +
            (compareSalespersonId && compareInput.trim() && !isComparing
              ? 'bg-slate-900 text-white hover:bg-slate-800'
              : 'bg-gray-200 text-gray-400 cursor-not-allowed')
          }
        >
          {isComparing ? 'Comparing...' : 'Compare'}
        </button>

        {/* Compare Results */}
        {compareResults && (
          <div className="space-y-3 pt-2">
            {/* Summary */}
            <div className="flex items-center gap-4 text-xs">
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full bg-green-500"></span>
                Matches: {compareResults.matches.length}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500"></span>
                Mismatches: {compareResults.mismatches.length}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span>
                Not in DB: {compareResults.notInDb.length}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full bg-blue-500"></span>
                Not in Excel: {compareResults.notInExcel.length}
              </span>
            </div>

            {/* Fix Result */}
            {fixResult && (
              <div className={
                'rounded-md border px-3 py-2 text-xs ' +
                (fixResult.success
                  ? 'border-green-200 bg-green-50 text-green-700'
                  : 'border-red-200 bg-red-50 text-red-700')
              }>
                {fixResult.message}
              </div>
            )}

            {/* Mismatches - most important */}
            {compareResults.mismatches.length > 0 && (
              <details open className="border rounded-md">
                <summary className="px-3 py-2 bg-red-50 cursor-pointer font-medium text-xs text-red-800 flex items-center justify-between">
                  <span>Mismatches ({compareResults.mismatches.length}) — values differ between Excel and DB</span>
                </summary>
                <div className="px-3 py-2 border-b bg-red-50/50 flex items-center gap-2">
                  <button
                    onClick={fixMismatches}
                    disabled={isFixing}
                    className="rounded-md bg-red-600 text-white px-3 py-1 text-xs hover:bg-red-700 disabled:opacity-50"
                  >
                    {isFixing ? 'Fixing...' : `Fix All (${compareResults.mismatches.length})`}
                  </button>
                  <span className="text-xs text-red-700">Update DB values to match Excel</span>
                </div>
                <div className="max-h-60 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="text-left p-1.5 border-b">Customer</th>
                        <th className="text-left p-1.5 border-b">City</th>
                        <th className="text-right p-1.5 border-b">Excel Qty</th>
                        <th className="text-right p-1.5 border-b">DB Qty</th>
                        <th className="text-right p-1.5 border-b">Diff</th>
                        <th className="text-right p-1.5 border-b">Excel Price</th>
                        <th className="text-right p-1.5 border-b">DB Price</th>
                        <th className="text-right p-1.5 border-b">Diff</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compareResults.mismatches.map((r, i) => (
                        <tr key={i} className="hover:bg-gray-50">
                          <td className="p-1.5 border-b font-medium">{r.name}</td>
                          <td className="p-1.5 border-b">{r.city}</td>
                          <td className="p-1.5 border-b text-right">{r.excelQty}</td>
                          <td className="p-1.5 border-b text-right">{r.dbQty}</td>
                          <td className={`p-1.5 border-b text-right font-mono ${r.qtyDiff !== 0 ? 'text-red-600 font-medium' : ''}`}>
                            {r.qtyDiff > 0 ? '+' : ''}{r.qtyDiff.toFixed(0)}
                          </td>
                          <td className="p-1.5 border-b text-right">{r.excelPrice.toLocaleString()}</td>
                          <td className="p-1.5 border-b text-right">{r.dbPrice.toLocaleString()}</td>
                          <td className={`p-1.5 border-b text-right font-mono ${r.priceDiff !== 0 ? 'text-red-600 font-medium' : ''}`}>
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
              <details className="border rounded-md">
                <summary className="px-3 py-2 bg-amber-50 cursor-pointer font-medium text-xs text-amber-800">
                  Not in DB ({compareResults.notInDb.length}) — in Excel but not found in database
                </summary>
                <div className="px-3 py-2 border-b bg-amber-50/50 flex flex-wrap items-center gap-2">
                  {compareResults.notInDb.filter(e => e.matchedCustomerId).length > 0 && (
                    <>
                      <button
                        onClick={addMissingEntries}
                        disabled={isFixing}
                        className="rounded-md bg-amber-600 text-white px-3 py-1 text-xs hover:bg-amber-700 disabled:opacity-50"
                      >
                        {isFixing ? 'Adding...' : `Add Matched (${compareResults.notInDb.filter(e => e.matchedCustomerId).length})`}
                      </button>
                      <span className="text-xs text-amber-700 mr-4">Add entries with matched customers</span>
                    </>
                  )}
                  {compareResults.notInDb.filter(e => !e.matchedCustomerId).length > 0 && (
                    <>
                      <button
                        onClick={addToOldEntries}
                        disabled={isFixing}
                        className="rounded-md bg-gray-600 text-white px-3 py-1 text-xs hover:bg-gray-700 disabled:opacity-50"
                      >
                        {isFixing ? 'Adding...' : `Add to "Z. ÆLDRE POSTERINGER" (${compareResults.notInDb.filter(e => !e.matchedCustomerId).length})`}
                      </button>
                      <span className="text-xs text-gray-600">Collect unmatched as old entries</span>
                    </>
                  )}
                </div>
                <div className="max-h-48 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="text-left p-1.5 border-b">Customer</th>
                        <th className="text-left p-1.5 border-b">City</th>
                        <th className="text-right p-1.5 border-b">Qty</th>
                        <th className="text-right p-1.5 border-b">Price</th>
                        <th className="text-left p-1.5 border-b">Best Match</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compareResults.notInDb.map((r, i) => (
                        <tr key={i} className={r.matchedCustomerId ? 'bg-green-50 hover:bg-green-100' : 'hover:bg-gray-50'}>
                          <td className="p-1.5 border-b font-medium text-amber-700">{r.name}</td>
                          <td className="p-1.5 border-b">{r.city}</td>
                          <td className="p-1.5 border-b text-right">{r.qty}</td>
                          <td className="p-1.5 border-b text-right">{r.price.toLocaleString()}</td>
                          <td className="p-1.5 border-b">
                            {r.matchedCustomerId ? (
                              <span className="text-green-700">{r.bestMatch} ✓</span>
                            ) : (
                              <span className="text-gray-400">{r.bestMatch || '—'}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}

            {/* Not in Excel */}
            {compareResults.notInExcel.length > 0 && (
              <details className="border rounded-md">
                <summary className="px-3 py-2 bg-blue-50 cursor-pointer font-medium text-xs text-blue-800">
                  Not in Excel ({compareResults.notInExcel.length}) — in DB but not in pasted data
                </summary>
                <div className="max-h-48 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="text-left p-1.5 border-b">Customer</th>
                        <th className="text-left p-1.5 border-b">City</th>
                        <th className="text-right p-1.5 border-b">Qty</th>
                        <th className="text-right p-1.5 border-b">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compareResults.notInExcel.map((r, i) => (
                        <tr key={i} className="hover:bg-gray-50">
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
              <details className="border rounded-md">
                <summary className="px-3 py-2 bg-green-50 cursor-pointer font-medium text-xs text-green-800">
                  Matches ({compareResults.matches.length}) — values match exactly
                </summary>
                <div className="max-h-48 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="text-left p-1.5 border-b">Customer</th>
                        <th className="text-left p-1.5 border-b">City</th>
                        <th className="text-right p-1.5 border-b">Qty</th>
                        <th className="text-right p-1.5 border-b">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compareResults.matches.map((r, i) => (
                        <tr key={i} className="hover:bg-gray-50">
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
      </div>
    </div>
  );
}

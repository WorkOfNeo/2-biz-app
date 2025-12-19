import type { Page } from 'playwright-core';
import type { JobRow } from '@shared/types';
import React from 'react';
import { pdf, Document, Page as PdfPage, Text, StyleSheet, View } from '@react-pdf/renderer';

type Ctx = {
  job: JobRow;
  page: Page;
  log: (jobId: string, level: 'info' | 'error', msg: string, data?: Record<string, any>) => Promise<void>;
  saveResult: (jobId: string, summary: string, data: Record<string, any>) => Promise<any>;
  setJobFailedOrRequeue: (job: JobRow, errorMsg: string) => Promise<void>;
  setJobSucceeded: (jobId: string) => Promise<void>;
  supabase: any;
};

async function ensureBuffer(data: any): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return data as Buffer;
  if (data instanceof Uint8Array) return Buffer.from(data as Uint8Array);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data as ArrayBuffer));
  if (data && typeof (data as any).getReader === 'function') {
    const reader = (data as any).getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks.map((u) => Buffer.from(u)));
  }
  if (data && typeof (data as any).on === 'function') {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      (data as any).on('data', (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      (data as any).on('end', () => resolve());
      (data as any).on('error', (err: any) => reject(err));
    });
    return Buffer.concat(chunks);
  }
  if (typeof data === 'string') return Buffer.from(data as string);
  return Buffer.from([]);
}

function formatPrice(cents: number): string {
  return (cents / 100).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatMonthName(yearMonth: string): string {
  const [year, month] = yearMonth.split('-');
  if (!year || !month) return yearMonth;
  const monthNum = parseInt(month, 10);
  const monthNames = [
    'Januar', 'Februar', 'Marts', 'April', 'Maj', 'Juni',
    'Juli', 'August', 'September', 'Oktober', 'November', 'December'
  ];
  const monthName = monthNames[monthNum - 1] || month;
  return `${monthName} ${year}`;
}

export async function exportSuppleringer(ctx: Ctx) {
  const { job, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, supabase } = ctx;
  const comment = (job.payload as any)?.comment as string | undefined;
  try {
    await log(job.id, 'info', 'STEP:export_suppleringer_begin', job.payload || {});
    
    // Get year_month from payload or use most recent
    let yearMonth = (job.payload as any)?.year_month as string | undefined;
    if (!yearMonth) {
      // Get most recent month
      const { data: recentData } = await supabase
        .from('supp_statistic')
        .select('year_month')
        .order('year_month', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!recentData) {
        await setJobFailedOrRequeue(job, 'No suppleringer data found');
        return;
      }
      yearMonth = recentData.year_month as string;
    }

    await log(job.id, 'info', 'STEP:export_suppleringer_month', { yearMonth });

    // Load current month data (include salesperson_id)
    const { data: currentData } = await supabase
      .from('supp_statistic')
      .select('*, salesperson_id')
      .eq('year_month', yearMonth)
      .order('salesperson_name');

    if (!currentData || currentData.length === 0) {
      await setJobFailedOrRequeue(job, `No data found for ${yearMonth}`);
      return;
    }

    // Load previous year data
    const [yearStr, monthStr] = yearMonth.split('-');
    const year: string = yearStr || '2024';
    const month: string = monthStr || '01';
    const prevYear = String(parseInt(year, 10) - 1);
    const prevYearMonth = `${prevYear}-${month}`;
    
    const { data: prevData } = await supabase
      .from('supp_statistic')
      .select('*, salesperson_id')
      .eq('year_month', prevYearMonth)
      .order('salesperson_name');

    const prevYearMap = new Map<string | null, any>();
    for (const prev of prevData || []) {
      // Map by salesperson_id if available, fallback to name
      const key = prev.salesperson_id || prev.salesperson_name;
      if (key) prevYearMap.set(key, prev);
    }

    // Load individual rows for customer details (include salesperson_id)
    // Supabase has a default limit of 1000 rows, so we need to paginate to get all rows
    const PAGE_SIZE = 1000;
    let currentRows: any[] = [];
    let page = 0;
    let hasMore = true;
    
    while (hasMore) {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      
      const { data: pageData, error: pageError } = await supabase
        .from('supp_statistic_rows')
        .select('*, salesperson_id')
        .eq('year_month', yearMonth)
        .order('salesperson_id, customer_name')
        .range(from, to);
      
      if (pageError) {
        await log(job.id, 'error', 'STEP:export_suppleringer_rows_page_error', { page, error: pageError.message });
        break;
      }
      
      if (pageData && pageData.length > 0) {
        currentRows = [...currentRows, ...pageData];
        hasMore = pageData.length === PAGE_SIZE;
        page++;
      } else {
        hasMore = false;
      }
    }

    await log(job.id, 'info', 'STEP:export_suppleringer_rows_loaded', { 
      rowCount: currentRows.length,
      salespersonCount: currentData.length,
      pagesFetched: page
    });

    // Get ALL unique salesperson IDs from rows (bulletproof - get from DB directly)
    const uniqueSalespersonIdsFromRows = new Set<string>();
    for (const row of currentRows || []) {
      if (row.salesperson_id && typeof row.salesperson_id === 'string') {
        uniqueSalespersonIdsFromRows.add(row.salesperson_id);
      }
    }

    // Query salespersons table to get names and sort_index for all IDs found in rows
    let salespersonIdToName = new Map<string | null, string>();
    let salespersonIdToSortIndex = new Map<string | null, number>();
    if (uniqueSalespersonIdsFromRows.size > 0) {
      const { data: salespersonsData } = await supabase
        .from('salespersons')
        .select('id, name, sort_index')
        .in('id', Array.from(uniqueSalespersonIdsFromRows));
      
      for (const sp of salespersonsData || []) {
        if (sp.id) {
          salespersonIdToName.set(sp.id, sp.name || 'Unknown');
          salespersonIdToSortIndex.set(sp.id, sp.sort_index ?? 999);
        }
      }
    }

    // Also add names from aggregated data (in case some are missing from salespersons table)
    for (const stat of currentData) {
      const spId = stat.salesperson_id || null;
      const spName = stat.salesperson_name || '';
      if (spId && !salespersonIdToName.has(spId)) {
        salespersonIdToName.set(spId, spName);
      }
    }

    // Group rows by salesperson ID (much more reliable than name matching)
    const rowsBySalesperson = new Map<string | null, any[]>();
    const rowsBySalespersonCustomer = new Map<string | null, Map<string, any[]>>();
    
    // Initialize maps for all salespersons in aggregated data
    for (const stat of currentData) {
      const spId = stat.salesperson_id || null;
      if (spId && !rowsBySalespersonCustomer.has(spId)) {
        rowsBySalespersonCustomer.set(spId, new Map());
        rowsBySalesperson.set(spId, []);
      }
    }
    
    // Group customer rows by salesperson ID - BULLETPROOF VERSION
    // Only include rows with valid salesperson_id
    for (const row of currentRows || []) {
      const rowSpId = row.salesperson_id || null;
      const customerName = row.customer_name || '';
      
      if (!customerName) continue; // Skip invalid rows
      
      // Only process rows with a valid salesperson_id
      if (rowSpId && typeof rowSpId === 'string') {
        // Initialize if not already done
        if (!rowsBySalespersonCustomer.has(rowSpId)) {
          rowsBySalespersonCustomer.set(rowSpId, new Map());
          rowsBySalesperson.set(rowSpId, []);
        }
        
        rowsBySalesperson.get(rowSpId)!.push(row);
        
        const customerMap = rowsBySalespersonCustomer.get(rowSpId)!;
        if (!customerMap.has(customerName)) {
          customerMap.set(customerName, []);
        }
        customerMap.get(customerName)!.push(row);
        
        // Ensure name mapping exists (use name from row if not in salespersons table)
        if (!salespersonIdToName.has(rowSpId) && row.salesperson_name) {
          salespersonIdToName.set(rowSpId, row.salesperson_name);
        }
      }
      // Skip rows without salesperson_id (user will handle via historical data page)
    }

    // Log salesperson mapping for debugging
    await log(job.id, 'info', 'STEP:export_suppleringer_salesperson_mapping', {
      salespersonsInData: currentData.map((s: any) => ({ id: s.salesperson_id, name: s.salesperson_name })),
      uniqueIdsFromRows: Array.from(uniqueSalespersonIdsFromRows),
      salespersonsInRows: Array.from(rowsBySalespersonCustomer.keys()),
      rowCountsBySalesperson: Object.fromEntries(
        Array.from(rowsBySalespersonCustomer.entries()).map(([spId, map]) => [spId || 'null', map.size])
      ),
      totalRowsLoaded: currentRows ? currentRows.length : 0,
      totalCustomerMaps: rowsBySalespersonCustomer.size
    });

    const styles = StyleSheet.create({
      page: { paddingTop: 24, paddingBottom: 24, paddingLeft: 120, paddingRight: 120, fontSize: 9, color: '#0f172a' },
      h1: { fontSize: 16, marginBottom: 4, fontWeight: 700 },
      h2: { fontSize: 12, marginBottom: 3, fontWeight: 600 },
      small: { fontSize: 8, color: '#64748b', marginBottom: 4 },
      tableContainer: { marginBottom: 8 }, // Container for tables to prevent page breaks
      tableHeader: { flexDirection: 'row', backgroundColor: '#1d4ed8', color: '#ffffff', borderBottom: 0.5, borderColor: '#bfdbfe' },
      headerCell: { padding: 6, fontSize: 9, fontWeight: 700 },
      row: { flexDirection: 'row', borderBottom: 0.5, borderColor: '#e2e8f0' },
      rowAlt: { backgroundColor: '#f1f5f9' },
      cell: { padding: 6, fontSize: 8 },
      left: { textAlign: 'left' },
      right: { textAlign: 'right' },
      red: { color: '#dc2626' },
      green: { color: '#16a34a' },
      bold: { fontWeight: 700 },
    });

    const Cell = (txt: string, w: string | number, align: 'left' | 'right' = 'left', extra?: any) => 
      React.createElement(Text, { style: [{ width: w }, styles.cell, align === 'left' ? styles.left : styles.right, extra || {}] }, txt);

    const fmt = (n: number) => new Intl.NumberFormat('da-DK').format(Math.round(n));

    // Files to track
    const summaryFiles: Array<{ name: string; path: string; publicUrl: string | null; salesperson_name: string }> = [];
    const customerFiles: Array<{ name: string; path: string; publicUrl: string | null; salesperson_name: string }> = [];
    const allSummaryPages: any[] = [];
    const allCustomerPages: any[] = [];

    // Extract month number from yearMonth for headers (year already extracted above)
    const monthNum = month;
    
    // Generate PDFs per salesperson
    // Include ALL salespersons that have either aggregated data OR rows (by ID)
    const allSalespersonIds = new Set<string | null>();
    
    // Add salespersons from aggregated data
    for (const stat of currentData) {
      const spId = stat.salesperson_id || stat.salesperson_name; // Use ID or fallback to name
      if (spId) allSalespersonIds.add(spId);
    }
    
    // Add salespersons from rows (in case they have rows but no aggregated data)
    for (const spId of rowsBySalespersonCustomer.keys()) {
      if (spId) allSalespersonIds.add(spId);
    }
    
    // Sort salesperson IDs by sort_index (same order as general statistics page)
    const sortedSalespersonIds = Array.from(allSalespersonIds).sort((a, b) => {
      const indexA = salespersonIdToSortIndex.get(a) ?? 999;
      const indexB = salespersonIdToSortIndex.get(b) ?? 999;
      if (indexA !== indexB) return indexA - indexB;
      // Fallback to name alphabetical
      const nameA = salespersonIdToName.get(a) || String(a) || '';
      const nameB = salespersonIdToName.get(b) || String(b) || '';
      return nameA.localeCompare(nameB);
    });

    await log(job.id, 'info', 'STEP:export_suppleringer_salesperson_list', {
      totalSalespersons: sortedSalespersonIds.length,
      fromAggregatedData: currentData.length,
      fromRows: rowsBySalespersonCustomer.size,
      sortedSalespersonIds: sortedSalespersonIds
    });
    
    // Process each salesperson by ID (in sort_index order)
    for (const salespersonId of sortedSalespersonIds) {
      // Find aggregated data for this salesperson by ID
      const stat = currentData.find((s: any) => 
        s.salesperson_id === salespersonId || (!s.salesperson_id && s.salesperson_name === salespersonId)
      );
      
      // Get salesperson name for display
      const salespersonName = stat?.salesperson_name || salespersonIdToName.get(salespersonId) || String(salespersonId || 'Unknown');
      
      // If no aggregated data, create empty structure (will show zero values)
      const aggregatedData = stat || {
        salesperson_id: salespersonId,
        salesperson_name: salespersonName,
        telefon_stk: 0,
        telefon_beløb: 0,
        b2b_stk: 0,
        b2b_beløb: 0,
        krediteret_stk: 0,
        krediteret_beløb: 0,
      };
      
      // Get previous year data by ID (or fallback to name)
      const prev = prevYearMap.get(salespersonId) || (!salespersonId ? null : prevYearMap.get(salespersonName));
      const safeName = salespersonName.replace(/[^a-z0-9_-]+/gi, '_');

      // Calculate values (convert krediteret to negative)
      const current = {
        telefon: { stk: aggregatedData.telefon_stk || 0, beløb: aggregatedData.telefon_beløb || 0 },
        b2bShop: { stk: aggregatedData.b2b_stk || 0, beløb: aggregatedData.b2b_beløb || 0 },
        credittedStk: -(aggregatedData.krediteret_stk || 0),
        credittedBeløb: -(aggregatedData.krediteret_beløb || 0),
        samletStk: (aggregatedData.telefon_stk || 0) + (aggregatedData.b2b_stk || 0) - (aggregatedData.krediteret_stk || 0),
        samletBeløb: (aggregatedData.telefon_beløb || 0) + (aggregatedData.b2b_beløb || 0) - (aggregatedData.krediteret_beløb || 0),
      };

      const previousYear = prev ? {
        telefon: { stk: prev.telefon_stk || 0, beløb: prev.telefon_beløb || 0 },
        b2bShop: { stk: prev.b2b_stk || 0, beløb: prev.b2b_beløb || 0 },
        credittedStk: -(prev.krediteret_stk || 0),
        credittedBeløb: -(prev.krediteret_beløb || 0),
        samletStk: (prev.telefon_stk || 0) + (prev.b2b_stk || 0) - (prev.krediteret_stk || 0),
        samletBeløb: (prev.telefon_beløb || 0) + (prev.b2b_beløb || 0) - (prev.krediteret_beløb || 0),
      } : null;

      const development = prev ? {
        telefon: { stk: (aggregatedData.telefon_stk || 0) - (prev.telefon_stk || 0), beløb: (aggregatedData.telefon_beløb || 0) - (prev.telefon_beløb || 0) },
        b2bShop: { stk: (aggregatedData.b2b_stk || 0) - (prev.b2b_stk || 0), beløb: (aggregatedData.b2b_beløb || 0) - (prev.b2b_beløb || 0) },
        credittedStk: -((aggregatedData.krediteret_stk || 0) - (prev.krediteret_stk || 0)),
        credittedBeløb: -((aggregatedData.krediteret_beløb || 0) - (prev.krediteret_beløb || 0)),
        samletStk: ((aggregatedData.telefon_stk || 0) + (aggregatedData.b2b_stk || 0) - (aggregatedData.krediteret_stk || 0)) - ((prev.telefon_stk || 0) + (prev.b2b_stk || 0) - (prev.krediteret_stk || 0)),
        samletBeløb: ((aggregatedData.telefon_beløb || 0) + (aggregatedData.b2b_beløb || 0) - (aggregatedData.krediteret_beløb || 0)) - ((prev.telefon_beløb || 0) + (prev.b2b_beløb || 0) - (prev.krediteret_beløb || 0)),
      } : null;

      // 1. SUMMARY PDF per salesperson
      const summaryHeader = React.createElement(View, { style: styles.tableHeader },
        Cell('Telefon stk', '12.5%', 'left', styles.headerCell),
        Cell('Telefon beløb', '12.5%', 'right', styles.headerCell),
        Cell('B2B stk', '12.5%', 'left', styles.headerCell),
        Cell('B2B beløb', '12.5%', 'right', styles.headerCell),
        Cell('Krediteret stk', '12.5%', 'left', styles.headerCell),
        Cell('Krediteret beløb', '12.5%', 'right', styles.headerCell),
        Cell('Samlet stk', '12.5%', 'left', styles.headerCell),
        Cell('Samlet beløb', '12.5%', 'right', styles.headerCell)
      );

      const summaryPageElements: any[] = [
        React.createElement(Text, { style: styles.h1, key: 'title' }, `Suppleringer · ${salespersonName}`),
        React.createElement(Text, { style: styles.small, key: 'month' }, formatMonthName(yearMonth)),
      ];

      // Current month section (wrapped to prevent page break)
      summaryPageElements.push(
        React.createElement(View, { wrap: false, style: styles.tableContainer, key: 'current-section' },
          React.createElement(Text, { style: [styles.h2, { marginTop: 8 }] }, formatMonthName(yearMonth)),
          React.createElement(View, { style: styles.tableHeader }, summaryHeader),
          React.createElement(View, { style: styles.row },
            Cell(String(current.telefon.stk), '12.5%', 'left'),
            Cell(formatPrice(current.telefon.beløb), '12.5%', 'right'),
            Cell(String(current.b2bShop.stk), '12.5%', 'left'),
            Cell(formatPrice(current.b2bShop.beløb), '12.5%', 'right'),
            Cell(String(current.credittedStk), '12.5%', 'left', styles.red),
            Cell(formatPrice(current.credittedBeløb), '12.5%', 'right', styles.red),
            Cell(String(current.samletStk), '12.5%', 'left', styles.bold),
            Cell(formatPrice(current.samletBeløb), '12.5%', 'right', styles.bold)
          )
        )
      );

      // Previous year section (if available, wrapped to prevent page break)
      if (previousYear && year) {
        summaryPageElements.push(
          React.createElement(View, { wrap: false, style: styles.tableContainer, key: 'prev-section' },
            React.createElement(Text, { style: [styles.h2, { marginTop: 12 }] }, `${parseInt(year, 10) - 1} (Sidste år)`),
            React.createElement(View, { style: styles.tableHeader }, summaryHeader),
            React.createElement(View, { style: styles.row },
              Cell(String(previousYear.telefon.stk), '12.5%', 'left'),
              Cell(formatPrice(previousYear.telefon.beløb), '12.5%', 'right'),
              Cell(String(previousYear.b2bShop.stk), '12.5%', 'left'),
              Cell(formatPrice(previousYear.b2bShop.beløb), '12.5%', 'right'),
              Cell(String(previousYear.credittedStk), '12.5%', 'left', styles.red),
              Cell(formatPrice(previousYear.credittedBeløb), '12.5%', 'right', styles.red),
              Cell(String(previousYear.samletStk), '12.5%', 'left'),
              Cell(formatPrice(previousYear.samletBeløb), '12.5%', 'right')
            )
          )
        );
      }

      // Development section (if available, wrapped to prevent page break)
      if (development) {
        summaryPageElements.push(
          React.createElement(View, { wrap: false, style: styles.tableContainer, key: 'dev-section' },
            React.createElement(Text, { style: [styles.h2, { marginTop: 12 }] }, 'Samlet Udvikling'),
            React.createElement(View, { style: styles.tableHeader }, summaryHeader),
            React.createElement(View, { style: styles.row },
              Cell((development.telefon.stk >= 0 ? '+' : '') + String(development.telefon.stk), '12.5%', 'left', development.telefon.stk >= 0 ? styles.green : styles.red),
              Cell((development.telefon.beløb >= 0 ? '+' : '') + formatPrice(development.telefon.beløb), '12.5%', 'right', development.telefon.beløb >= 0 ? styles.green : styles.red),
              Cell((development.b2bShop.stk >= 0 ? '+' : '') + String(development.b2bShop.stk), '12.5%', 'left', development.b2bShop.stk >= 0 ? styles.green : styles.red),
              Cell((development.b2bShop.beløb >= 0 ? '+' : '') + formatPrice(development.b2bShop.beløb), '12.5%', 'right', development.b2bShop.beløb >= 0 ? styles.green : styles.red),
              Cell(String(development.credittedStk), '12.5%', 'left', styles.red),
              Cell(formatPrice(development.credittedBeløb), '12.5%', 'right', styles.red),
              Cell((development.samletStk >= 0 ? '+' : '') + String(development.samletStk), '12.5%', 'left', [styles.bold, development.samletStk >= 0 ? styles.green : styles.red]),
              Cell((development.samletBeløb >= 0 ? '+' : '') + formatPrice(development.samletBeløb), '12.5%', 'right', [styles.bold, development.samletBeløb >= 0 ? styles.green : styles.red])
            )
          )
        );
      }

      const summaryPage = React.createElement(PdfPage, { size: 'A4', orientation: 'landscape', style: styles.page },
        ...summaryPageElements
      );

      const summaryDoc = React.createElement(Document, null, summaryPage);
      const summaryPdf = await pdf(summaryDoc).toBuffer();
      const summaryBuf = await ensureBuffer(summaryPdf);
      const summaryPath = `Suppleringer/${job.id}/summary/${safeName}.pdf`;
      
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const ab = summaryBuf.buffer.slice(summaryBuf.byteOffset, summaryBuf.byteOffset + summaryBuf.byteLength);
          await supabase.storage.from('exports').upload(summaryPath, ab as ArrayBuffer, { contentType: 'application/pdf', upsert: true });
          let publicUrl: string | null = null;
          try {
            const { data: pub } = supabase.storage.from('exports').getPublicUrl(summaryPath);
            publicUrl = pub?.publicUrl ?? null;
          } catch {}
          summaryFiles.push({ name: salespersonName, path: summaryPath, publicUrl, salesperson_name: salespersonName });
          allSummaryPages.push(summaryPage);
          break;
        } catch (e: any) {
          if (attempt === 3) {
            await log(job.id, 'error', 'STEP:export_suppleringer_summary_failed', { name: salespersonName, error: e?.message || String(e) });
          }
        }
      }

      let currentIndex = 0;
      for (let i = 0; i < currentData.length; i++) {
        if (currentData[i].salesperson_id === salespersonId || 
            (!currentData[i].salesperson_id && currentData[i].salesperson_name === salespersonId)) {
          currentIndex = i + 1;
          break;
        }
      }
      await log(job.id, 'info', 'STEP:export_suppleringer_progress', { 
        salespersonId: salespersonId,
        salesperson: salespersonName, 
        index: currentIndex, 
        total: currentData.length 
      });

      // 2. CUSTOMER STATS PDF per salesperson
      // Always create customer PDF for ALL salespersons that have data
      // Find matching customer rows by salesperson ID (much more reliable)
      const customerRows = rowsBySalespersonCustomer.get(salespersonId);
      
      await log(job.id, 'info', 'STEP:export_suppleringer_customer_check', { 
        salespersonId: salespersonId,
        salespersonName: salespersonName,
        hasCustomerRows: !!customerRows,
        customerRowCount: customerRows ? customerRows.size : 0,
        totalRowsInDb: currentRows ? currentRows.length : 0
      });
      
      // Always create customer PDF for ALL salespersons (even if no customer rows)
      const customerHeader = React.createElement(View, { style: styles.tableHeader },
        Cell('Kunde', '20%', 'left', styles.headerCell),
        Cell('Telefon stk', '10%', 'left', styles.headerCell),
        Cell('Telefon beløb', '12%', 'right', styles.headerCell),
        Cell('B2B stk', '10%', 'left', styles.headerCell),
        Cell('B2B beløb', '12%', 'right', styles.headerCell),
        Cell('Krediteret stk', '10%', 'left', styles.headerCell),
        Cell('Krediteret beløb', '12%', 'right', styles.headerCell),
        Cell('Samlet stk', '7%', 'left', styles.headerCell),
        Cell('Samlet beløb', '7%', 'right', styles.headerCell)
      );

      const customerBodyRows: any[] = [];
      
      // If customer rows exist, process them; otherwise show empty table
      if (customerRows && customerRows.size > 0) {
        for (const [customerName, rows] of customerRows.entries()) {
          // Aggregate customer rows
          const telefon = { stk: 0, beløb: 0 };
          const b2bShop = { stk: 0, beløb: 0 };
          let credittedStk = 0;
          let credittedBeløb = 0;

          for (const row of rows) {
            if (row.channel === 'Telefon') {
              if (row.qty_ordered > 0) telefon.stk += row.qty_ordered;
              if (row.price > 0) telefon.beløb += row.price;
            } else {
              if (row.qty_ordered > 0) b2bShop.stk += row.qty_ordered;
              if (row.price > 0) b2bShop.beløb += row.price;
            }
            if (row.qty_ordered < 0) credittedStk += row.qty_ordered;
            if (row.price < 0) credittedBeløb += row.price;
          }

          const samletStk = telefon.stk + b2bShop.stk + credittedStk;
          const samletBeløb = telefon.beløb + b2bShop.beløb + credittedBeløb;

          customerBodyRows.push(
            React.createElement(View, { style: [styles.row, customerBodyRows.length % 2 === 1 ? styles.rowAlt : {}] },
              Cell(customerName, '20%', 'left'),
              Cell(String(telefon.stk), '10%', 'left'),
              Cell(formatPrice(telefon.beløb), '12%', 'right'),
              Cell(String(b2bShop.stk), '10%', 'left'),
              Cell(formatPrice(b2bShop.beløb), '12%', 'right'),
              Cell(String(credittedStk), '10%', 'left', styles.red),
              Cell(formatPrice(credittedBeløb), '12%', 'right', styles.red),
              Cell(String(samletStk), '7%', 'left'),
              Cell(formatPrice(samletBeløb), '7%', 'right')
            )
          );
        }
      }
      // If no customer rows, customerBodyRows will be empty (shows empty table)

      const customerPage = React.createElement(PdfPage, { size: 'A4', orientation: 'landscape', style: styles.page },
        React.createElement(Text, { style: styles.h1 }, `Suppleringer · ${salespersonName}`),
        React.createElement(Text, { style: styles.h2 }, 'Kunder'),
        React.createElement(Text, { style: styles.small }, formatMonthName(yearMonth)),
        // Wrap header with first row to prevent orphaned header
        React.createElement(View, { wrap: false },
          customerHeader,
          customerBodyRows[0] || null
        ),
        // Rest of rows flow naturally (each row won't break mid-row due to View structure)
        ...customerBodyRows.slice(1)
      );

      const customerDoc = React.createElement(Document, null, customerPage);
      const customerPdf = await pdf(customerDoc).toBuffer();
      const customerBuf = await ensureBuffer(customerPdf);
      const customerPath = `Suppleringer/${job.id}/customers/${safeName}.pdf`;
      
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const ab = customerBuf.buffer.slice(customerBuf.byteOffset, customerBuf.byteOffset + customerBuf.byteLength);
          await supabase.storage.from('exports').upload(customerPath, ab as ArrayBuffer, { contentType: 'application/pdf', upsert: true });
          let publicUrl: string | null = null;
          try {
            const { data: pub } = supabase.storage.from('exports').getPublicUrl(customerPath);
            publicUrl = pub?.publicUrl ?? null;
          } catch {}
          customerFiles.push({ name: `${salespersonName} · Kunder`, path: customerPath, publicUrl, salesperson_name: salespersonName });
          allCustomerPages.push(customerPage);
          await log(job.id, 'info', 'STEP:export_suppleringer_customer_created', { 
            salesperson: salespersonName,
            customerCount: customerBodyRows.length,
            path: customerPath
          });
          break;
        } catch (e: any) {
          if (attempt === 3) {
            await log(job.id, 'error', 'STEP:export_suppleringer_customers_failed', { name: salespersonName, error: e?.message || String(e) });
          }
        }
      }
    }

    // 3. FULL PAGE PDF (all data combined) - structured by salesperson like frontend
    const fullPageHeader = React.createElement(View, { style: styles.tableHeader },
      Cell('Telefon stk', '12.5%', 'left', styles.headerCell),
      Cell('Telefon beløb', '12.5%', 'right', styles.headerCell),
      Cell('B2B stk', '12.5%', 'left', styles.headerCell),
      Cell('B2B beløb', '12.5%', 'right', styles.headerCell),
      Cell('Krediteret stk', '12.5%', 'left', styles.headerCell),
      Cell('Krediteret beløb', '12.5%', 'right', styles.headerCell),
      Cell('Samlet stk', '12.5%', 'left', styles.headerCell),
      Cell('Samlet beløb', '12.5%', 'right', styles.headerCell)
    );

    const fullPageElements: any[] = [
      React.createElement(Text, { style: styles.h1, key: 'title' }, 'Suppleringer · Samlet Oversigt'),
      React.createElement(Text, { style: styles.small, key: 'month' }, formatMonthName(yearMonth)),
    ];

    // Calculate grand totals across ALL salespersons (will be added at the end)
    const grandTotals = {
      current: { telefon: { stk: 0, beløb: 0 }, b2bShop: { stk: 0, beløb: 0 }, credittedStk: 0, credittedBeløb: 0, samletStk: 0, samletBeløb: 0 },
      previousYear: { telefon: { stk: 0, beløb: 0 }, b2bShop: { stk: 0, beløb: 0 }, credittedStk: 0, credittedBeløb: 0, samletStk: 0, samletBeløb: 0 },
    };
    let hasPreviousYearData = false;

    for (const stat of currentData) {
      grandTotals.current.telefon.stk += stat.telefon_stk || 0;
      grandTotals.current.telefon.beløb += stat.telefon_beløb || 0;
      grandTotals.current.b2bShop.stk += stat.b2b_stk || 0;
      grandTotals.current.b2bShop.beløb += stat.b2b_beløb || 0;
      grandTotals.current.credittedStk += -(stat.krediteret_stk || 0);
      grandTotals.current.credittedBeløb += -(stat.krediteret_beløb || 0);
      grandTotals.current.samletStk += (stat.telefon_stk || 0) + (stat.b2b_stk || 0) - (stat.krediteret_stk || 0);
      grandTotals.current.samletBeløb += (stat.telefon_beløb || 0) + (stat.b2b_beløb || 0) - (stat.krediteret_beløb || 0);
    }

    for (const prev of prevData || []) {
      hasPreviousYearData = true;
      grandTotals.previousYear.telefon.stk += prev.telefon_stk || 0;
      grandTotals.previousYear.telefon.beløb += prev.telefon_beløb || 0;
      grandTotals.previousYear.b2bShop.stk += prev.b2b_stk || 0;
      grandTotals.previousYear.b2bShop.beløb += prev.b2b_beløb || 0;
      grandTotals.previousYear.credittedStk += -(prev.krediteret_stk || 0);
      grandTotals.previousYear.credittedBeløb += -(prev.krediteret_beløb || 0);
      grandTotals.previousYear.samletStk += (prev.telefon_stk || 0) + (prev.b2b_stk || 0) - (prev.krediteret_stk || 0);
      grandTotals.previousYear.samletBeløb += (prev.telefon_beløb || 0) + (prev.b2b_beløb || 0) - (prev.krediteret_beløb || 0);
    }

    const grandDevelopment = hasPreviousYearData ? {
      telefon: { stk: grandTotals.current.telefon.stk - grandTotals.previousYear.telefon.stk, beløb: grandTotals.current.telefon.beløb - grandTotals.previousYear.telefon.beløb },
      b2bShop: { stk: grandTotals.current.b2bShop.stk - grandTotals.previousYear.b2bShop.stk, beløb: grandTotals.current.b2bShop.beløb - grandTotals.previousYear.b2bShop.beløb },
      credittedStk: grandTotals.current.credittedStk - grandTotals.previousYear.credittedStk,
      credittedBeløb: grandTotals.current.credittedBeløb - grandTotals.previousYear.credittedBeløb,
      samletStk: grandTotals.current.samletStk - grandTotals.previousYear.samletStk,
      samletBeløb: grandTotals.current.samletBeløb - grandTotals.previousYear.samletBeløb,
    } : null;

    // Start with individual salesperson sections header
    fullPageElements.push(
      React.createElement(Text, { style: [styles.h2, { marginTop: 12, fontSize: 14, fontWeight: 700 }], key: 'individual-title' }, 'Pr. Sælger')
    );

    // Loop through all salespersons (sorted by sort_index) and create a section for each
    for (const salespersonId of sortedSalespersonIds) {
      // Find aggregated data for this salesperson by ID
      const stat = currentData.find((s: any) => 
        s.salesperson_id === salespersonId || (!s.salesperson_id && s.salesperson_name === salespersonId)
      );
      
      // Get salesperson name for display
      const salespersonName = stat?.salesperson_name || salespersonIdToName.get(salespersonId) || String(salespersonId || 'Unknown');
      
      // If no aggregated data, create empty structure
      const aggregatedData = stat || {
        salesperson_id: salespersonId,
        salesperson_name: salespersonName,
        telefon_stk: 0,
        telefon_beløb: 0,
        b2b_stk: 0,
        b2b_beløb: 0,
        krediteret_stk: 0,
        krediteret_beløb: 0,
      };
      
      // Get previous year data by ID (or fallback to name)
      const prev = prevYearMap.get(salespersonId) || (!salespersonId ? null : prevYearMap.get(salespersonName));
      
      // Salesperson name as section header
      fullPageElements.push(
        React.createElement(Text, { style: [styles.h2, { marginTop: 16 }], key: `sp-title-${salespersonName}` }, salespersonName)
      );

      // Calculate values
      const current = {
        telefon: { stk: aggregatedData.telefon_stk || 0, beløb: aggregatedData.telefon_beløb || 0 },
        b2bShop: { stk: aggregatedData.b2b_stk || 0, beløb: aggregatedData.b2b_beløb || 0 },
        credittedStk: -(aggregatedData.krediteret_stk || 0),
        credittedBeløb: -(aggregatedData.krediteret_beløb || 0),
        samletStk: (aggregatedData.telefon_stk || 0) + (aggregatedData.b2b_stk || 0) - (aggregatedData.krediteret_stk || 0),
        samletBeløb: (aggregatedData.telefon_beløb || 0) + (aggregatedData.b2b_beløb || 0) - (aggregatedData.krediteret_beløb || 0),
      };

      const previousYear = prev ? {
        telefon: { stk: prev.telefon_stk || 0, beløb: prev.telefon_beløb || 0 },
        b2bShop: { stk: prev.b2b_stk || 0, beløb: prev.b2b_beløb || 0 },
        credittedStk: -(prev.krediteret_stk || 0),
        credittedBeløb: -(prev.krediteret_beløb || 0),
        samletStk: (prev.telefon_stk || 0) + (prev.b2b_stk || 0) - (prev.krediteret_stk || 0),
        samletBeløb: (prev.telefon_beløb || 0) + (prev.b2b_beløb || 0) - (prev.krediteret_beløb || 0),
      } : null;

      const development = prev ? {
        telefon: { stk: (aggregatedData.telefon_stk || 0) - (prev.telefon_stk || 0), beløb: (aggregatedData.telefon_beløb || 0) - (prev.telefon_beløb || 0) },
        b2bShop: { stk: (aggregatedData.b2b_stk || 0) - (prev.b2b_stk || 0), beløb: (aggregatedData.b2b_beløb || 0) - (prev.b2b_beløb || 0) },
        credittedStk: -((aggregatedData.krediteret_stk || 0) - (prev.krediteret_stk || 0)),
        credittedBeløb: -((aggregatedData.krediteret_beløb || 0) - (prev.krediteret_beløb || 0)),
        samletStk: ((aggregatedData.telefon_stk || 0) + (aggregatedData.b2b_stk || 0) - (aggregatedData.krediteret_stk || 0)) - ((prev.telefon_stk || 0) + (prev.b2b_stk || 0) - (prev.krediteret_stk || 0)),
        samletBeløb: ((aggregatedData.telefon_beløb || 0) + (aggregatedData.b2b_beløb || 0) - (aggregatedData.krediteret_beløb || 0)) - ((prev.telefon_beløb || 0) + (prev.b2b_beløb || 0) - (prev.krediteret_beløb || 0)),
      } : null;

      // Previous Year subsection (wrapped to prevent page break)
      if (previousYear) {
        fullPageElements.push(
          React.createElement(View, { wrap: false, style: styles.tableContainer, key: `prev-section-${salespersonName}` },
            React.createElement(Text, { style: [styles.h2, { marginTop: 8, fontSize: 11 }] }, `${parseInt(year, 10) - 1} (Sidste år)`),
            React.createElement(View, { style: styles.tableHeader }, fullPageHeader),
            React.createElement(View, { style: styles.row },
              Cell(String(previousYear.telefon.stk), '12.5%', 'left'),
              Cell(formatPrice(previousYear.telefon.beløb), '12.5%', 'right'),
              Cell(String(previousYear.b2bShop.stk), '12.5%', 'left'),
              Cell(formatPrice(previousYear.b2bShop.beløb), '12.5%', 'right'),
              Cell(String(previousYear.credittedStk), '12.5%', 'left', styles.red),
              Cell(formatPrice(previousYear.credittedBeløb), '12.5%', 'right', styles.red),
              Cell(String(previousYear.samletStk), '12.5%', 'left'),
              Cell(formatPrice(previousYear.samletBeløb), '12.5%', 'right')
            )
          )
        );
      }

      // Current Month subsection (wrapped to prevent page break)
      fullPageElements.push(
        React.createElement(View, { wrap: false, style: styles.tableContainer, key: `current-section-${salespersonName}` },
          React.createElement(Text, { style: [styles.h2, { marginTop: 8, fontSize: 11 }] }, formatMonthName(yearMonth)),
          React.createElement(View, { style: styles.tableHeader }, fullPageHeader),
          React.createElement(View, { style: styles.row },
            Cell(String(current.telefon.stk), '12.5%', 'left'),
            Cell(formatPrice(current.telefon.beløb), '12.5%', 'right'),
            Cell(String(current.b2bShop.stk), '12.5%', 'left'),
            Cell(formatPrice(current.b2bShop.beløb), '12.5%', 'right'),
            Cell(String(current.credittedStk), '12.5%', 'left', styles.red),
            Cell(formatPrice(current.credittedBeløb), '12.5%', 'right', styles.red),
            Cell(String(current.samletStk), '12.5%', 'left', styles.bold),
            Cell(formatPrice(current.samletBeløb), '12.5%', 'right', styles.bold)
          )
        )
      );

      // Development/Difference subsection (wrapped to prevent page break)
      if (development) {
        fullPageElements.push(
          React.createElement(View, { wrap: false, style: styles.tableContainer, key: `dev-section-${salespersonName}` },
            React.createElement(Text, { style: [styles.h2, { marginTop: 8, fontSize: 11 }] }, 'Udvikling'),
            React.createElement(View, { style: styles.tableHeader }, fullPageHeader),
            React.createElement(View, { style: styles.row },
              Cell((development.telefon.stk >= 0 ? '+' : '') + String(development.telefon.stk), '12.5%', 'left', development.telefon.stk >= 0 ? styles.green : styles.red),
              Cell((development.telefon.beløb >= 0 ? '+' : '') + formatPrice(development.telefon.beløb), '12.5%', 'right', development.telefon.beløb >= 0 ? styles.green : styles.red),
              Cell((development.b2bShop.stk >= 0 ? '+' : '') + String(development.b2bShop.stk), '12.5%', 'left', development.b2bShop.stk >= 0 ? styles.green : styles.red),
              Cell((development.b2bShop.beløb >= 0 ? '+' : '') + formatPrice(development.b2bShop.beløb), '12.5%', 'right', development.b2bShop.beløb >= 0 ? styles.green : styles.red),
              Cell(String(development.credittedStk), '12.5%', 'left', styles.red),
              Cell(formatPrice(development.credittedBeløb), '12.5%', 'right', styles.red),
              Cell((development.samletStk >= 0 ? '+' : '') + String(development.samletStk), '12.5%', 'left', [styles.bold, development.samletStk >= 0 ? styles.green : styles.red]),
              Cell((development.samletBeløb >= 0 ? '+' : '') + formatPrice(development.samletBeløb), '12.5%', 'right', [styles.bold, development.samletBeløb >= 0 ? styles.green : styles.red])
            )
          )
        );
      }
    }

    // Add GRAND TOTALS section at the BOTTOM (after all individual salespersons)
    fullPageElements.push(
      React.createElement(View, { style: { marginTop: 24, marginBottom: 8, borderTop: 2, borderColor: '#1d4ed8' }, key: 'separator' })
    );
    fullPageElements.push(
      React.createElement(Text, { style: [styles.h2, { marginTop: 12, fontSize: 14, fontWeight: 700 }], key: 'grand-title' }, 'SAMLET (Alle Sælgere)')
    );

    // Grand totals: Previous Year (wrapped to prevent page break)
    if (hasPreviousYearData) {
      fullPageElements.push(
        React.createElement(View, { wrap: false, style: styles.tableContainer, key: 'grand-prev-section' },
          React.createElement(Text, { style: [styles.h2, { marginTop: 8, fontSize: 11 }] }, `${parseInt(year, 10) - 1} (Sidste år)`),
          React.createElement(View, { style: styles.tableHeader }, fullPageHeader),
          React.createElement(View, { style: styles.row },
            Cell(String(grandTotals.previousYear.telefon.stk), '12.5%', 'left'),
            Cell(formatPrice(grandTotals.previousYear.telefon.beløb), '12.5%', 'right'),
            Cell(String(grandTotals.previousYear.b2bShop.stk), '12.5%', 'left'),
            Cell(formatPrice(grandTotals.previousYear.b2bShop.beløb), '12.5%', 'right'),
            Cell(String(grandTotals.previousYear.credittedStk), '12.5%', 'left', styles.red),
            Cell(formatPrice(grandTotals.previousYear.credittedBeløb), '12.5%', 'right', styles.red),
            Cell(String(grandTotals.previousYear.samletStk), '12.5%', 'left', styles.bold),
            Cell(formatPrice(grandTotals.previousYear.samletBeløb), '12.5%', 'right', styles.bold)
          )
        )
      );
    }

    // Grand totals: Current Month (wrapped to prevent page break)
    fullPageElements.push(
      React.createElement(View, { wrap: false, style: styles.tableContainer, key: 'grand-current-section' },
        React.createElement(Text, { style: [styles.h2, { marginTop: 8, fontSize: 11 }] }, formatMonthName(yearMonth)),
        React.createElement(View, { style: styles.tableHeader }, fullPageHeader),
        React.createElement(View, { style: styles.row },
          Cell(String(grandTotals.current.telefon.stk), '12.5%', 'left'),
          Cell(formatPrice(grandTotals.current.telefon.beløb), '12.5%', 'right'),
          Cell(String(grandTotals.current.b2bShop.stk), '12.5%', 'left'),
          Cell(formatPrice(grandTotals.current.b2bShop.beløb), '12.5%', 'right'),
          Cell(String(grandTotals.current.credittedStk), '12.5%', 'left', styles.red),
          Cell(formatPrice(grandTotals.current.credittedBeløb), '12.5%', 'right', styles.red),
          Cell(String(grandTotals.current.samletStk), '12.5%', 'left', styles.bold),
          Cell(formatPrice(grandTotals.current.samletBeløb), '12.5%', 'right', styles.bold)
        )
      )
    );

    // Grand totals: Development (wrapped to prevent page break)
    if (grandDevelopment) {
      fullPageElements.push(
        React.createElement(View, { wrap: false, style: styles.tableContainer, key: 'grand-dev-section' },
          React.createElement(Text, { style: [styles.h2, { marginTop: 8, fontSize: 11 }] }, 'Samlet Udvikling'),
          React.createElement(View, { style: styles.tableHeader }, fullPageHeader),
          React.createElement(View, { style: styles.row },
            Cell((grandDevelopment.telefon.stk >= 0 ? '+' : '') + String(grandDevelopment.telefon.stk), '12.5%', 'left', grandDevelopment.telefon.stk >= 0 ? styles.green : styles.red),
            Cell((grandDevelopment.telefon.beløb >= 0 ? '+' : '') + formatPrice(grandDevelopment.telefon.beløb), '12.5%', 'right', grandDevelopment.telefon.beløb >= 0 ? styles.green : styles.red),
            Cell((grandDevelopment.b2bShop.stk >= 0 ? '+' : '') + String(grandDevelopment.b2bShop.stk), '12.5%', 'left', grandDevelopment.b2bShop.stk >= 0 ? styles.green : styles.red),
            Cell((grandDevelopment.b2bShop.beløb >= 0 ? '+' : '') + formatPrice(grandDevelopment.b2bShop.beløb), '12.5%', 'right', grandDevelopment.b2bShop.beløb >= 0 ? styles.green : styles.red),
            Cell(String(grandDevelopment.credittedStk), '12.5%', 'left', styles.red),
            Cell(formatPrice(grandDevelopment.credittedBeløb), '12.5%', 'right', styles.red),
            Cell((grandDevelopment.samletStk >= 0 ? '+' : '') + String(grandDevelopment.samletStk), '12.5%', 'left', [styles.bold, grandDevelopment.samletStk >= 0 ? styles.green : styles.red]),
            Cell((grandDevelopment.samletBeløb >= 0 ? '+' : '') + formatPrice(grandDevelopment.samletBeløb), '12.5%', 'right', [styles.bold, grandDevelopment.samletBeløb >= 0 ? styles.green : styles.red])
          )
        )
      );
    }

    const fullPage = React.createElement(PdfPage, { size: 'A4', orientation: 'landscape', style: styles.page },
      ...fullPageElements
    );

    const fullPageDoc = React.createElement(Document, null, fullPage);
    const fullPagePdf = await pdf(fullPageDoc).toBuffer();
    const fullPageBuf = await ensureBuffer(fullPagePdf);
    const fullPagePath = `Suppleringer/${job.id}/full/all.pdf`;
    
    let fullPagePublicUrl: string | null = null;
    try {
      const ab = fullPageBuf.buffer.slice(fullPageBuf.byteOffset, fullPageBuf.byteOffset + fullPageBuf.byteLength);
      await supabase.storage.from('exports').upload(fullPagePath, ab as ArrayBuffer, { contentType: 'application/pdf', upsert: true });
      try {
        const { data: pub } = supabase.storage.from('exports').getPublicUrl(fullPagePath);
        fullPagePublicUrl = pub?.publicUrl ?? null;
      } catch {}
    } catch (e: any) {
      await log(job.id, 'error', 'STEP:export_suppleringer_full_failed', { error: e?.message || String(e) });
    }

    // Save export records
    const allFiles = [...summaryFiles, ...customerFiles];
    
    await log(job.id, 'info', 'STEP:export_suppleringer_files_created', { 
      summaryFiles: summaryFiles.length, 
      customerFiles: customerFiles.length,
      currentDataCount: currentData.length
    });
    
    // Save summary PDFs export record
    if (summaryFiles.length > 0) {
      const allSummaryDoc = React.createElement(Document, null, ...allSummaryPages);
      const allSummaryPdf = await pdf(allSummaryDoc).toBuffer();
      const allSummaryBuf = await ensureBuffer(allSummaryPdf);
      const allSummaryPath = `Suppleringer/${job.id}/summary/all.pdf`;
      let allSummaryPublicUrl: string | null = null;
      
      try {
        const ab = allSummaryBuf.buffer.slice(allSummaryBuf.byteOffset, allSummaryBuf.byteOffset + allSummaryBuf.byteLength);
        await supabase.storage.from('exports').upload(allSummaryPath, ab as ArrayBuffer, { contentType: 'application/pdf', upsert: true });
        try {
          const { data: pub } = supabase.storage.from('exports').getPublicUrl(allSummaryPath);
          allSummaryPublicUrl = pub?.publicUrl ?? null;
        } catch {}
      } catch {}

      try {
        await supabase.from('exports').insert({
          kind: 'suppleringer_summary_pdfs',
          title: `Suppleringer · Summary · ${formatMonthName(yearMonth)}`,
          path: `Suppleringer/${job.id}/summary/`,
          public_url: null,
          job_id: job.id,
          comment: comment || null,
          meta: { 
            files: summaryFiles.map(f => ({ name: f.name, path: f.path, publicUrl: f.publicUrl })),
            all: { path: allSummaryPath, publicUrl: allSummaryPublicUrl },
            year_month: yearMonth
          }
        });
      } catch {}
    }

    // Save customer PDFs export record
    if (customerFiles.length > 0) {
      const allCustomerDoc = React.createElement(Document, null, ...allCustomerPages);
      const allCustomerPdf = await pdf(allCustomerDoc).toBuffer();
      const allCustomerBuf = await ensureBuffer(allCustomerPdf);
      const allCustomerPath = `Suppleringer/${job.id}/customers/all.pdf`;
      let allCustomerPublicUrl: string | null = null;
      
      try {
        const ab = allCustomerBuf.buffer.slice(allCustomerBuf.byteOffset, allCustomerBuf.byteOffset + allCustomerBuf.byteLength);
        await supabase.storage.from('exports').upload(allCustomerPath, ab as ArrayBuffer, { contentType: 'application/pdf', upsert: true });
        try {
          const { data: pub } = supabase.storage.from('exports').getPublicUrl(allCustomerPath);
          allCustomerPublicUrl = pub?.publicUrl ?? null;
        } catch {}
      } catch {}

      try {
        await supabase.from('exports').insert({
          kind: 'suppleringer_customer_pdfs',
          title: `Suppleringer · Customer Stats · ${formatMonthName(yearMonth)}`,
          path: `Suppleringer/${job.id}/customers/`,
          public_url: null,
          job_id: job.id,
          comment: comment || null,
          meta: { 
            files: customerFiles.map(f => ({ name: f.name, path: f.path, publicUrl: f.publicUrl })),
            all: { path: allCustomerPath, publicUrl: allCustomerPublicUrl },
            year_month: yearMonth
          }
        });
      } catch {}
    }

    // Save full page export record
    try {
      await supabase.from('exports').insert({
        kind: 'suppleringer_full_pdf',
        title: `Suppleringer · Full Page · ${formatMonthName(yearMonth)}`,
        path: fullPagePath,
        public_url: fullPagePublicUrl,
        job_id: job.id,
        comment: comment || null,
        meta: { year_month: yearMonth }
      });
    } catch {}

    await log(job.id, 'info', 'STEP:complete', { 
      summaryFiles: summaryFiles.length, 
      customerFiles: customerFiles.length,
      yearMonth 
    });
    await saveResult(job.id, 'export_suppleringer_done', { 
      summaryFiles: summaryFiles.length, 
      customerFiles: customerFiles.length,
      yearMonth 
    });
    await setJobSucceeded(job.id);
  } catch (e: any) {
    await setJobFailedOrRequeue(job, e?.message || String(e));
  }
}


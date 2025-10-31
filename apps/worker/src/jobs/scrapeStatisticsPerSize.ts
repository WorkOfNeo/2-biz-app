import type { Page } from 'playwright-core';
import type { JobRow } from '@shared/types';

type Ctx = {
  job: JobRow;
  page: Page;
  log: (jobId: string, level: 'info' | 'error', msg: string, data?: Record<string, any>) => Promise<void>;
  saveResult: (jobId: string, summary: string, data: Record<string, any>) => Promise<any>;
  setJobFailedOrRequeue: (job: JobRow, errorMsg: string) => Promise<void>;
  setJobSucceeded: (jobId: string) => Promise<void>;
  ensureNotCancelled: (jobId: string) => Promise<void>;
  captureHtmlSnippet: (target: any, fallbackPage: Page) => Promise<string>;
  supabase: any;
  SPY_BASE_URL: string;
};

export async function scrapeStatisticsPerSize(ctx: Ctx) {
  const { job, page, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, captureHtmlSnippet, supabase, SPY_BASE_URL } = ctx;
  try {
    await ensureNotCancelled(job.id);
    await log(job.id, 'info', 'STEP:stats_per_size_begin', job.payload || {});
    // Build force-search URL with ISO dates (YYYY-MM-DD); allow override via payload.dateFrom/dateTo
    const isoDate = (job.payload?.dateFrom as string | undefined) || new Date().toISOString().slice(0, 10);
    const isoDateTo = (job.payload?.dateTo as string | undefined) || isoDate;
    const urlObj = new URL('?controller=Confident%5CMiscellaneous%5CStatisticsPerSize&action=List', SPY_BASE_URL);
    urlObj.searchParams.set('Spy\\Model\\Confident\\Miscellaneous\\StatisticsPerSize\\ListReportSearch[bForceSearch]', 'true');
    urlObj.searchParams.set('Spy\\Model\\Confident\\Miscellaneous\\StatisticsPerSize\\ListReportSearch[strDateFrom]', isoDate);
    urlObj.searchParams.set('Spy\\Model\\Confident\\Miscellaneous\\StatisticsPerSize\\ListReportSearch[strDateTo]', isoDateTo);
    const forceUrl = urlObj.toString();
    await page.goto(forceUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await log(job.id, 'info', 'STEP:stats_per_size_nav', { url: forceUrl, dateFrom: isoDate, dateTo: isoDateTo });

    // Wait for container
    await page.waitForSelector('#StatisticsPerSizeTableContainer', { timeout: 180_000, state: 'attached' as any }).catch(() => null);
    // Poll for tables for up to ~3 minutes (36 attempts * 5s)
    let tablesFound = 0;
    for (let attempt = 1; attempt <= 36; attempt++) {
      await ensureNotCancelled(job.id);
      try { tablesFound = await page.$$eval('#StatisticsPerSizeTableContainer table.standardList', (els) => els.length); } catch { tablesFound = 0; }
      await log(job.id, 'info', 'STEP:stats_per_size_poll', { attempt, tablesFound });
      if (tablesFound > 0) break;
      await page.waitForTimeout(5000);
    }
    if (tablesFound === 0) {
      const html = await captureHtmlSnippet(page, page);
      await log(job.id, 'error', 'STEP:stats_per_size_no_tables', { html });
      throw new Error('Statistics per size tables did not appear in time');
    }
    await log(job.id, 'info', 'STEP:stats_per_size_tables_found', { tablesFound });

    // Capture raw HTML of each table and parse rows
    const parsed = await page.$$eval('#StatisticsPerSizeTableContainer table.standardList', (tables) => {
      function tx(el?: Element | null): string { return ((el as HTMLElement | null)?.textContent || '').replace(/\s+/g, ' ').trim(); }
      function toNum(s: string): number { const n = Number(s.replace(/[^0-9\-]/g, '')); return isFinite(n) ? n : 0; }
      const out: Array<{ table_html: string; headers: string[]; rows: any[] }> = [];
      for (const tbl of Array.from(tables) as HTMLTableElement[]) {
        const html = (tbl.outerHTML || '').toString();
        const headRows = Array.from((tbl.querySelector('thead') || tbl).querySelectorAll('tr')) as HTMLTableRowElement[];
        const header2 = headRows[1] || headRows[0];
        const ths = Array.from(header2?.querySelectorAll('th') || []) as HTMLElement[];
        const headers = ths.map((th) => tx(th));
        // Map indices
        const idxStyleNo = headers.findIndex((h) => /Style\s*No\.?/i.test(h));
        const idxStyleName = headers.findIndex((h) => /Style\s*Name/i.test(h));
        const idxType = headers.findIndex((h) => /^Type$/i.test(h));
        const idxTotal = headers.findIndex((h) => /^Total$/i.test(h));
        const idxMinCol = headers.findIndex((h) => /Min\.\s*col/i.test(h));
        const idxDiff = headers.findIndex((h) => /^Diff$/i.test(h));
        const sizeStart = idxType >= 0 ? idxType + 1 : 4;
        const sizeEnd = idxTotal > sizeStart ? idxTotal : ths.length - 3;
        const sizeIndices: number[] = [];
        const sizeLabels: string[] = [];
        for (let i = sizeStart; i < sizeEnd; i++) { sizeIndices.push(i); sizeLabels.push(headers[i] || ''); }
        const bodyRows = Array.from(tbl.querySelectorAll('tbody tr')) as HTMLTableRowElement[];
        const rows: any[] = [];
        for (const tr of bodyRows) {
          const tds = Array.from(tr.querySelectorAll('td')) as HTMLElement[];
          if (tds.length === 0) continue;
          const styleCell = tds[idxStyleNo] || tds[1];
          const styleCellText = (styleCell?.innerHTML || styleCell?.textContent || '').toString();
          const parts = styleCellText
            .replace(/<br\s*\/?>(?=\S)/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .split(/\n+/);
          const style_no = (parts[0] || '').trim();
          const color = (parts[1] || '').trim();
          const style_name = tx(tds[idxStyleName] || tds[2] || null) || null;
          const type = tx(tds[idxType] || tds[3] || null) || null;
          const values = sizeIndices.map((i) => toNum(tx(tds[i] || null)));
          const total = idxTotal >= 0 ? toNum(tx(tds[idxTotal] || null)) : values.reduce((a, b) => a + b, 0);
          const min_col = idxMinCol >= 0 ? toNum(tx(tds[idxMinCol] || null)) : 0;
          const diff = idxDiff >= 0 ? toNum(tx(tds[idxDiff] || null)) : 0;
          if (style_no) rows.push({ style_no, color, style_name, type, sizes: sizeLabels, values, total, min_col, diff });
        }
        out.push({ table_html: html, headers: sizeLabels, rows });
      }
      return out;
    });
    const flatRows = parsed.flatMap((p) => p.rows);
    await log(job.id, 'info', 'STEP:stats_per_size_parsed', { tables: parsed.length, rows: flatRows.length, sampleHeaders: (parsed[0]?.headers || []).slice(0, 10) });
    // Insert or update snapshot and rows (idempotent per day)
    const snapDate = isoDate; // snapshot keyed by from-date
    const { data: existingSnap } = await supabase
      .from('statistics_per_size_snapshots')
      .select('id')
      .eq('date_from', snapDate)
      .maybeSingle();
    let snapshot_id: string | null = existingSnap?.id || null;
    if (snapshot_id) {
      await log(job.id, 'info', 'STEP:stats_per_size_existing_snapshot', { snapshot_id, date_from: snapDate });
      // Clean old rows, update snapshot metadata
      await supabase.from('statistics_per_size_rows').delete().eq('snapshot_id', snapshot_id);
      await supabase
        .from('statistics_per_size_snapshots')
        .update({ rows_count: flatRows.length, raw_tables_html: parsed.map((p: any) => p.table_html), scraped_at: new Date().toISOString() })
        .eq('id', snapshot_id);
    } else {
      const { data: snap, error: snapErr } = await supabase
        .from('statistics_per_size_snapshots')
        .insert({ date_from: snapDate, raw_tables_html: parsed.map((p: any) => p.table_html), scraped_at: new Date().toISOString(), rows_count: flatRows.length })
        .select('id')
        .single();
      if (snapErr) throw snapErr;
      snapshot_id = (snap as any).id as string;
      await log(job.id, 'info', 'STEP:stats_per_size_snapshot_created', { snapshot_id, date_from: snapDate });
    }
    const totalBatches = Math.ceil(flatRows.length / 1000) || 1;
    for (let i = 0; i < flatRows.length; i += 1000) {
      const batchIndex = Math.floor(i / 1000) + 1;
      const batch = flatRows.slice(i, i + 1000).map((r) => ({ ...r, snapshot_id }));
      const { error: rowsErr } = await supabase.from('statistics_per_size_rows').insert(batch as any);
      if (rowsErr) throw rowsErr;
      await log(job.id, 'info', 'STEP:stats_per_size_batch_insert', { batchIndex, totalBatches, count: batch.length });
    }
    await saveResult(job.id, 'Statistics per size snapshot', { snapshot_id, rows: flatRows.length });
    await setJobSucceeded(job.id);
    await log(job.id, 'info', 'STEP:complete', { snapshot_id, rows: flatRows.length });
    return;
  } catch (e: any) {
    await setJobFailedOrRequeue(job, e?.message || String(e));
    return;
  }
}



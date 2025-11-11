import type { JobRow } from '@shared/types';

type Ctx = {
  job: JobRow;
  log: (jobId: string, level: 'info' | 'error', msg: string, data?: Record<string, any>) => Promise<void>;
  saveResult: (jobId: string, summary: string, data: Record<string, any>) => Promise<any>;
  ensureNotCancelled: (jobId: string) => Promise<void>;
  supabase: any;
};

export async function fixInvoices(ctx: Ctx) {
  const { job, log, saveResult, ensureNotCancelled, supabase } = ctx;
  await ensureNotCancelled(job.id);
  await log(job.id, 'info', 'STEP:fix_invoices_begin');
  const dryRun = Boolean((job.payload as any)?.dryRun);

  // Load seasons with date ranges
  const { data: seasons, error: seasErr } = await supabase
    .from('seasons')
    .select('id, name, year, start_date, end_date')
    .order('start_date', { ascending: true });
  if (seasErr) throw seasErr;
  const list = (seasons ?? []) as Array<{ id: string; name?: string | null; year?: number | null; start_date?: string | null; end_date?: string | null }>;

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  const samples: Array<{ invoice_no: string; from?: string; to?: string; date?: string }> = [];

  for (const s of list) {
    await ensureNotCancelled(job.id);
    const start = s.start_date ? new Date(s.start_date) : null;
    const end = s.end_date ? new Date(s.end_date) : null;
    if (!start || !end) {
      await log(job.id, 'info', 'STEP:fix_invoices_skip_season_no_dates', { id: s.id });
      continue;
    }
    await log(job.id, 'info', 'STEP:fix_invoices_scan_season', { id: s.id, name: s.name, year: s.year });
    // Fetch candidate invoices that fall into this season by date but are assigned to a different season
    const { data: invs, error: invErr } = await supabase
      .from('sales_invoices')
      .select('id, season_id, invoice_no, account_no, invoice_date')
      .neq('season_id', s.id)
      .limit(50000);
    if (invErr) throw invErr;
    const rows = (invs ?? []) as Array<{ id: string; season_id: string; invoice_no: string; account_no: string; invoice_date: string | null }>;
    const toUpdate: Array<{ id: string; newSeason: string; invoice_no: string; account_no: string }> = [];
    for (const r of rows) {
      scanned++;
      const d = r.invoice_date ? new Date(r.invoice_date) : null;
      if (!d) { skipped++; continue; }
      if (d >= start && d <= end) {
        toUpdate.push({ id: r.id, newSeason: s.id, invoice_no: r.invoice_no, account_no: r.account_no });
      } else {
        skipped++;
      }
    }
    await log(job.id, 'info', 'STEP:fix_invoices_candidates', { season_id: s.id, candidates: toUpdate.length });
    if (!dryRun) {
      // Apply updates one by one to handle unique constraint and conflicts
      for (const u of toUpdate) {
        try {
          // Try updating season_id; may conflict if the target row exists already
          const { error: upErr } = await supabase
            .from('sales_invoices')
            .update({ season_id: s.id })
            .eq('id', u.id);
          if (upErr) {
            // Conflict fallback: see if a row with target season/account/invoice exists; if yes, delete current
            const { data: exists } = await supabase
              .from('sales_invoices')
              .select('id')
              .eq('season_id', s.id)
              .eq('invoice_no', u.invoice_no)
              .eq('account_no', u.account_no)
              .maybeSingle();
            if (exists?.id) {
              await supabase.from('sales_invoices').delete().eq('id', u.id);
            } else {
              throw upErr;
            }
          }
          updated++;
          if (samples.length < 10) samples.push({ invoice_no: u.invoice_no, to: s.id });
        } catch (e: any) {
          await log(job.id, 'error', 'STEP:fix_invoices_update_error', { id: u.id, error: e?.message || String(e) });
        }
      }
    }
  }
  await saveResult(job.id, 'Fix invoices completed', { scanned, updated, skipped, dryRun, samples });
  await log(job.id, 'info', 'STEP:complete', { scanned, updated, skipped, dryRun });
}
\n*** End Patch```}'''
} 주세요}}It's invalid. Let's correct. However the tool apply_patch requires strict format. The previous attempt failed due to extraneous characters. Let's try again. We'll reissue properly. We'll avoid extraneous text. We'll write the add file with correct formatting. We'll proceed. Let's call apply_patch again. We'll ensure the patch contains proper headers and lines. We'll not include spurious characters. We'll try again. We'll craft the file content cleanly. We'll proceed. We'll ensure no backticks. Let's call apply_patch now.  Let's do it.}}


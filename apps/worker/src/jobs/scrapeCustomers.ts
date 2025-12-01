import type { Page } from 'playwright-core';
import type { JobRow, ScrapedCustomerData, CustomerDiff, CustomerFieldChange, CustomerRow } from '@shared/types';

type Ctx = {
  job: JobRow;
  page: Page;
  log: (jobId: string, level: 'info' | 'error', msg: string, data?: Record<string, any>) => Promise<void>;
  saveResult: (jobId: string, summary: string, data: Record<string, any>) => Promise<any>;
  setJobFailedOrRequeue: (job: JobRow, errorMsg: string) => Promise<void>;
  setJobSucceeded: (jobId: string) => Promise<void>;
  ensureNotCancelled: (jobId: string) => Promise<void>;
  supabase: any;
  SPY_BASE_URL: string;
  findFirst: (page: Page, selectors: string[]) => Promise<import('playwright-core').Locator | null>;
};

export async function scrapeCustomers(ctx: Ctx) {
  const { job, page, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase, SPY_BASE_URL, findFirst } = ctx;
  await ensureNotCancelled(job.id);
  try {
    await log(job.id, 'info', 'STEP:customers_begin');
    
    // Step 1: Scrape SPY data (unchanged)
    const listUrl = new URL('?controller=Admin%5CCustomer%5CIndex&action=ActiveList', SPY_BASE_URL).toString();
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await log(job.id, 'info', 'STEP:customers_url', { url: listUrl });
    
    try {
      const btn = await findFirst(page, ['button[name="show_all"]']);
      if (btn) { await btn.click({ timeout: 10_000 }).catch(() => {}); await page.waitForTimeout(1000); }
    } catch {}
    
    await page.waitForSelector('table.standardList tbody tr', { timeout: 60_000 });
    const rows = await page.$$eval('table.standardList tbody tr', (trs) => {
      function tx(el?: Element | null): string { return ((el as HTMLElement | null)?.textContent || '').replace(/\s+/g, ' ').trim(); }
      return Array.from(trs).map(tr => {
        const tds = Array.from((tr as HTMLTableRowElement).querySelectorAll('td')) as HTMLElement[];
        const account = tx(tds[9]);
        const company = tx(tds[1]);
        const city = tx(tds[6]);
        const country = tx(tds[7]);
        const sales_person = tx(tds[5]);
        const phone = tx(tds[12]);
        const priority = tx(tds[14]);
        const ordersA = (tr as HTMLTableRowElement).querySelector('a[href*="show_sales_order"], a[href*="orders"]') as HTMLAnchorElement | null;
        const orders_link = ordersA ? (ordersA.getAttribute('href') || '') : '';
        const spy_id = (tr as HTMLElement).getAttribute('data-reference') || '';
        return { account, company, city, country, sales_person, phone, priority, orders_link, spy_id };
      });
    });
    
    await log(job.id, 'info', 'STEP:customers_rows', { count: rows.length });
    
    // Step 2: Fetch existing customers
    const { data: existingCustomers } = await supabase
      .from('customers')
      .select('id, customer_id, company, city, country, phone, priority, orders_link, spy_id, salesperson_id, salespersons(name)');
    
    // Step 3: Calculate diff
    const diff = await calculateCustomerDiff(rows, existingCustomers || [], supabase, log, job.id);
    
    await log(job.id, 'info', 'STEP:customers_diff', {
      new_count: diff.new.length,
      updated_count: diff.updated.length,
      orphaned_count: diff.orphaned.length
    });
    
    // Step 4: Store preview
    const { data: preview } = await supabase
      .from('customer_scrape_previews')
      .insert({
        job_id: job.id,
        scraped_data: rows,
        diff_data: diff
      })
      .select('id')
      .single();
    
    await saveResult(job.id, 'scrape_customers', {
      preview_id: preview?.id,
      scraped: rows.length,
      new: diff.new.length,
      updated: diff.updated.length,
      orphaned: diff.orphaned.length
    });
    
    await setJobSucceeded(job.id);
  } catch (e: any) {
    await setJobFailedOrRequeue(job, e?.message || String(e));
  }
}

async function calculateCustomerDiff(
  scrapedRows: any[],
  existingCustomers: any[],
  supabase: any,
  log: (jobId: string, level: 'info' | 'error', msg: string, data?: Record<string, any>) => Promise<void>,
  jobId: string
): Promise<CustomerDiff> {
  const { data: spAll } = await supabase.from('salespersons').select('id, name');
  const salespersonByName = new Map<string, string>();
  for (const sp of (spAll ?? []) as any[]) {
    const key = String(sp.name || '').trim().toLowerCase();
    if (key) salespersonByName.set(key, sp.id as string);
  }
  
  const existingByCustomerId = new Map<string, any>();
  for (const c of existingCustomers) {
    existingByCustomerId.set(c.customer_id, c);
  }
  
  const scrapedCustomerIds = new Set<string>();
  const newCustomers: ScrapedCustomerData[] = [];
  const updatedCustomers: any[] = [];
  
  for (const r of scrapedRows) {
    if (!r.account) continue;
    scrapedCustomerIds.add(r.account);
    
    const existing = existingByCustomerId.get(r.account);
    
    if (!existing) {
      // New customer
      newCustomers.push(r);
    } else {
      // Check for changes
      const spName = String(r.sales_person || '').trim();
      const salesperson_id = spName ? (salespersonByName.get(spName.toLowerCase()) || null) : null;
      
      const changes: CustomerFieldChange[] = [];
      
      const fieldMap = [
        { field: 'company', newVal: r.company, oldVal: existing.company },
        { field: 'city', newVal: r.city, oldVal: existing.city },
        { field: 'country', newVal: r.country, oldVal: existing.country },
        { field: 'phone', newVal: r.phone, oldVal: existing.phone },
        { field: 'priority', newVal: r.priority, oldVal: String(existing.priority || '') },
        { field: 'orders_link', newVal: r.orders_link, oldVal: existing.orders_link },
        { field: 'spy_id', newVal: r.spy_id, oldVal: existing.spy_id },
        { field: 'salesperson', newVal: spName, oldVal: existing.salespersons?.name || '' }
      ];
      
      for (const { field, newVal, oldVal } of fieldMap) {
        const nv = String(newVal || '').trim();
        const ov = String(oldVal || '').trim();
        if (nv !== ov) {
          changes.push({ field, oldValue: ov, newValue: nv });
        }
      }
      
      if (changes.length > 0) {
        updatedCustomers.push({
          id: existing.id,
          customer_id: existing.customer_id,
          company: existing.company || '',
          changes
        });
      }
    }
  }
  
  // Find orphaned customers
  const orphanedCustomers: CustomerRow[] = [];
  for (const existing of existingCustomers) {
    if (!scrapedCustomerIds.has(existing.customer_id)) {
      orphanedCustomers.push(existing);
    }
  }
  
  return {
    new: newCustomers,
    updated: updatedCustomers,
    orphaned: orphanedCustomers
  };
}

export async function applyCustomerScrapePreview(ctx: Omit<Ctx, 'page' | 'findFirst' | 'SPY_BASE_URL'>) {
  const { job, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase } = ctx;
  await ensureNotCancelled(job.id);
  
  try {
    const previewId = job.payload?.previewId;
    if (!previewId) throw new Error('Missing previewId in payload');
    
    await log(job.id, 'info', 'STEP:apply_preview_begin', { previewId });
    
    // Fetch preview data
    const { data: preview } = await supabase
      .from('customer_scrape_previews')
      .select('*')
      .eq('id', previewId)
      .single();
    
    if (!preview) throw new Error('Preview not found');
    if (preview.applied_at) throw new Error('Preview already applied');
    
    const scrapedData = preview.scraped_data as any[];
    const diffData = preview.diff_data as CustomerDiff;
    
    await log(job.id, 'info', 'STEP:applying_changes', {
      new_count: diffData.new.length,
      updated_count: diffData.updated.length
    });
    
    // Get salesperson mapping
    const { data: spAll } = await supabase.from('salespersons').select('id, name');
    const salespersonByName = new Map<string, string>();
    for (const sp of (spAll ?? []) as any[]) {
      const key = String(sp.name || '').trim().toLowerCase();
      if (key) salespersonByName.set(key, sp.id as string);
    }
    
    // Apply new customers
    for (const r of diffData.new) {
      if (!r.account) continue;
      
      let salesperson_id: string | null = null;
      const spName = String(r.sales_person || '').trim();
      if (spName) {
        const key = spName.toLowerCase();
        salesperson_id = salespersonByName.get(key) || null;
      }
      
      await supabase.from('customers').insert({
        customer_id: r.account,
        company: r.company,
        city: r.city,
        country: r.country,
        phone: r.phone,
        priority: r.priority,
        orders_link: r.orders_link,
        spy_id: r.spy_id,
        salesperson_id
      });
    }
    
    // Apply updates
    for (const updated of diffData.updated) {
      // Find the corresponding scraped row
      const scrapedRow = scrapedData.find((r: any) => r.account === updated.customer_id);
      if (!scrapedRow) continue;
      
      let salesperson_id: string | null = null;
      const spName = String(scrapedRow.sales_person || '').trim();
      if (spName) {
        const key = spName.toLowerCase();
        salesperson_id = salespersonByName.get(key) || null;
      }
      
      await supabase.from('customers').update({
        company: scrapedRow.company,
        city: scrapedRow.city,
        country: scrapedRow.country,
        phone: scrapedRow.phone,
        priority: scrapedRow.priority,
        orders_link: scrapedRow.orders_link,
        spy_id: scrapedRow.spy_id,
        salesperson_id
      }).eq('id', updated.id);
    }
    
    // Mark preview as applied
    await supabase
      .from('customer_scrape_previews')
      .update({ applied_at: new Date().toISOString() })
      .eq('id', previewId);
    
    await log(job.id, 'info', 'STEP:apply_complete');
    await saveResult(job.id, 'apply_customer_preview', {
      preview_id: previewId,
      new_applied: diffData.new.length,
      updated_applied: diffData.updated.length
    });
    
    await setJobSucceeded(job.id);
  } catch (e: any) {
    await setJobFailedOrRequeue(job, e?.message || String(e));
  }
}



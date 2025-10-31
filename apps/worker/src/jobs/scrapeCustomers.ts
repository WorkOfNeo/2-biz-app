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
  supabase: any;
  SPY_BASE_URL: string;
  findFirst: (page: Page, selectors: string[]) => Promise<import('playwright-core').Locator | null>;
};

export async function scrapeCustomers(ctx: Ctx) {
  const { job, page, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, ensureNotCancelled, supabase, SPY_BASE_URL, findFirst } = ctx;
  await ensureNotCancelled(job.id);
  try {
    await log(job.id, 'info', 'STEP:customers_begin');
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
    const { data: spAll } = await supabase.from('salespersons').select('id, name');
    const salespersonByName = new Map<string, string>();
    for (const sp of (spAll ?? []) as any[]) {
      const key = String(sp.name || '').trim().toLowerCase();
      if (key) salespersonByName.set(key, sp.id as string);
    }
    for (const r of rows) {
      if (!r.account) continue;
      let salesperson_id: string | null = null;
      const spName = String(r.sales_person || '').trim();
      if (spName) {
        const key = spName.toLowerCase();
        salesperson_id = salespersonByName.get(key) || null;
        if (!salesperson_id) await log(job.id, 'info', 'STEP:customers_salesperson_unmatched', { name: spName });
      }
      const { data: existing } = await supabase.from('customers').select('id').eq('customer_id', r.account).maybeSingle();
      const base = { company: r.company, city: r.city, country: r.country, phone: r.phone, priority: r.priority, orders_link: r.orders_link, spy_id: r.spy_id, salesperson_id } as any;
      if (existing?.id) {
        await supabase.from('customers').update(base).eq('id', existing.id as string);
      } else {
        await supabase.from('customers').insert({ customer_id: r.account, ...base });
      }
    }
    await saveResult(job.id, 'scrape_customers', { imported: rows.length });
    await setJobSucceeded(job.id);
  } catch (e: any) {
    await setJobFailedOrRequeue(job, e?.message || String(e));
  }
}



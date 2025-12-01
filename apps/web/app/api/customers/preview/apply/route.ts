import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import type { CustomerDiff } from '@shared/types';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { previewId } = body;
    
    if (!previewId) {
      return NextResponse.json({ error: 'Missing preview ID' }, { status: 400 });
    }
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    
    // Fetch preview data
    const { data: preview, error: previewError } = await supabase
      .from('customer_scrape_previews')
      .select('*')
      .eq('id', previewId)
      .single();
    
    if (previewError || !preview) {
      return NextResponse.json({ error: 'Preview not found' }, { status: 404 });
    }
    
    if (preview.applied_at) {
      return NextResponse.json({ error: 'Preview already applied' }, { status: 400 });
    }
    
    const scrapedData = preview.scraped_data as any[];
    const diffData = preview.diff_data as CustomerDiff;
    
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
    
    return NextResponse.json({ 
      success: true,
      applied: {
        new: diffData.new.length,
        updated: diffData.updated.length
      }
    });
  } catch (e: any) {
    console.error('Apply preview error:', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}


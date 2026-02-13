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
    
    const updates: any[] = [];
    const errors: any[] = [];
    
    // Insert new customers one by one so we can track individual failures
    let newInserted = 0;
    let newFailed = 0;
    
    if (diffData.new.length > 0) {
      console.log(`[Apply] Inserting ${diffData.new.length} new customers...`);
      
      for (const r of diffData.new) {
        if (!r.account) {
          console.log(`[Apply] Skipping customer without account: ${r.company}`);
          continue;
        }
        
        let salesperson_id: string | null = null;
        const spName = String(r.sales_person || '').trim();
        if (spName) {
          const key = spName.toLowerCase();
          salesperson_id = salespersonByName.get(key) || null;
        }
        
        const record = {
          customer_id: r.account,
          company: r.company,
          city: r.city,
          country: r.country,
          phone: r.phone,
          priority: r.priority,
          orders_link: r.orders_link,
          spy_id: r.spy_id,
          salesperson_id,
          inactive: false
        };
        
        const { error: insertError } = await supabase.from('customers').insert(record);
        
        if (insertError) {
          newFailed++;
          const errInfo = { type: 'insert', account: r.account, company: r.company, error: insertError.message };
          errors.push(errInfo);
          console.error(`[Apply] INSERT FAILED: ${r.account} (${r.company}):`, insertError.message);
        } else {
          newInserted++;
          updates.push({ type: 'new', account: r.account, company: r.company || r.account });
          console.log(`[Apply] INSERTED: ${r.account} — ${r.company}`);
        }
      }
      
      console.log(`[Apply] New customers: ${newInserted} inserted, ${newFailed} failed`);
    }
    
    // Update existing customers one by one (each has different ID)
    let updatedCount = 0;
    let updateFailed = 0;
    
    if (diffData.updated.length > 0) {
      console.log(`[Apply] Updating ${diffData.updated.length} customers...`);
    }
    
    for (const updated of diffData.updated) {
      const scrapedRow = scrapedData.find((r: any) => r.account === updated.customer_id);
      if (!scrapedRow) {
        console.log(`[Apply] UPDATE SKIP: No scraped row for ${updated.customer_id} (${updated.company})`);
        continue;
      }
      
      let salesperson_id: string | null = null;
      const spName = String(scrapedRow.sales_person || '').trim();
      if (spName) {
        const key = spName.toLowerCase();
        salesperson_id = salespersonByName.get(key) || null;
      }
      
      const { error: updateError } = await supabase.from('customers').update({
        company: scrapedRow.company,
        city: scrapedRow.city,
        country: scrapedRow.country,
        phone: scrapedRow.phone,
        priority: scrapedRow.priority,
        orders_link: scrapedRow.orders_link,
        spy_id: scrapedRow.spy_id,
        salesperson_id,
        inactive: false
      }).eq('id', updated.id);
      
      if (updateError) {
        updateFailed++;
        const errInfo = { type: 'update', id: updated.id, customer_id: updated.customer_id, company: updated.company, error: updateError.message };
        errors.push(errInfo);
        console.error(`[Apply] UPDATE FAILED: ${updated.customer_id} (${updated.company}):`, updateError.message);
      } else {
        updatedCount++;
        updates.push({ type: 'updated', customer_id: updated.customer_id, company: scrapedRow.company || updated.customer_id, changes: updated.changes?.length || 0 });
      }
    }
    
    if (diffData.updated.length > 0) {
      console.log(`[Apply] Updates: ${updatedCount} ok, ${updateFailed} failed`);
    }
    
    // Mark preview as applied
    const { error: markError } = await supabase
      .from('customer_scrape_previews')
      .update({ applied_at: new Date().toISOString() })
      .eq('id', previewId);
    
    if (markError) {
      console.error('[Apply] Failed to mark preview as applied:', markError.message);
    }
    
    console.log(`[Apply] Complete — new: ${newInserted}/${diffData.new.length}, updated: ${updatedCount}/${diffData.updated.length}, errors: ${errors.length}`);
    
    return NextResponse.json({ 
      success: true,
      applied: {
        new_inserted: newInserted,
        new_failed: newFailed,
        updated: updatedCount,
        update_failed: updateFailed
      },
      updates,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (e: any) {
    console.error('Apply preview error:', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}


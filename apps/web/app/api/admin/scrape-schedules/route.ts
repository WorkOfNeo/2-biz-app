import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Default schedules to show if table doesn't exist yet
const DEFAULT_SCHEDULES = [
  { id: 'default-1', key: 'check_stock_fix', name: 'Check Stock Fix', description: 'Compare SPY stock with database and auto-fix mismatches', enabled: true, hours: [7, 12, 15], days_of_week: null, config: { minuteOffset: 30, autoFix: true }, updated_at: new Date().toISOString() },
  { id: 'default-2', key: 'scrape_statistics', name: 'Scrape Statistics', description: 'Scrape sales statistics from SPY', enabled: true, hours: [7, 9, 11, 13, 15], days_of_week: null, config: { styleDetailsHours: [7, 15] }, updated_at: new Date().toISOString() },
  { id: 'default-3', key: 'scrape_purchase_orders', name: 'Sync Purchase Orders', description: 'Sync PO data from SPY', enabled: true, hours: [7, 12, 15], days_of_week: null, config: {}, updated_at: new Date().toISOString() },
  { id: 'default-4', key: 'export_statistics', name: 'Export Statistics PDFs', description: 'Generate and export statistics PDFs', enabled: true, hours: [7, 15], days_of_week: null, config: {}, updated_at: new Date().toISOString() },
  { id: 'default-5', key: 'weekly_style_refresh', name: 'Weekly Style Refresh', description: 'Full style data refresh pipeline (scrape → enrich → EANs → stock)', enabled: true, hours: [2], days_of_week: [0], config: {}, updated_at: new Date().toISOString() },
  { id: 'default-6', key: 'weekly_customer_sync', name: 'Weekly Customer Sync', description: 'Sync customer data and flag orphaned customers', enabled: true, hours: [4], days_of_week: [0], config: {}, updated_at: new Date().toISOString() },
  { id: 'default-7', key: 'scrape_top_styles', name: 'Scrape Top Styles', description: 'Scrape Top Styles from SPY (used for Top Styles PDFs)', enabled: true, hours: [7, 15], days_of_week: null, config: {}, updated_at: new Date().toISOString() },
];

export async function GET() {
  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    
    const { data, error } = await supabase
      .from('scrape_schedules')
      .select('*')
      .order('name', { ascending: true });
    
    if (error) {
      // If table doesn't exist, return defaults
      if (error.message.includes('scrape_schedules') || error.code === '42P01') {
        return NextResponse.json({ 
          schedules: DEFAULT_SCHEDULES,
          notice: 'Using default schedules. Run SQL migration 117_scrape_schedules.sql to enable editing.'
        });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    
    return NextResponse.json({ schedules: data });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const { id, enabled, hours, days_of_week, config } = body;
    
    if (!id) {
      return NextResponse.json({ error: 'Missing schedule id' }, { status: 400 });
    }
    
    // Check if this is a default ID (table doesn't exist)
    if (id.startsWith('default-')) {
      return NextResponse.json({ 
        error: 'Cannot update schedules until migration is run. Please run SQL migration 117_scrape_schedules.sql first.' 
      }, { status: 400 });
    }
    
    if (!supabaseServiceKey) {
      console.error('[scrape-schedules] SUPABASE_SERVICE_ROLE_KEY is not set');
      return NextResponse.json({ error: 'Service configuration error' }, { status: 500 });
    }
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    
    const updateData: Record<string, any> = {};
    if (typeof enabled === 'boolean') updateData.enabled = enabled;
    if (Array.isArray(hours)) updateData.hours = hours;
    if (days_of_week !== undefined) updateData.days_of_week = days_of_week;
    if (config !== undefined) updateData.config = config;
    
    console.log('[scrape-schedules] PATCH - Updating schedule:', { id, updateData });
    
    const { data, error } = await supabase
      .from('scrape_schedules')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();
    
    if (error) {
      console.error('[scrape-schedules] PATCH error:', error);
      if (error.message.includes('scrape_schedules') || error.code === '42P01') {
        return NextResponse.json({ 
          error: 'Table does not exist. Run SQL migration 117_scrape_schedules.sql first.' 
        }, { status: 400 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    
    console.log('[scrape-schedules] PATCH - Success:', data);
    return NextResponse.json({ schedule: data });
  } catch (e: any) {
    console.error('[scrape-schedules] PATCH exception:', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}

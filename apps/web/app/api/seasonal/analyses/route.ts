import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

// GET: List saved seasonal analyses
export async function GET(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const { searchParams } = new URL(req.url);
    
    const limit = parseInt(searchParams.get('limit') || '50');
    const offset = parseInt(searchParams.get('offset') || '0');

    const { data, error, count } = await supabase
      .from('seasonal_analysis')
      .select('id, season_id, selections, date_range_start, date_range_end, summary, ai_summary, pdf_url, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data, count });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

// POST: Save a new seasonal analysis
export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const {
      season_id,
      selections,
      date_range_start,
      date_range_end,
      items,
      orders_by_style,
      orders_by_country,
      summary,
      ai_summary,
      supplier_rules_snapshot,
      pdf_url
    } = body;

    if (!selections || !date_range_start || !date_range_end || !items || !summary) {
      return NextResponse.json({ 
        error: 'selections, date_range_start, date_range_end, items, and summary are required' 
      }, { status: 400 });
    }

    // Get current user
    const { data: { user } } = await supabase.auth.getUser();

    const { data, error } = await supabase
      .from('seasonal_analysis')
      .insert({
        season_id: season_id || null,
        selections,
        date_range_start,
        date_range_end,
        items,
        orders_by_style: orders_by_style || null,
        orders_by_country: orders_by_country || null,
        summary,
        ai_summary: ai_summary || null,
        supplier_rules_snapshot: supplier_rules_snapshot || null,
        pdf_url: pdf_url || null,
        created_by: user?.id || null
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}








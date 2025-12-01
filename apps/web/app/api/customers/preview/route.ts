import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const previewId = searchParams.get('id');
    
    if (!previewId) {
      return NextResponse.json({ error: 'Missing preview ID' }, { status: 400 });
    }
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    
    const { data: preview, error } = await supabase
      .from('customer_scrape_previews')
      .select('*')
      .eq('id', previewId)
      .single();
    
    if (error || !preview) {
      return NextResponse.json({ error: 'Preview not found' }, { status: 404 });
    }
    
    return NextResponse.json({ preview });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}


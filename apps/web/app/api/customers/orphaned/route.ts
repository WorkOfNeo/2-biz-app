import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const customerId = searchParams.get('id');
    const deleteAll = searchParams.get('all') === 'true';
    const previewId = searchParams.get('previewId');
    
    if (!deleteAll && !customerId) {
      return NextResponse.json({ error: 'Missing customer ID or all flag' }, { status: 400 });
    }
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    
    if (deleteAll && previewId) {
      // Delete all orphaned customers from the preview
      const { data: preview } = await supabase
        .from('customer_scrape_previews')
        .select('diff_data')
        .eq('id', previewId)
        .single();
      
      if (!preview) {
        return NextResponse.json({ error: 'Preview not found' }, { status: 404 });
      }
      
      const diffData = preview.diff_data as any;
      const orphanedIds = (diffData.orphaned || []).map((c: any) => c.id);
      
      if (orphanedIds.length > 0) {
        const { error } = await supabase
          .from('customers')
          .update({ inactive: true })
          .in('id', orphanedIds);
        
        if (error) {
          return NextResponse.json({ error: 'Failed to mark customers as inactive' }, { status: 500 });
        }
      }
      
      return NextResponse.json({ marked_inactive: orphanedIds.length });
    } else if (customerId) {
      // Mark single customer as inactive
      const { error } = await supabase
        .from('customers')
        .update({ inactive: true })
        .eq('id', customerId);
      
      if (error) {
        return NextResponse.json({ error: 'Failed to mark customer as inactive' }, { status: 500 });
      }
      
      return NextResponse.json({ marked_inactive: 1 });
    }
    
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}


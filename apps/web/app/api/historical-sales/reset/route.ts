import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    
    const { confirm } = body;
    
    if (confirm !== 'RESET_ALL_HISTORICAL_SALES') {
      return NextResponse.json({ 
        error: 'Confirmation required. Send { confirm: "RESET_ALL_HISTORICAL_SALES" }' 
      }, { status: 400 });
    }

    // Delete all historical sales data
    const { error } = await supabase
      .from('historical_sales')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all rows (trick to delete everything)

    if (error) {
      console.error('[Historical Sales Reset] Error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log('[Historical Sales Reset] Deleted all rows');

    return NextResponse.json({ 
      success: true, 
      message: 'All historical sales data has been deleted'
    });
  } catch (error: any) {
    console.error('[Historical Sales Reset] Exception:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

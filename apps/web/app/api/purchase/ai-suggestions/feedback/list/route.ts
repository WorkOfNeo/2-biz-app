import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/purchase/ai-suggestions/feedback/list
 * 
 * List all feedback for a season (for the Feedback UI).
 */
export async function GET(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const { searchParams } = new URL(req.url);
    
    const seasonId = searchParams.get('seasonId');
    const limit = parseInt(searchParams.get('limit') || '500', 10);

    if (!seasonId) {
      return NextResponse.json({ error: 'seasonId is required' }, { status: 400 });
    }

    // Get all feedback for runs in this season
    const { data, error } = await supabase
      .from('purchase_ai_line_feedback')
      .select(`
        id,
        purchase_run_id,
        supplier_name,
        style_no,
        color,
        suggested_qty,
        adjusted_qty,
        verdict,
        reason,
        created_at,
        purchase_ai_runs!inner(
          season_id,
          run_label,
          run_number
        )
      `)
      .eq('purchase_ai_runs.season_id', seasonId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[Feedback List] Failed to fetch:', error);
      
      // Fallback: try without the join (in case the relationship isn't set up)
      const { data: fallbackData, error: fallbackError } = await supabase
        .from('purchase_ai_line_feedback')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
      
      if (fallbackError) {
        return NextResponse.json({ error: fallbackError.message }, { status: 500 });
      }
      
      return NextResponse.json({
        feedback: fallbackData || [],
        count: (fallbackData || []).length,
      });
    }

    // Flatten the response
    const feedback = (data || []).map(f => ({
      ...f,
      run_label: (f.purchase_ai_runs as any)?.run_label,
      run_number: (f.purchase_ai_runs as any)?.run_number,
      purchase_ai_runs: undefined, // Remove nested object
    }));

    return NextResponse.json({
      feedback,
      count: feedback.length,
    });

  } catch (error: any) {
    console.error('[Feedback List] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}


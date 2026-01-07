import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/purchase/ai-suggestions/feedback
 * 
 * Save line-level feedback for AI learning.
 * This feedback is used in future prompts to help the AI
 * learn from corrections made by users.
 */
export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const {
      purchaseRunId,
      supplierName,
      styleNo,
      color,
      suggestedQty,
      adjustedQty,
      verdict, // 'approved' | 'adjusted' | 'skipped'
      reason,
    } = body;

    if (!purchaseRunId || !supplierName || !styleNo || !color) {
      return NextResponse.json(
        { error: 'Missing required fields: purchaseRunId, supplierName, styleNo, color' },
        { status: 400 }
      );
    }

    console.log('[Feedback] Saving feedback:', {
      purchaseRunId,
      supplierName,
      styleNo,
      color,
      suggestedQty,
      adjustedQty,
      verdict,
      reason: reason?.substring(0, 50),
    });

    // Insert or update feedback record
    const { data, error } = await supabase
      .from('purchase_ai_line_feedback')
      .upsert({
        purchase_run_id: purchaseRunId,
        supplier_name: supplierName,
        style_no: styleNo,
        color: color,
        suggested_qty: suggestedQty || 0,
        adjusted_qty: adjustedQty,
        verdict: verdict || 'adjusted',
        reason: reason || null,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'purchase_run_id,supplier_name,style_no,color',
      })
      .select()
      .single();

    if (error) {
      console.error('[Feedback] Failed to save:', error);
      
      // If the unique constraint doesn't exist, try insert without upsert
      if (error.code === '42P10') {
        const { data: insertData, error: insertError } = await supabase
          .from('purchase_ai_line_feedback')
          .insert({
            purchase_run_id: purchaseRunId,
            supplier_name: supplierName,
            style_no: styleNo,
            color: color,
            suggested_qty: suggestedQty || 0,
            adjusted_qty: adjustedQty,
            verdict: verdict || 'adjusted',
            reason: reason || null,
          })
          .select()
          .single();
        
        if (insertError) {
          return NextResponse.json({ error: insertError.message }, { status: 500 });
        }
        
        return NextResponse.json({ success: true, feedback: insertData });
      }
      
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log('[Feedback] Saved successfully:', data?.id);

    return NextResponse.json({ success: true, feedback: data });

  } catch (error: any) {
    console.error('[Feedback] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * GET /api/purchase/ai-suggestions/feedback
 * 
 * Get recent feedback for a season (used for AI learning).
 */
export async function GET(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const { searchParams } = new URL(req.url);
    
    const seasonId = searchParams.get('seasonId');
    const limit = parseInt(searchParams.get('limit') || '100', 10);

    if (!seasonId) {
      return NextResponse.json({ error: 'seasonId is required' }, { status: 400 });
    }

    // Use the get_recent_line_feedback function from migration 107
    const { data, error } = await supabase
      .rpc('get_recent_line_feedback', {
        p_season_id: seasonId,
        p_limit: limit,
      });

    if (error) {
      console.error('[Feedback] Failed to fetch:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      feedback: data || [],
      count: (data || []).length,
    });

  } catch (error: any) {
    console.error('[Feedback] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}


import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

// GET: Fetch recent feedback for style/color or all
export async function GET(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const { searchParams } = new URL(req.url);
    
    const styleNo = searchParams.get('style_no');
    const color = searchParams.get('color');
    const limit = parseInt(searchParams.get('limit') || '50');

    let query = supabase
      .from('call_off_feedback')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (styleNo) {
      query = query.eq('style_no', styleNo);
    }
    if (color) {
      query = query.eq('color', color);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Calculate summary stats
    const total = data?.length || 0;
    const correct = data?.filter(f => f.verdict === 'correct').length || 0;
    const incorrect = data?.filter(f => f.verdict === 'incorrect').length || 0;

    return NextResponse.json({ 
      data,
      summary: {
        total,
        correct,
        incorrect,
        accuracy: total > 0 ? (correct / total * 100).toFixed(1) : null
      }
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

// POST: Submit feedback for a style/color
export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const { 
      analysis_id, 
      style_no, 
      color, 
      verdict, 
      notes, 
      suggested_order, 
      actual_order 
    } = body;

    if (!style_no || !color || !verdict) {
      return NextResponse.json({ 
        error: 'style_no, color, and verdict are required' 
      }, { status: 400 });
    }

    if (!['correct', 'incorrect'].includes(verdict)) {
      return NextResponse.json({ 
        error: 'verdict must be "correct" or "incorrect"' 
      }, { status: 400 });
    }

    // Get current user
    const { data: { user } } = await supabase.auth.getUser();

    const { data, error } = await supabase
      .from('call_off_feedback')
      .insert({
        analysis_id: analysis_id || null,
        style_no,
        color,
        verdict,
        notes: notes?.trim() || null,
        suggested_order: suggested_order || null,
        actual_order: actual_order || null,
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

// Helper function to get feedback summary for AI prompt
export async function getFeedbackSummaryForAI(
  supabase: any,
  styleNos: string[],
  colors: string[],
  limit: number = 20
): Promise<string> {
  try {
    const { data } = await supabase
      .from('call_off_feedback')
      .select('style_no, color, verdict, notes, created_at')
      .in('style_no', styleNos)
      .in('color', colors)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (!data || data.length === 0) {
      return '';
    }

    const correct = data.filter((f: any) => f.verdict === 'correct').length;
    const incorrect = data.filter((f: any) => f.verdict === 'incorrect').length;

    let summary = `\n\nPREVIOUS FEEDBACK (${data.length} entries, ${correct} correct, ${incorrect} incorrect):\n`;
    
    // Add notable feedback notes
    const withNotes = data.filter((f: any) => f.notes);
    if (withNotes.length > 0) {
      summary += 'User notes:\n';
      withNotes.slice(0, 5).forEach((f: any) => {
        summary += `- ${f.style_no} ${f.color} (${f.verdict}): ${f.notes}\n`;
      });
    }

    return summary;
  } catch {
    return '';
  }
}


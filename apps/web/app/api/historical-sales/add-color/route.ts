import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * POST /api/historical-sales/add-color
 * Add a new color to a style (server-side to bypass RLS)
 * 
 * Body: {
 *   style_id: string,
 *   color: string
 * }
 */
export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();
    
    const { style_id, color } = body;
    
    if (!style_id || !color) {
      return NextResponse.json(
        { error: 'style_id and color are required' }, 
        { status: 400 }
      );
    }

    // Verify the style exists
    const { data: style, error: styleError } = await supabase
      .from('styles')
      .select('id, style_no')
      .eq('id', style_id)
      .single();

    if (styleError || !style) {
      return NextResponse.json(
        { error: 'Style not found' }, 
        { status: 404 }
      );
    }

    // Check if this color already exists for this style
    const { data: existing } = await supabase
      .from('style_colors')
      .select('id')
      .eq('style_id', style_id)
      .eq('color', color.trim())
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        { error: 'This color already exists for this style' }, 
        { status: 409 }
      );
    }

    // Insert the new color
    const { data: newColor, error: insertError } = await supabase
      .from('style_colors')
      .insert({
        style_id,
        color: color.trim()
      })
      .select('id, color')
      .single();

    if (insertError) {
      console.error('[add-color] Insert error:', insertError);
      return NextResponse.json(
        { error: insertError.message }, 
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      color: newColor,
      style_no: style.style_no
    });
  } catch (error: any) {
    console.error('[add-color] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' }, 
      { status: 500 }
    );
  }
}

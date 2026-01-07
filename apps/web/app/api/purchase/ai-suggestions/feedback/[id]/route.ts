import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/purchase/ai-suggestions/feedback/[id]
 * 
 * Delete a specific feedback item.
 */
export async function DELETE(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const { id } = params;

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    const { error } = await supabase
      .from('purchase_ai_line_feedback')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('[Feedback Delete] Failed:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error('[Feedback Delete] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}


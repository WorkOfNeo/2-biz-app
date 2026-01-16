import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function extractExportsStoragePathFromPublicUrl(publicUrl: string): string | null {
  // Typical Supabase public URL format:
  // https://<project>.supabase.co/storage/v1/object/public/exports/<path>
  const marker = '/object/public/exports/';
  const idx = publicUrl.indexOf(marker);
  if (idx !== -1) return publicUrl.slice(idx + marker.length);

  // Fallback: some setups may expose /exports/<path>
  const marker2 = '/exports/';
  const idx2 = publicUrl.indexOf(marker2);
  if (idx2 !== -1) return publicUrl.slice(idx2 + marker2.length);

  return null;
}

/**
 * DELETE - Delete a purchase round (purchase_ai_runs) by ID.
 * Also removes the related ai_season_analyses row (purchase_round) when possible,
 * and removes the PDF from storage (bucket: exports) if present.
 */
export async function DELETE(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const purchaseRunId = params.id;

    if (!purchaseRunId) {
      return NextResponse.json({ error: 'Purchase run ID is required' }, { status: 400 });
    }

    // Fetch the purchase run first
    const { data: purchaseRun, error: fetchError } = await supabase
      .from('purchase_ai_runs')
      .select('id, season_id, run_number, ai_run_id, pdf_url')
      .eq('id', purchaseRunId)
      .single();

    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }

    if (!purchaseRun) {
      return NextResponse.json({ error: 'Purchase round not found' }, { status: 404 });
    }

    // Remove PDF from storage if it exists
    if (purchaseRun.pdf_url) {
      try {
        const storagePath = extractExportsStoragePathFromPublicUrl(purchaseRun.pdf_url);
        if (storagePath) {
          await supabase.storage.from('exports').remove([storagePath]);
        }
      } catch (e) {
        console.warn('[Delete Purchase Round] Failed to delete PDF from storage:', e);
        // Continue even if storage cleanup fails
      }
    }

    // Delete related ai_season_analyses row(s) for purchase rounds
    // Prefer ai_run_id match; otherwise fall back to season_id + run_number
    try {
      if (purchaseRun.ai_run_id) {
        await supabase
          .from('ai_season_analyses')
          .delete()
          .eq('ai_run_id', purchaseRun.ai_run_id)
          .eq('analysis_type', 'purchase_round');
      } else if (purchaseRun.season_id && purchaseRun.run_number != null) {
        await supabase
          .from('ai_season_analyses')
          .delete()
          .eq('season_id', purchaseRun.season_id)
          .eq('analysis_type', 'purchase_round')
          .eq('purchase_round_number', purchaseRun.run_number);
      }
    } catch (e) {
      console.warn('[Delete Purchase Round] Failed to delete related ai_season_analyses rows:', e);
      // Continue; the main intent is to delete the purchase run
    }

    // Delete the purchase run (will cascade to purchase_ai_line_feedback, etc.)
    const { error: deleteRunError } = await supabase
      .from('purchase_ai_runs')
      .delete()
      .eq('id', purchaseRunId);

    if (deleteRunError) {
      return NextResponse.json({ error: deleteRunError.message }, { status: 500 });
    }

    // Optionally clean up the ai_run record as well
    if (purchaseRun.ai_run_id) {
      await supabase.from('ai_runs').delete().eq('id', purchaseRun.ai_run_id);
    }

    return NextResponse.json({
      success: true,
      message: 'Purchase round deleted successfully',
      deletedId: purchaseRunId,
    });
  } catch (e: any) {
    console.error('[Delete Purchase Round] Error:', e);
    return NextResponse.json(
      { error: e?.message || 'Failed to delete purchase round' },
      { status: 500 }
    );
  }
}


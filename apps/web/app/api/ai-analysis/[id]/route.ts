import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET - Fetch a single AI analysis by ID
 */
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const analysisId = params.id;

    const { data, error } = await supabase
      .from('ai_season_analyses')
      .select(`
        *,
        season:seasons!ai_season_analyses_season_id_fkey(name, year),
        comparison_season:seasons!ai_season_analyses_comparison_season_id_fkey(name, year)
      `)
      .eq('id', analysisId)
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: 'Analysis not found' }, { status: 404 });
    }

    return NextResponse.json({ analysis: data });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to fetch analysis' }, { status: 500 });
  }
}

/**
 * DELETE - Delete a single AI analysis by ID
 */
export async function DELETE(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const analysisId = params.id;

    if (!analysisId) {
      return NextResponse.json({ error: 'Analysis ID is required' }, { status: 400 });
    }

    // First fetch the analysis to get related info
    const { data: analysis, error: fetchError } = await supabase
      .from('ai_season_analyses')
      .select('id, ai_run_id, pdf_url')
      .eq('id', analysisId)
      .single();

    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }

    if (!analysis) {
      return NextResponse.json({ error: 'Analysis not found' }, { status: 404 });
    }

    // Delete the PDF from storage if it exists
    if (analysis.pdf_url) {
      try {
        // Extract the path from the URL
        const urlParts = analysis.pdf_url.split('/ai-analysis-pdfs/');
        if (urlParts.length > 1) {
          const filePath = urlParts[1];
          await supabase.storage
            .from('ai-analysis-pdfs')
            .remove([filePath]);
        }
      } catch (e) {
        console.warn('[Delete Analysis] Failed to delete PDF from storage:', e);
        // Continue with deletion even if PDF removal fails
      }
    }

    // Delete the analysis (this will cascade to related records)
    const { error: deleteError } = await supabase
      .from('ai_season_analyses')
      .delete()
      .eq('id', analysisId);

    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }

    // Also delete the related ai_run if it exists
    if (analysis.ai_run_id) {
      await supabase
        .from('ai_runs')
        .delete()
        .eq('id', analysis.ai_run_id);
    }

    return NextResponse.json({ 
      success: true, 
      message: 'Analysis deleted successfully',
      deletedId: analysisId 
    });
  } catch (e: any) {
    console.error('[Delete Analysis] Error:', e);
    return NextResponse.json({ error: e?.message || 'Failed to delete analysis' }, { status: 500 });
  }
}

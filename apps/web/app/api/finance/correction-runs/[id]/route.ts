import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

// GET: fetch a specific run with all its rows
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const runId = params.id;

    if (!runId) {
      return NextResponse.json({ error: 'Run ID is required' }, { status: 400 });
    }

    // Fetch the run metadata
    const { data: run, error: runError } = await supabase
      .from('finance_correction_runs')
      .select('*')
      .eq('id', runId)
      .maybeSingle();

    if (runError) {
      console.error('[Correction API] Run fetch error:', runError);
      return NextResponse.json({ error: runError.message }, { status: 500 });
    }

    if (!run) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    // Fetch all rows for this run
    const { data: rows, error: rowsError } = await supabase
      .from('finance_correction_rows')
      .select('*')
      .eq('run_id', runId)
      .order('row_no', { ascending: true });

    if (rowsError) {
      console.error('[Correction API] Rows fetch error:', rowsError);
      return NextResponse.json({ error: rowsError.message }, { status: 500 });
    }

    return NextResponse.json({
      run,
      rows: rows ?? [],
    });
  } catch (error: any) {
    console.error('[Correction API] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

// DELETE: delete a run and its rows
export async function DELETE(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const runId = params.id;

    if (!runId) {
      return NextResponse.json({ error: 'Run ID is required' }, { status: 400 });
    }

    // Delete the run (rows will cascade delete)
    const { error } = await supabase
      .from('finance_correction_runs')
      .delete()
      .eq('id', runId);

    if (error) {
      console.error('[Correction API] Delete error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('[Correction API] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

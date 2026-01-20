import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

// GET: fetch a specific run with all its rows, re-lookup style for fresh pricing
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

    // Re-lookup style from database to get fresh pricing data
    const { data: style } = await supabase
      .from('styles')
      .select('style_no, style_name, cost_price, cost_price_currency, customs_tariff_no, country_of_origin')
      .eq('style_no', run.style_no)
      .maybeSingle();

    // Use fresh style data if available, otherwise fall back to stored snapshot
    const styleMeta = {
      style_no: run.style_no,
      style_name: style?.style_name ?? run.style_name,
      cost_price: style?.cost_price ?? run.cost_price,
      cost_price_currency: style?.cost_price_currency ?? run.cost_price_currency,
      customs_tariff_no: style?.customs_tariff_no || run.file_customs_tariff || run.customs_tariff_no,
      country_of_origin: style?.country_of_origin ?? run.country_of_origin,
    };

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

    // Update rows with fresh style data (pris, varenavn, valuta, toldtariff, oprindelsesland, vaerdi)
    const updatedRows = (rows ?? []).map((row: any) => ({
      ...row,
      varenavn: styleMeta.style_name || row.varenavn,
      pris: styleMeta.cost_price ?? row.pris,
      valuta_original: styleMeta.cost_price_currency || row.valuta_original,
      valuta: styleMeta.cost_price_currency || row.valuta,
      toldtariff: styleMeta.customs_tariff_no || row.toldtariff,
      oprindelsesland: styleMeta.country_of_origin || row.oprindelsesland,
      vaerdi: styleMeta.cost_price != null ? styleMeta.cost_price * Math.abs(row.antal || 0) : row.vaerdi,
    }));

    return NextResponse.json({
      run,
      styleMeta,
      rows: updatedRows,
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

import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

// === LOGIC FUNCTIONS (same as in route.ts) ===

function buildReference(type: string, delivery: string): string {
  const t = String(type || '').trim().toLowerCase();
  const del = String(delivery || '').trim();

  // Match Sales (English: sales/sale, Danish: salg)
  if (t === 'sales' || t === 'sale' || t === 'salg' || t.startsWith('sal')) {
    return `Delivery No. ${del}`;
  } 
  // Match Correction (English: correction, Danish: korrektion/rettelse)
  else if (t === 'correction' || t === 'korrektion' || t === 'rettelse' || t.startsWith('corr') || t.startsWith('korr') || t.startsWith('rett')) {
    return 'Correction';
  } 
  // Match Purchase (English: purchase, Danish: køb/indkøb)
  else if (t === 'purchase' || t === 'køb' || t === 'indkøb' || t.startsWith('purch') || t === 'po') {
    return `Purchase - PO ${del}`;
  }
  // Fallback
  return t ? `${type}: ${del}` : del;
}

function buildIndUd(type: string): string {
  const t = String(type || '').trim().toLowerCase();
  if (t === 'purchase' || t === 'køb' || t === 'indkøb' || t.startsWith('purch')) {
    return 'Ind';
  }
  return 'Ud';
}

function isCorrectionType(type: string): boolean {
  const t = String(type || '').trim().toLowerCase();
  return (
    t === 'correction' ||
    t === 'korrektion' ||
    t === 'rettelse' ||
    t.startsWith('corr') ||
    t.startsWith('korr') ||
    t.startsWith('rett')
  );
}

function buildAntal(type: string, qty: number): number {
  const t = String(type || '').trim().toLowerCase();
  // Keep sign for Correction rows so exports show surplus/negative.
  if (isCorrectionType(t)) return qty;

  if (t !== 'purchase' && t !== 'køb' && t !== 'indkøb' && !t.startsWith('purch') && qty < 0) {
    return Math.abs(qty);
  }
  return qty;
}

function buildNonEu(eksportTil: string, exportNo: string): string {
  // If there's an Export No., it's non-EU → "Ja"
  const expNo = String(exportNo || '').trim();
  if (expNo) {
    return 'Ja';
  }
  
  const val = String(eksportTil || '').trim().toLowerCase();
  if (!val) {
    return '';
  }
  
  // Check if destination IS EU
  if (val === 'eu' || val === 'yes' || val === 'ja' || val === 'y') {
    return '';
  }
  
  return 'Ja';
}

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

    // Re-process rows with current logic (same as when uploading)
    const updatedRows = (rows ?? []).map((row: any) => {
      // Get source data (if available from new uploads) or fall back to stored values
      const sourceType = row.source_type || '';
      const sourceDelivery = row.source_delivery || '';
      const sourceQty = row.source_qty ?? row.antal ?? 0;
      const exportNo = row.eksport_ref || '';
      const eksportTil = row.eksport_til || '';

      // Re-calculate using current logic
      const antal = buildAntal(sourceType, sourceQty);
      const pris = styleMeta.cost_price ?? row.pris;
      const vaerdi = pris != null ? pris * antal : row.vaerdi;

      return {
        ...row,
        // Fresh style data
        varenavn: styleMeta.style_name || row.varenavn,
        pris,
        valuta_original: styleMeta.cost_price_currency || row.valuta_original,
        valuta: styleMeta.cost_price_currency || row.valuta,
        toldtariff: styleMeta.customs_tariff_no || row.toldtariff,
        oprindelsesland: styleMeta.country_of_origin || row.oprindelsesland,
        // Re-calculated logic fields
        reference: sourceType ? buildReference(sourceType, sourceDelivery) : row.reference,
        ind_ud: sourceType ? buildIndUd(sourceType) : row.ind_ud,
        antal,
        vaerdi,
        non_eu: buildNonEu(eksportTil, exportNo),
      };
    });

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

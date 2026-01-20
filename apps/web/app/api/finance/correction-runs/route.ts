import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

// Input row structure from parsed XLSX (client sends these)
type InputRow = {
  rowNo: number;
  transactionDate: string; // A - raw date string
  customsRef: string;      // B
  exportNo: string;        // D
  type: string;            // F - Sales, Correction, Purchase
  delivery: string;        // G
  eu: string;              // K
  qty: number;             // M
};

// Output row structure (stored in DB and returned to client)
type OutputRow = {
  row_no: number;
  toldref: string;
  varenr: string;
  varenavn: string;
  pris: number | null;
  valuta_original: string;
  toldtariff: string;
  oprindelsesland: string;
  ny_toldlager: string;
  dato: string; // YYYY-MM-DD
  day: number;
  month: number;
  year: number;
  reference: string;
  ind_ud: string;
  eksport_ref: string;
  eksport_til: string;
  antal: number;
  vaerdi: number | null;
  valuta: string;
  kurs: string;
  total_dkk_vaerdi: string;
  frafoerselsref: string;
  non_eu: string;
};

function parseDate(raw: string | number | null | undefined): { date: string; day: number; month: number; year: number } | null {
  if (raw == null || raw === '') return null;

  let d: Date | null = null;

  // If it's a number, treat it as an Excel serial date
  if (typeof raw === 'number') {
    // Excel serial date: days since 1899-12-30
    const excelEpoch = new Date(1899, 11, 30);
    d = new Date(excelEpoch.getTime() + raw * 86400000);
  } else {
    // Try to parse as string
    const str = String(raw).trim();
    d = new Date(str);
    if (isNaN(d.getTime())) {
      // Try DD-MM-YYYY or DD/MM/YYYY
      const match = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
      if (match) {
        const day = parseInt(match[1]!, 10);
        const month = parseInt(match[2]!, 10) - 1;
        let year = parseInt(match[3]!, 10);
        if (year < 100) year += 2000;
        d = new Date(year, month, day);
      }
    }
  }

  if (!d || isNaN(d.getTime())) return null;

  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');

  return {
    date: `${yyyy}-${mm}-${dd}`,
    day: d.getDate(),
    month: d.getMonth() + 1,
    year: yyyy,
  };
}

function buildReference(type: string, delivery: string): string {
  const t = String(type || '').trim().toLowerCase();
  const del = String(delivery || '').trim();

  console.log('[buildReference]', { type, t, delivery: del });

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
  // Fallback: return the type and delivery for debugging
  return t ? `${type}: ${del}` : del;
}

function buildIndUd(type: string): string {
  const t = String(type || '').trim().toLowerCase();
  // Purchase (English or Danish) = Ind, everything else = Ud
  if (t === 'purchase' || t === 'køb' || t === 'indkøb' || t.startsWith('purch')) {
    return 'Ind';
  }
  return 'Ud';
}

function buildAntal(type: string, qty: number): number {
  const t = String(type || '').trim().toLowerCase();
  // For non-purchase, if qty is negative, take absolute value
  if (t !== 'purchase' && qty < 0) {
    return Math.abs(qty);
  }
  return qty;
}

function buildNonEu(eksportTil: string): string {
  // Column K contains the destination. 
  // If destination IS EU → Non-EU column should be EMPTY
  // If destination is NOT EU → Non-EU column should be "Ja"
  const val = String(eksportTil || '').trim().toLowerCase();
  
  console.log('[buildNonEu] input:', eksportTil, '→ normalized:', val);
  
  // Empty value = unknown, leave empty
  if (!val) {
    return '';
  }
  
  // Check if destination IS EU (return empty for Non-EU column)
  // Common values indicating EU: "EU", "Yes", "Ja", "Y"
  if (val === 'eu' || val === 'yes' || val === 'ja' || val === 'y') {
    return ''; // It IS EU, so Non-EU is empty
  }
  
  // If it says "No", "Nej", "N", or "Non-EU", "Non EU" → it's NOT EU
  // Any other value (like country codes) is assumed to be non-EU destination
  return 'Ja';
}

// POST: create a new correction run
export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const { fileName, styleNo, fileTariff, rows } = body as {
      fileName?: string;
      styleNo: string;
      fileTariff?: string;
      rows: InputRow[];
    };

    if (!styleNo) {
      return NextResponse.json({ error: 'styleNo is required' }, { status: 400 });
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: 'rows array is required' }, { status: 400 });
    }

    // Fetch style metadata from styles table
    const { data: style, error: styleError } = await supabase
      .from('styles')
      .select('style_no, style_name, cost_price, cost_price_currency, customs_tariff_no, country_of_origin')
      .eq('style_no', styleNo)
      .maybeSingle();

    if (styleError) {
      console.error('[Correction API] Style query error:', styleError);
      return NextResponse.json({ error: styleError.message }, { status: 500 });
    }

    // Style may not exist in DB - we'll still proceed with nulls
    const styleName = style?.style_name ?? null;
    const costPrice = style?.cost_price ?? null;
    const costPriceCurrency = style?.cost_price_currency ?? '';
    // Use DB tariff, fallback to file tariff if DB is empty
    const customsTariffNo = style?.customs_tariff_no || fileTariff || '';
    const countryOfOrigin = style?.country_of_origin ?? '';

    // Build output rows
    const outputRows: OutputRow[] = [];
    for (const row of rows) {
      const parsed = parseDate(row.transactionDate);
      const antal = buildAntal(row.type, row.qty);
      const vaerdi = costPrice != null ? costPrice * antal : null;

      outputRows.push({
        row_no: row.rowNo,
        toldref: String(row.customsRef || ''),
        varenr: styleNo,
        varenavn: styleName || '',
        pris: costPrice,
        valuta_original: costPriceCurrency,
        toldtariff: customsTariffNo,
        oprindelsesland: countryOfOrigin,
        ny_toldlager: '',
        dato: parsed?.date ?? '',
        day: parsed?.day ?? 0,
        month: parsed?.month ?? 0,
        year: parsed?.year ?? 0,
        reference: buildReference(row.type, row.delivery),
        ind_ud: buildIndUd(row.type),
        eksport_ref: String(row.exportNo || ''),
        eksport_til: String(row.eu || ''),
        antal,
        vaerdi,
        valuta: costPriceCurrency,
        kurs: '',
        total_dkk_vaerdi: '',
        frafoerselsref: '',
        non_eu: buildNonEu(row.eu),
      });
    }

    // Extract toldref and date range from output rows
    const firstToldref = outputRows.find(r => r.toldref)?.toldref || null;
    const dates = outputRows.map(r => r.dato).filter(d => d && d.length === 10).sort();
    const firstDate = dates[0] || null;
    const lastDate = dates[dates.length - 1] || null;

    // Insert run record
    const { data: runData, error: runError } = await supabase
      .from('finance_correction_runs')
      .insert({
        file_name: fileName || null,
        style_no: styleNo,
        file_customs_tariff: fileTariff || null,
        style_name: styleName,
        cost_price: costPrice,
        cost_price_currency: costPriceCurrency || null,
        customs_tariff_no: customsTariffNo || null,
        country_of_origin: countryOfOrigin || null,
        row_count: outputRows.length,
        toldref: firstToldref,
        first_date: firstDate,
        last_date: lastDate,
      })
      .select('id')
      .single();

    if (runError) {
      console.error('[Correction API] Run insert error:', runError);
      return NextResponse.json({ error: runError.message }, { status: 500 });
    }

    const runId = runData.id;

    // Insert rows in batches
    const batchSize = 500;
    for (let i = 0; i < outputRows.length; i += batchSize) {
      const batch = outputRows.slice(i, i + batchSize).map((r) => ({
        run_id: runId,
        row_no: r.row_no,
        toldref: r.toldref,
        varenr: r.varenr,
        varenavn: r.varenavn,
        pris: r.pris,
        valuta_original: r.valuta_original,
        toldtariff: r.toldtariff,
        oprindelsesland: r.oprindelsesland,
        ny_toldlager: r.ny_toldlager,
        dato: r.dato || null,
        day: r.day,
        month: r.month,
        year: r.year,
        reference: r.reference,
        ind_ud: r.ind_ud,
        eksport_ref: r.eksport_ref,
        eksport_til: r.eksport_til,
        antal: r.antal,
        vaerdi: r.vaerdi,
        valuta: r.valuta,
        kurs: r.kurs,
        total_dkk_vaerdi: r.total_dkk_vaerdi,
        frafoerselsref: r.frafoerselsref,
        non_eu: r.non_eu,
      }));

      const { error: rowsError } = await supabase.from('finance_correction_rows').insert(batch);
      if (rowsError) {
        console.error('[Correction API] Rows insert error:', rowsError);
        return NextResponse.json({ error: rowsError.message }, { status: 500 });
      }
    }

    return NextResponse.json({
      runId,
      rowCount: outputRows.length,
      styleMeta: {
        style_no: styleNo,
        style_name: styleName,
        cost_price: costPrice,
        cost_price_currency: costPriceCurrency,
        customs_tariff_no: customsTariffNo,
        country_of_origin: countryOfOrigin,
      },
      outputRows,
    });
  } catch (error: any) {
    console.error('[Correction API] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

// GET: list recent runs
export async function GET(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    const { data, error } = await supabase
      .from('finance_correction_runs')
      .select('id, created_at, file_name, style_no, style_name, row_count, toldref, first_date, last_date')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[Correction API] List error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ runs: data ?? [] });
  } catch (error: any) {
    console.error('[Correction API] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

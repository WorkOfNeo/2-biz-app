import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

function stableHashExportNos(exportNos: string[]): string {
  // Deterministic hash input. (We keep it simple; uniqueness is "good enough" for our use-case.)
  return exportNos
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .join('|');
}

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const { fileName, styleNo, exportNos } = body as {
      fileName?: string;
      styleNo?: string;
      exportNos: string[];
    };

    if (!Array.isArray(exportNos)) {
      return NextResponse.json({ error: 'exportNos must be an array' }, { status: 400 });
    }

    const unique = Array.from(
      new Set(
        exportNos
          .map((v) => String(v || '').trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));

    if (unique.length === 0) {
      return NextResponse.json({ error: 'No Export No. values found' }, { status: 400 });
    }

    const exportNosHash = stableHashExportNos(unique);

    const { data, error } = await supabase
      .from('finance_correction_export_no_sumups')
      .insert({
        file_name: fileName || null,
        style_no: styleNo || null,
        export_nos: unique,
        export_no_count: unique.length,
        export_nos_hash: exportNosHash,
      })
      .select('id, created_at, file_name, style_no, export_no_count, export_nos')
      .single();

    if (error) {
      // Handle duplicate set inserts gracefully
      if ((error as any)?.code === '23505') {
        const { data: existing } = await supabase
          .from('finance_correction_export_no_sumups')
          .select('id, created_at, file_name, style_no, export_no_count, export_nos')
          .eq('export_nos_hash', exportNosHash)
          .maybeSingle();

        if (existing) {
          return NextResponse.json({ sumup: existing, deduped: true });
        }
      }

      console.error('[ExportNoSumUp API] Insert error:', error);
      return NextResponse.json(
        { error: `Database error: ${error.message}. Have you run the SQL migration 144?` },
        { status: 500 }
      );
    }

    return NextResponse.json({ sumup: data, deduped: false });
  } catch (error: any) {
    console.error('[ExportNoSumUp API] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get('limit') || '10', 10);

    const { data, error } = await supabase
      .from('finance_correction_export_no_sumups')
      .select('id, created_at, file_name, style_no, export_no_count, export_nos')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[ExportNoSumUp API] List error:', error);
      return NextResponse.json(
        { error: `Database error: ${error.message}. Have you run the SQL migration 144?` },
        { status: 500 }
      );
    }

    return NextResponse.json({ sumups: data ?? [] });
  } catch (error: any) {
    console.error('[ExportNoSumUp API] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}


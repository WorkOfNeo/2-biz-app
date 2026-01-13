import type { Page } from 'playwright-core';
import type { JobRow } from '@shared/types';
import React from 'react';
import { pdf, Document, Page as PdfPage, Text, StyleSheet, View, Image } from '@react-pdf/renderer';

/** Scale SPY image URL to specified size for PDF rendering */
function scaleImageUrl(input?: string | null, size = 100): string | null {
  if (!input) return null;
  const token = `s${size}`;
  let next = input.replace(/\/s\d+(?:-[a-z])?\//gi, `/${token}/`);
  next = next.replace(/=s\d+/gi, `=${token}`);
  return next;
}

/** Get formatted timestamp in Copenhagen timezone: DD/MM/YYYY - HH:MM */
function getCopenhagenTimestamp(): string {
  const now = new Date();
  const copenhagenTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Copenhagen' }));
  const dd = copenhagenTime.getDate().toString().padStart(2, '0');
  const mm = (copenhagenTime.getMonth() + 1).toString().padStart(2, '0');
  const yyyy = copenhagenTime.getFullYear();
  const hh = copenhagenTime.getHours().toString().padStart(2, '0');
  const min = copenhagenTime.getMinutes().toString().padStart(2, '0');
  return `${dd}/${mm}/${yyyy} - ${hh}:${min}`;
}

/** Ensure a value is a Node.js Buffer */
async function ensureBuffer(val: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(val)) return val;
  if (val instanceof Uint8Array) return Buffer.from(val);
  if (val instanceof ArrayBuffer) return Buffer.from(val);
  if (typeof val === 'string') return Buffer.from(val, 'utf8');
  // Handle ReadableStream from @react-pdf/renderer
  if (val && typeof val === 'object' && 'pipe' in val) {
    // It's a stream - collect chunks
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      const stream = val as NodeJS.ReadableStream;
      stream.on('data', (chunk: Buffer | Uint8Array) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }
  // Handle blob-like objects
  if (val && typeof val === 'object' && 'arrayBuffer' in val && typeof (val as any).arrayBuffer === 'function') {
    const ab = await (val as any).arrayBuffer();
    return Buffer.from(ab);
  }
  throw new Error(`Cannot convert to Buffer: ${typeof val} ${val?.constructor?.name || 'unknown'}`);
}

type Ctx = {
  job: JobRow;
  page: Page;
  log: (jobId: string, level: 'info' | 'error', msg: string, data?: Record<string, any>) => Promise<void>;
  saveResult: (jobId: string, summary: string, data: Record<string, any>) => Promise<any>;
  setJobFailedOrRequeue: (job: JobRow, errorMsg: string) => Promise<void>;
  setJobSucceeded: (jobId: string) => Promise<void>;
  supabase: any;
};

export async function exportAiAnalysis(ctx: Ctx) {
  const { job, log, saveResult, setJobFailedOrRequeue, setJobSucceeded, supabase } = ctx;
  
  try {
    await log(job.id, 'info', 'STEP:export_ai_analysis_begin', job.payload || {});
    
    const analysisId = (job.payload as any)?.analysisId as string;
    if (!analysisId) {
      throw new Error('Missing analysisId in payload');
    }
    
    // Fetch the analysis
    const { data: analysis, error: analysisError } = await supabase
      .from('ai_season_analyses')
      .select(`
        *,
        season:seasons!ai_season_analyses_season_id_fkey(name, year),
        comparison_season:seasons!ai_season_analyses_comparison_season_id_fkey(name, year)
      `)
      .eq('id', analysisId)
      .single();
    
    if (analysisError || !analysis) {
      throw new Error(`Failed to fetch analysis: ${analysisError?.message || 'Not found'}`);
    }
    
    await log(job.id, 'info', 'STEP:analysis_loaded', { 
      analysisType: analysis.analysis_type,
      seasonId: analysis.season_id 
    });
    
    // Get top style numbers from metrics
    const topStyles = analysis.metrics?.top_styles || [];
    const styleNos = topStyles.slice(0, 10).map((s: any) => s.style_no).filter(Boolean);
    
    // Fetch style info (style_name, image_url)
    let stylesInfo: Record<string, { name: string | null; image_url: string | null }> = {};
    if (styleNos.length > 0) {
      const { data: styles } = await supabase
        .from('styles')
        .select('style_no, style_name, image_url')
        .in('style_no', styleNos);
      
      for (const s of (styles || [])) {
        // Scale image URL for PDF rendering
        const scaledImage = scaleImageUrl(s.image_url);
        stylesInfo[s.style_no] = { name: s.style_name, image_url: scaledImage };
      }
    }
    
    await log(job.id, 'info', 'STEP:styles_loaded', { count: Object.keys(stylesInfo).length });
    
    // Parse executive_summary if stored as JSON string (TEXT column, not JSONB)
    let executiveSummary: string | { headline?: string; bullets?: string[] } | null = analysis.executive_summary;
    if (typeof executiveSummary === 'string' && executiveSummary.startsWith('{')) {
      try {
        executiveSummary = JSON.parse(executiveSummary);
      } catch {
        // Keep as string if parsing fails
      }
    }
    
    // Build the PDF
    const seasonLabel = analysis.season 
      ? `${analysis.season.name}${analysis.season.year ? ' ' + analysis.season.year : ''}`
      : 'Unknown Season';
    const comparisonLabel = analysis.comparison_season
      ? `${analysis.comparison_season.name}${analysis.comparison_season.year ? ' ' + analysis.comparison_season.year : ''}`
      : null;
    
    const analysisDate = new Date(analysis.analysis_date).toLocaleDateString('da-DK', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
    
    const styles = StyleSheet.create({
      page: { padding: 24, fontSize: 10, color: '#0f172a', fontFamily: 'Helvetica' },
      header: { marginBottom: 16 },
      h1: { fontSize: 20, fontWeight: 'bold', marginBottom: 4, color: '#1e293b' },
      h2: { fontSize: 14, fontWeight: 'bold', marginTop: 16, marginBottom: 8, color: '#334155' },
      h3: { fontSize: 12, fontWeight: 'bold', marginTop: 12, marginBottom: 6, color: '#475569' },
      subtitle: { fontSize: 10, color: '#64748b', marginBottom: 8 },
      summaryBox: { 
        backgroundColor: '#f1f5f9', 
        padding: 12, 
        borderRadius: 4, 
        marginBottom: 16,
        borderLeftWidth: 3,
        borderLeftColor: '#6366f1'
      },
      summaryText: { fontSize: 11, lineHeight: 1.5, color: '#334155' },
      metricsRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
      metricCard: { 
        flex: 1, 
        padding: 10, 
        backgroundColor: '#ffffff', 
        borderWidth: 1, 
        borderColor: '#e2e8f0', 
        borderRadius: 4 
      },
      metricLabel: { fontSize: 8, color: '#64748b', marginBottom: 2, textTransform: 'uppercase' },
      metricValue: { fontSize: 16, fontWeight: 'bold', color: '#0f172a' },
      metricUnit: { fontSize: 9, color: '#64748b' },
      tableHeader: { 
        flexDirection: 'row', 
        backgroundColor: '#1e293b', 
        color: '#ffffff', 
        paddingVertical: 6,
        paddingHorizontal: 4
      },
      tableHeaderCell: { fontSize: 8, fontWeight: 'bold', color: '#ffffff' },
      tableRow: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#e2e8f0', paddingVertical: 6, paddingHorizontal: 4 },
      tableRowAlt: { backgroundColor: '#f8fafc' },
      tableCell: { fontSize: 9 },
      styleImage: { width: 30, height: 30, marginRight: 8, borderRadius: 2, backgroundColor: '#f1f5f9' },
      styleInfo: { flex: 1 },
      styleName: { fontSize: 9, fontWeight: 'bold', color: '#0f172a' },
      styleNo: { fontSize: 7, color: '#64748b' },
      warningBox: { 
        backgroundColor: '#fef3c7', 
        padding: 8, 
        borderRadius: 4, 
        marginBottom: 4,
        borderLeftWidth: 3,
        borderLeftColor: '#f59e0b'
      },
      warningText: { fontSize: 9, color: '#92400e' },
      recommendBox: { 
        backgroundColor: '#dcfce7', 
        padding: 8, 
        borderRadius: 4, 
        marginBottom: 4,
        borderLeftWidth: 3,
        borderLeftColor: '#22c55e'
      },
      recommendText: { fontSize: 9, color: '#166534' },
      footer: { 
        position: 'absolute', 
        bottom: 20, 
        left: 24, 
        right: 24, 
        fontSize: 8, 
        color: '#94a3b8',
        flexDirection: 'row',
        justifyContent: 'space-between'
      },
      left: { textAlign: 'left' },
      right: { textAlign: 'right' },
      center: { textAlign: 'center' },
      green: { color: '#16a34a' },
      red: { color: '#dc2626' },
    });
    
    const fmt = (n: number) => new Intl.NumberFormat('da-DK').format(Math.round(n));
    const fmtK = (n: number) => `${(n / 1000).toFixed(0)}K`;
    
    // Helper to create elements
    const E = React.createElement;
    
    // Metrics
    const metrics = analysis.metrics || {};
    const totals = metrics.totals || {};
    const customerCoverage = metrics.customer_coverage || {};
    const velocity = metrics.velocity || {};
    
    // Top 5 styles as grid cards
    const top5Styles = topStyles.slice(0, 5).map((s: any, i: number) => {
      const info = stylesInfo[s.style_no];
      const displayName = info?.name || s.style_name || s.style_no;
      
      return E(View, { 
        key: i, 
        style: { 
          width: '19%', 
          alignItems: 'center',
          padding: 6,
          backgroundColor: '#f8fafc',
          borderRadius: 4,
          marginRight: i < 4 ? '1%' : 0
        } 
      },
        // Large image
        info?.image_url 
          ? E(Image, { src: info.image_url, style: { width: 70, height: 70, borderRadius: 4, marginBottom: 6 } })
          : E(View, { style: { width: 70, height: 70, backgroundColor: '#e2e8f0', borderRadius: 4, marginBottom: 6 } }),
        // Rank badge
        E(View, { style: { position: 'absolute', top: 4, left: 4, width: 16, height: 16, backgroundColor: '#6366f1', borderRadius: 8, alignItems: 'center', justifyContent: 'center' } },
          E(Text, { style: { color: '#ffffff', fontSize: 8, fontWeight: 'bold' } }, String(i + 1))
        ),
        // Name + style no
        E(Text, { style: { fontSize: 8, fontWeight: 'bold', textAlign: 'center', marginBottom: 2, maxLines: 1 } }, displayName.slice(0, 15)),
        E(Text, { style: { fontSize: 6, color: '#64748b', marginBottom: 4 } }, s.style_no),
        // Stats
        E(Text, { style: { fontSize: 10, fontWeight: 'bold', color: '#6366f1' } }, `${fmt(s.total_qty || 0)} stk`),
        E(Text, { style: { fontSize: 6, color: '#64748b' } }, `${s.colors_count || 0} farver • ${s.customer_count || 0} kunder`)
      );
    });
    
    // Salesperson table
    const salespersonTable = metrics.salesperson_table || [];
    const salespersonRows = salespersonTable.map((sp: any, i: number) => {
      const qtyIdx = sp.qty_index ?? sp.index;
      const revIdx = sp.revenue_index;
      const qtyStyle = qtyIdx != null ? (qtyIdx >= 100 ? styles.green : qtyIdx >= 80 ? {} : styles.red) : {};
      const revStyle = revIdx != null ? (revIdx >= 100 ? styles.green : revIdx >= 80 ? {} : styles.red) : {};
      
      return E(View, { 
        key: i, 
        style: [styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}] 
      },
        E(Text, { style: [styles.tableCell, { width: '22%' }] }, sp.salesperson || '-'),
        E(Text, { style: [styles.tableCell, { width: '12%' }, styles.right] }, String(sp.visited_customers || 0)),
        E(Text, { style: [styles.tableCell, { width: '16%' }, styles.right] }, fmt(sp.qty || 0)),
        E(Text, { style: [styles.tableCell, { width: '12%' }, styles.right, qtyStyle] }, qtyIdx != null ? `${qtyIdx}%` : '—'),
        E(Text, { style: [styles.tableCell, { width: '22%' }, styles.right] }, fmt(sp.price || 0)),
        E(Text, { style: [styles.tableCell, { width: '12%' }, styles.right, revStyle] }, revIdx != null ? `${revIdx}%` : '—')
      );
    });
    
    // Build document
    const doc = E(Document, null,
      E(PdfPage, { size: 'A4', style: styles.page },
        // Header
        E(View, { style: styles.header },
          E(Text, { style: styles.h1 }, 
            analysis.analysis_type === 'purchase_round' 
              ? `Indkøbsrunde #${analysis.purchase_round_number || '?'}` 
              : 'Daglig Sæsonanalyse'
          ),
          E(Text, { style: styles.subtitle }, `${seasonLabel} • ${analysisDate}${comparisonLabel ? ` • vs ${comparisonLabel}` : ''}`)
        ),
        
        // Executive Summary - handle both string and object formats
        executiveSummary && E(View, { style: styles.summaryBox },
          typeof executiveSummary === 'string' 
            ? E(Text, { style: styles.summaryText }, executiveSummary)
            : E(View, null,
                // Headline
                executiveSummary.headline && E(Text, { 
                  style: [styles.summaryText, { fontWeight: 'bold', fontSize: 12, marginBottom: 6 }] 
                }, executiveSummary.headline),
                // Bullets
                ...(Array.isArray(executiveSummary.bullets) 
                  ? executiveSummary.bullets.map((bullet: string, i: number) => 
                      E(Text, { key: i, style: [styles.summaryText, { marginBottom: 3 }] }, bullet)
                    )
                  : []
                )
              )
        ),
        
        // Key Metrics
        E(Text, { style: styles.h2 }, 'Nøgletal'),
        E(View, { style: styles.metricsRow },
          E(View, { style: styles.metricCard },
            E(Text, { style: styles.metricLabel }, 'Solgt i alt'),
            E(Text, { style: styles.metricValue }, fmt(totals.qty_sold || 0)),
            E(Text, { style: styles.metricUnit }, 'stk.')
          ),
          E(View, { style: styles.metricCard },
            E(Text, { style: styles.metricLabel }, 'Omsætning'),
            E(Text, { style: styles.metricValue }, fmtK(totals.revenue || 0)),
            E(Text, { style: styles.metricUnit }, 'DKK')
          ),
          E(View, { style: styles.metricCard },
            E(Text, { style: styles.metricLabel }, 'Besøgsrate'),
            E(Text, { style: styles.metricValue }, `${customerCoverage.visit_rate_percent || 0}%`),
            E(Text, { style: styles.metricUnit }, `${customerCoverage.visited_customers || 0} af ${customerCoverage.total_customers || 0}`)
          ),
          E(View, { style: styles.metricCard },
            E(Text, { style: styles.metricLabel }, 'Daglig hastighed'),
            E(Text, { style: styles.metricValue }, String(velocity.avg_daily_qty || 0)),
            E(Text, { style: styles.metricUnit }, 'stk./dag')
          )
        ),
        
        // Salesperson Progress
        salespersonRows.length > 0 && E(View, null,
          E(Text, { style: styles.h2 }, 'Sælger Fremgang'),
          E(View, { style: styles.tableHeader },
            E(Text, { style: [styles.tableHeaderCell, { width: '22%' }] }, 'Sælger'),
            E(Text, { style: [styles.tableHeaderCell, { width: '12%' }, styles.right] }, 'Besøgt'),
            E(Text, { style: [styles.tableHeaderCell, { width: '16%' }, styles.right] }, 'Stk'),
            E(Text, { style: [styles.tableHeaderCell, { width: '12%' }, styles.right] }, 'Stk Idx'),
            E(Text, { style: [styles.tableHeaderCell, { width: '22%' }, styles.right] }, 'Omsætning'),
            E(Text, { style: [styles.tableHeaderCell, { width: '12%' }, styles.right] }, 'Oms Idx')
          ),
          ...salespersonRows
        ),
        
        // Top 5 Selling Styles - Grid layout
        top5Styles.length > 0 && E(View, null,
          E(Text, { style: styles.h2 }, 'Top 5 Bedst Sælgende Styles'),
          E(View, { style: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 } },
            ...top5Styles
          )
        ),
        
        // Footer
        E(View, { style: styles.footer },
          E(Text, null, `Genereret: ${getCopenhagenTimestamp()}`),
          E(Text, null, '2-BIZ AI Analyse')
        )
      )
    );
    
    await log(job.id, 'info', 'STEP:generating_pdf', { 
      hasSummary: !!analysis.executive_summary,
      summaryType: typeof analysis.executive_summary,
      topStylesCount: topStylesRows.length,
      salespersonCount: salespersonRows.length
    });
    
    let pdfOut: unknown;
    try {
      pdfOut = await pdf(doc).toBuffer();
      await log(job.id, 'info', 'STEP:pdf_rendered', { 
        outputType: typeof pdfOut,
        constructorName: pdfOut?.constructor?.name || 'unknown'
      });
    } catch (renderErr: any) {
      await log(job.id, 'error', 'STEP:pdf_render_failed', { error: renderErr?.message || String(renderErr) });
      throw renderErr;
    }
    
    const pdfBuf = await ensureBuffer(pdfOut);
    await log(job.id, 'info', 'STEP:buffer_created', { bufferSize: pdfBuf.length });
    
    // Upload to storage
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `ai-analysis-${analysis.analysis_type}-${dateStr}.pdf`;
    const path = `ai-analysis/${job.id}/${filename}`;
    
    try {
      const ab = pdfBuf.buffer.slice(pdfBuf.byteOffset, pdfBuf.byteOffset + pdfBuf.byteLength);
      await supabase.storage.from('exports').upload(path, ab as ArrayBuffer, { 
        contentType: 'application/pdf', 
        upsert: true 
      });
    } catch (uploadErr: any) {
      await log(job.id, 'error', 'STEP:upload_failed', { error: uploadErr.message });
    }
    
    let publicUrl: string | null = null;
    try { 
      const { data: pub } = supabase.storage.from('exports').getPublicUrl(path); 
      publicUrl = pub?.publicUrl ?? null; 
    } catch {}
    
    // Record in exports table
    try { 
      await supabase.from('exports').insert({ 
        kind: 'ai_analysis_pdf', 
        title: `AI Analysis - ${seasonLabel}`, 
        path, 
        public_url: publicUrl, 
        job_id: job.id, 
        meta: { analysisId, analysisType: analysis.analysis_type },
        comment: null 
      }); 
    } catch {}
    
    // Update the analysis with the PDF URL
    try {
      await supabase
        .from('ai_season_analyses')
        .update({ pdf_url: publicUrl })
        .eq('id', analysisId);
    } catch {}
    
    await log(job.id, 'info', 'STEP:export_ai_analysis_complete', { path, publicUrl });
    await saveResult(job.id, 'export_ai_analysis', { file: { path, publicUrl } });
    await setJobSucceeded(job.id);
    
  } catch (e: any) {
    await log(job.id, 'error', 'STEP:export_ai_analysis_failed', { error: e?.message || String(e) });
    await setJobFailedOrRequeue(job, e?.message || 'Export failed');
  }
}

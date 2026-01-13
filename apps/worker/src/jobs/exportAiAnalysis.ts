import type { Page } from 'playwright-core';
import type { JobRow } from '@shared/types';
import React from 'react';
import { pdf, Document, Page as PdfPage, Text, StyleSheet, View, Image } from '@react-pdf/renderer';

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
  throw new Error('Cannot convert to Buffer');
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
    
    // Fetch style info (name, image_url)
    let stylesInfo: Record<string, { name: string | null; image_url: string | null }> = {};
    if (styleNos.length > 0) {
      const { data: styles } = await supabase
        .from('styles')
        .select('style_no, name, image_url')
        .in('style_no', styleNos);
      
      for (const s of (styles || [])) {
        stylesInfo[s.style_no] = { name: s.name, image_url: s.image_url };
      }
    }
    
    await log(job.id, 'info', 'STEP:styles_loaded', { count: Object.keys(stylesInfo).length });
    
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
    
    // Top styles rows with images
    const topStylesRows = topStyles.slice(0, 10).map((s: any, i: number) => {
      const info = stylesInfo[s.style_no];
      const displayName = info?.name || s.style_name || s.style_no;
      
      return E(View, { 
        key: i, 
        style: [styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}] 
      },
        // Image + Name column
        E(View, { style: { width: '40%', flexDirection: 'row', alignItems: 'center' } },
          info?.image_url 
            ? E(Image, { src: info.image_url, style: styles.styleImage })
            : E(View, { style: styles.styleImage }),
          E(View, { style: styles.styleInfo },
            E(Text, { style: styles.styleName }, displayName),
            E(Text, { style: styles.styleNo }, s.style_no)
          )
        ),
        E(Text, { style: [styles.tableCell, { width: '20%' }, styles.right] }, fmt(s.total_qty || 0)),
        E(Text, { style: [styles.tableCell, { width: '20%' }, styles.right] }, String(s.colors_count || '-')),
        E(Text, { style: [styles.tableCell, { width: '20%' }, styles.right] }, String(s.customer_count || '-'))
      );
    });
    
    // Salesperson table
    const salespersonTable = metrics.salesperson_table || [];
    const salespersonRows = salespersonTable.map((sp: any, i: number) => {
      const indexStyle = sp.index != null 
        ? (sp.index >= 100 ? styles.green : sp.index >= 80 ? {} : styles.red)
        : {};
      
      return E(View, { 
        key: i, 
        style: [styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}] 
      },
        E(Text, { style: [styles.tableCell, { width: '30%' }] }, sp.salesperson || '-'),
        E(Text, { style: [styles.tableCell, { width: '15%' }, styles.right] }, String(sp.visited_customers || 0)),
        E(Text, { style: [styles.tableCell, { width: '20%' }, styles.right] }, fmt(sp.qty || 0)),
        E(Text, { style: [styles.tableCell, { width: '20%' }, styles.right] }, fmt(sp.price || 0)),
        E(Text, { style: [styles.tableCell, { width: '15%' }, styles.right, indexStyle] }, 
          sp.index != null ? `${sp.index}%` : '—'
        )
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
        analysis.executive_summary && E(View, { style: styles.summaryBox },
          typeof analysis.executive_summary === 'string' 
            ? E(Text, { style: styles.summaryText }, analysis.executive_summary)
            : E(View, null,
                // Headline
                analysis.executive_summary.headline && E(Text, { 
                  style: [styles.summaryText, { fontWeight: 'bold', fontSize: 12, marginBottom: 6 }] 
                }, analysis.executive_summary.headline),
                // Bullets
                ...(Array.isArray(analysis.executive_summary.bullets) 
                  ? analysis.executive_summary.bullets.map((bullet: string, i: number) => 
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
            E(Text, { style: [styles.tableHeaderCell, { width: '30%' }] }, 'Sælger'),
            E(Text, { style: [styles.tableHeaderCell, { width: '15%' }, styles.right] }, 'Besøgt'),
            E(Text, { style: [styles.tableHeaderCell, { width: '20%' }, styles.right] }, 'Antal'),
            E(Text, { style: [styles.tableHeaderCell, { width: '20%' }, styles.right] }, 'Pris'),
            E(Text, { style: [styles.tableHeaderCell, { width: '15%' }, styles.right] }, 'Index')
          ),
          ...salespersonRows
        ),
        
        // Top Selling Styles
        topStylesRows.length > 0 && E(View, null,
          E(Text, { style: styles.h2 }, 'Bedst Sælgende Styles'),
          E(View, { style: styles.tableHeader },
            E(Text, { style: [styles.tableHeaderCell, { width: '40%' }] }, 'Style'),
            E(Text, { style: [styles.tableHeaderCell, { width: '20%' }, styles.right] }, 'Solgt'),
            E(Text, { style: [styles.tableHeaderCell, { width: '20%' }, styles.right] }, 'Farver'),
            E(Text, { style: [styles.tableHeaderCell, { width: '20%' }, styles.right] }, 'Kunder')
          ),
          ...topStylesRows
        ),
        
        // Footer
        E(View, { style: styles.footer },
          E(Text, null, `Genereret: ${getCopenhagenTimestamp()}`),
          E(Text, null, '2-BIZ AI Analyse')
        )
      ),
      
      // Page 2: Warnings & Recommendations
      ((analysis.warnings && analysis.warnings.length > 0) || (analysis.recommendations && analysis.recommendations.length > 0)) &&
      E(PdfPage, { size: 'A4', style: styles.page },
        // Warnings
        analysis.warnings && analysis.warnings.length > 0 && E(View, null,
          E(Text, { style: styles.h2 }, '⚠️ Advarsler'),
          ...analysis.warnings.map((w: string, i: number) => 
            E(View, { key: i, style: styles.warningBox },
              E(Text, { style: styles.warningText }, w)
            )
          )
        ),
        
        // Recommendations
        analysis.recommendations && analysis.recommendations.length > 0 && E(View, null,
          E(Text, { style: styles.h2 }, '💡 Anbefalinger'),
          ...analysis.recommendations.map((r: string, i: number) =>
            E(View, { key: i, style: styles.recommendBox },
              E(Text, { style: styles.recommendText }, r)
            )
          )
        ),
        
        // Footer
        E(View, { style: styles.footer },
          E(Text, null, `Genereret: ${getCopenhagenTimestamp()}`),
          E(Text, null, '2-BIZ AI Analyse')
        )
      )
    );
    
    await log(job.id, 'info', 'STEP:generating_pdf');
    
    const pdfOut = await pdf(doc).toBuffer();
    const pdfBuf = await ensureBuffer(pdfOut);
    
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

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
  if (val && typeof val === 'object' && 'pipe' in val) {
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

export async function exportPurchaseRoundPdf(ctx: Ctx) {
  const { job, log, setJobFailedOrRequeue, setJobSucceeded, supabase } = ctx;
  
  try {
    await log(job.id, 'info', 'STEP:export_purchase_round_begin', job.payload || {});
    
    const purchaseRunId = (job.payload as any)?.purchaseRunId as string;
    if (!purchaseRunId) {
      throw new Error('Missing purchaseRunId in payload');
    }
    
    // Fetch the purchase run
    const { data: purchaseRun, error: runError } = await supabase
      .from('purchase_ai_runs')
      .select(`
        id, season_id, run_label, run_number, status,
        purchase_stage, prompt_key, prompt_version, model,
        supplier_suggestions, computed_features_snapshot,
        run_started_at, run_completed_at, created_at
      `)
      .eq('id', purchaseRunId)
      .single();
    
    if (runError || !purchaseRun) {
      throw new Error(`Failed to fetch purchase run: ${runError?.message || 'Not found'}`);
    }

    // Fetch season info
    const { data: season } = await supabase
      .from('seasons')
      .select('name, year')
      .eq('id', purchaseRun.season_id)
      .single();
    
    await log(job.id, 'info', 'STEP:purchase_run_loaded', { 
      status: purchaseRun.status,
      stage: purchaseRun.purchase_stage,
      suppliersCount: purchaseRun.supplier_suggestions?.length || 0
    });
    
    // Get all unique style_nos
    const styleNos: string[] = [];
    for (const supplier of purchaseRun.supplier_suggestions || []) {
      for (const style of supplier.styles || []) {
        if (style.style_no && !styleNos.includes(style.style_no)) {
          styleNos.push(style.style_no);
        }
      }
    }
    
    // Fetch style images
    let stylesInfo: Record<string, { name: string | null; image_url: string | null }> = {};
    if (styleNos.length > 0) {
      const { data: styles } = await supabase
        .from('styles')
        .select('style_no, style_name, image_url')
        .in('style_no', styleNos.slice(0, 100));
      
      const { data: colorImages } = await supabase
        .from('style_colors')
        .select('style_id, image_url, styles!inner(style_no)')
        .not('image_url', 'is', null);
      
      const colorImageMap: Record<string, string> = {};
      for (const c of (colorImages || [])) {
        const styleNo = (c.styles as any)?.style_no;
        if (styleNo && c.image_url && !colorImageMap[styleNo]) {
          colorImageMap[styleNo] = c.image_url;
        }
      }
      
      for (const s of (styles || [])) {
        const imageUrl = s.image_url || colorImageMap[s.style_no] || null;
        const scaledImage = scaleImageUrl(imageUrl);
        stylesInfo[s.style_no] = { name: s.style_name, image_url: scaledImage };
      }
    }
    
    await log(job.id, 'info', 'STEP:styles_loaded', { 
      count: Object.keys(stylesInfo).length,
      withImages: Object.values(stylesInfo).filter(s => s.image_url).length 
    });
    
    // Build the PDF
    const seasonLabel = season 
      ? `${season.name}${season.year ? ' ' + season.year : ''}`
      : 'Unknown Season';
    
    const runDate = new Date(purchaseRun.created_at).toLocaleDateString('da-DK', {
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
        borderLeftColor: '#10b981'
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
      supplierHeader: { 
        backgroundColor: '#1e293b', 
        color: '#ffffff', 
        padding: 8,
        marginTop: 12,
        marginBottom: 4,
        borderRadius: 4,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center'
      },
      supplierName: { fontSize: 12, fontWeight: 'bold', color: '#ffffff' },
      supplierMeta: { fontSize: 9, color: '#94a3b8' },
      styleRow: { 
        flexDirection: 'row', 
        borderBottomWidth: 0.5, 
        borderBottomColor: '#e2e8f0', 
        paddingVertical: 6, 
        paddingHorizontal: 4,
        alignItems: 'center'
      },
      styleRowAlt: { backgroundColor: '#f8fafc' },
      styleImage: { width: 24, height: 24, marginRight: 8, borderRadius: 2, backgroundColor: '#f1f5f9' },
      styleInfo: { flex: 1 },
      styleName: { fontSize: 9, fontWeight: 'bold', color: '#0f172a' },
      styleNo: { fontSize: 7, color: '#64748b' },
      styleQty: { fontSize: 11, fontWeight: 'bold', color: '#0f172a', textAlign: 'right', minWidth: 50 },
      sizeBreakdownRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 2, gap: 4 },
      sizeBox: { 
        flexDirection: 'row', 
        backgroundColor: '#f1f5f9', 
        borderRadius: 2, 
        paddingHorizontal: 4, 
        paddingVertical: 1,
        marginRight: 4,
        marginBottom: 2
      },
      sizeLabel: { fontSize: 6, color: '#64748b', marginRight: 2 },
      sizeQty: { fontSize: 6, fontWeight: 'bold', color: '#0f172a' },
      // Size Analysis Table
      sizeTable: { marginTop: 6, marginLeft: 32, marginBottom: 4, borderWidth: 0.5, borderColor: '#cbd5e1' },
      sizeTableHeader: { flexDirection: 'row', backgroundColor: '#f1f5f9', borderBottomWidth: 0.5, borderBottomColor: '#cbd5e1' },
      sizeTableRow: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#e2e8f0' },
      sizeTableCell: { flex: 1, padding: 3, fontSize: 6, textAlign: 'center' },
      sizeTableLabelCell: { width: 50, padding: 3, fontSize: 6, fontWeight: 'bold', backgroundColor: '#f8fafc', textAlign: 'left' },
      sizeTableHeaderCell: { flex: 1, padding: 3, fontSize: 6, fontWeight: 'bold', color: '#475569', textAlign: 'center' },
      sizeTableTotalCell: { flex: 1, padding: 3, fontSize: 6, fontWeight: 'bold', backgroundColor: '#f1f5f9', textAlign: 'center' },
      netNeedRow: { backgroundColor: '#fef3c7' },
      suggestionRow: { backgroundColor: '#dbeafe' },
      badge: { 
        paddingHorizontal: 4, 
        paddingVertical: 2, 
        borderRadius: 3, 
        marginLeft: 8 
      },
      badgeGreen: { backgroundColor: '#dcfce7' },
      badgeAmber: { backgroundColor: '#fef3c7' },
      badgeRed: { backgroundColor: '#fee2e2' },
      badgeBlue: { backgroundColor: '#dbeafe' },
      badgeText: { fontSize: 7, fontWeight: 'bold' },
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
      green: { color: '#16a34a' },
      red: { color: '#dc2626' },
      amber: { color: '#d97706' },
      blue: { color: '#2563eb' },
    });
    
    const fmt = (n: number) => new Intl.NumberFormat('da-DK').format(Math.round(n));
    const E = React.createElement;
    
    // Calculate totals
    let totalQty = 0;
    let totalStyles = 0;
    for (const supplier of purchaseRun.supplier_suggestions || []) {
      for (const style of supplier.styles || []) {
        totalQty += style.suggested_qty_total || 0;
        totalStyles++;
      }
    }
    
    // Build supplier sections
    const supplierSections = (purchaseRun.supplier_suggestions || []).map((supplier: any, si: number) => {
      const supplierTotal = (supplier.styles || []).reduce((sum: number, s: any) => sum + (s.suggested_qty_total || 0), 0);
      
      const styleRows = (supplier.styles || []).map((style: any, idx: number) => {
        const info = stylesInfo[style.style_no];
        const displayName = info?.name || style.style_name || style.style_no;
        
        // Build size breakdown display
        const sizes: string[] = style.sizes || [];
        const sizeBreakdown: number[] = style.size_breakdown || [];
        
        // Check if we have size_level_details for detailed table
        const sizeLevelDetails = style.size_level_details;
        let sizeTable = null;
        
        if (sizeLevelDetails && sizes.length > 0) {
          // Calculate totals
          const soldTotal = sizes.reduce((sum, size) => sum + (sizeLevelDetails.sold_by_size[size] || 0), 0);
          const poTotal = sizes.reduce((sum, size) => sum + (sizeLevelDetails.po_by_size[size] || 0), 0);
          const stockTotal = sizes.reduce((sum, size) => sum + (sizeLevelDetails.stock_by_size[size] || 0), 0);
          const netNeedTotal = sizes.reduce((sum, size) => sum + (sizeLevelDetails.net_need_by_size[size] || 0), 0);
          const suggestedTotal = sizeBreakdown.reduce((a, b) => a + b, 0);
          
          sizeTable = E(View, { style: styles.sizeTable },
            // Header row
            E(View, { style: styles.sizeTableHeader },
              E(Text, { style: styles.sizeTableLabelCell }, 'Metric'),
              ...sizes.map((size, si) => E(Text, { key: `h-${si}`, style: styles.sizeTableHeaderCell }, size)),
              E(Text, { style: [styles.sizeTableHeaderCell, { fontWeight: 'extrabold' }] }, 'Total')
            ),
            // Sold row
            E(View, { style: styles.sizeTableRow },
              E(Text, { style: styles.sizeTableLabelCell }, 'Sold'),
              ...sizes.map((size, si) => E(Text, { key: `s-${si}`, style: styles.sizeTableCell }, fmt(sizeLevelDetails.sold_by_size[size] || 0))),
              E(Text, { style: styles.sizeTableTotalCell }, fmt(soldTotal))
            ),
            // Open POs row
            E(View, { style: styles.sizeTableRow },
              E(Text, { style: styles.sizeTableLabelCell }, 'Open POs'),
              ...sizes.map((size, si) => E(Text, { key: `po-${si}`, style: styles.sizeTableCell }, fmt(sizeLevelDetails.po_by_size[size] || 0))),
              E(Text, { style: styles.sizeTableTotalCell }, fmt(poTotal))
            ),
            // Stock row
            E(View, { style: styles.sizeTableRow },
              E(Text, { style: styles.sizeTableLabelCell }, 'Stock'),
              ...sizes.map((size, si) => E(Text, { key: `st-${si}`, style: styles.sizeTableCell }, fmt(sizeLevelDetails.stock_by_size[size] || 0))),
              E(Text, { style: styles.sizeTableTotalCell }, fmt(stockTotal))
            ),
            // Net Need row (highlighted)
            E(View, { style: [styles.sizeTableRow, styles.netNeedRow] },
              E(Text, { style: [styles.sizeTableLabelCell, { fontWeight: 'extrabold' }] }, 'Net Need'),
              ...sizes.map((size, si) => E(Text, { key: `nn-${si}`, style: [styles.sizeTableCell, { fontWeight: 'bold' }] }, fmt(sizeLevelDetails.net_need_by_size[size] || 0))),
              E(Text, { style: [styles.sizeTableTotalCell, { fontWeight: 'extrabold' }] }, fmt(netNeedTotal))
            ),
            // Suggestion row (highlighted)
            E(View, { style: [styles.sizeTableRow, styles.suggestionRow] },
              E(Text, { style: [styles.sizeTableLabelCell, { fontWeight: 'extrabold' }] }, 'Suggestion'),
              ...sizes.map((size, si) => E(Text, { key: `sg-${si}`, style: [styles.sizeTableCell, { fontWeight: 'extrabold' }] }, fmt(sizeBreakdown[si] || 0))),
              E(Text, { style: [styles.sizeTableTotalCell, { fontWeight: 'extrabold' }] }, fmt(suggestedTotal))
            )
          );
        } else {
          // Fallback: simple size breakdown boxes
          const sizeElements = sizes.map((size: string, sIdx: number) => {
            const qty = sizeBreakdown[sIdx] || 0;
            if (qty === 0) return null;
            return E(View, { key: sIdx, style: styles.sizeBox },
              E(Text, { style: styles.sizeLabel }, size),
              E(Text, { style: styles.sizeQty }, String(qty))
            );
          }).filter(Boolean);
          
          if (sizeElements.length > 0) {
            sizeTable = E(View, { style: styles.sizeBreakdownRow }, ...sizeElements);
          }
        }
        
        return E(View, { 
          key: idx, 
          style: [styles.styleRow, idx % 2 === 1 ? styles.styleRowAlt : {}],
          wrap: false
        },
          info?.image_url 
            ? E(Image, { src: info.image_url, style: styles.styleImage })
            : E(View, { style: styles.styleImage }),
          E(View, { style: styles.styleInfo },
            E(Text, { style: styles.styleName }, `${displayName} - ${style.color}`),
            E(Text, { style: styles.styleNo }, 
              `${style.style_no} • Solgt: ${fmt(style.sold_qty || 0)} • Lager: ${fmt(style.current_stock || 0)} • ${style.active_salespeople_count || 0} sælgere`
            ),
            sizeTable
          ),
          E(Text, { style: styles.styleQty }, `${fmt(style.suggested_qty_total || 0)} stk`)
        );
      });
      
      const decisionColor = supplier.decision === 'buy' ? styles.green : 
                           supplier.decision === 'skip' ? styles.red : styles.blue;
      const decisionText = supplier.decision === 'buy' ? 'KØB' : 
                          supplier.decision === 'skip' ? 'SPRING OVER' : 'VENT';
      
      return E(View, { key: si, wrap: false },
        E(View, { style: styles.supplierHeader },
          E(View, {},
            E(Text, { style: styles.supplierName }, supplier.supplier),
            E(Text, { style: styles.supplierMeta }, 
              `${(supplier.styles || []).length} styles • MOQ: ${fmt(supplier.moq || 0)} • Lead: ${supplier.lead_time_days || 0}d + ${supplier.travel_time_days || 0}d`
            )
          ),
          E(View, { style: { alignItems: 'flex-end' } },
            E(Text, { style: [{ fontSize: 14, fontWeight: 'bold', color: '#ffffff' }] }, `${fmt(supplierTotal)} stk`),
            E(Text, { style: [{ fontSize: 9 }, decisionColor] }, decisionText)
          )
        ),
        ...styleRows
      );
    });
    
    const stageLabel = purchaseRun.purchase_stage === 'early' ? 'Tidlig fase' :
                       purchaseRun.purchase_stage === 'mid' ? 'Midt fase' : 
                       purchaseRun.purchase_stage === 'closing' ? 'Afsluttende fase' : '';
    
    const doc = E(Document, {},
      E(PdfPage, { size: 'A4', style: styles.page },
        // Header
        E(View, { style: styles.header },
          E(Text, { style: styles.h1 }, `Indkøbsrunde - ${seasonLabel}`),
          E(Text, { style: styles.subtitle }, 
            `${runDate} • ${stageLabel} • Prompt: ${purchaseRun.prompt_key || 'N/A'} v${purchaseRun.prompt_version || 1}`
          )
        ),
        
        // Summary metrics
        E(View, { style: styles.metricsRow },
          E(View, { style: styles.metricCard },
            E(Text, { style: styles.metricLabel }, 'Leverandører'),
            E(Text, { style: styles.metricValue }, String((purchaseRun.supplier_suggestions || []).length))
          ),
          E(View, { style: styles.metricCard },
            E(Text, { style: styles.metricLabel }, 'Styles'),
            E(Text, { style: styles.metricValue }, String(totalStyles))
          ),
          E(View, { style: styles.metricCard },
            E(Text, { style: styles.metricLabel }, 'Total Stk'),
            E(Text, { style: styles.metricValue }, fmt(totalQty))
          )
        ),
        
        // Supplier sections
        ...supplierSections,
        
        // Footer
        E(View, { style: styles.footer },
          E(Text, {}, `Generated: ${getCopenhagenTimestamp()}`),
          E(Text, {}, '2-BIZ AI Purchase Round')
        )
      )
    );
    
    await log(job.id, 'info', 'STEP:pdf_rendering');
    
    // Render to buffer
    const pdfStream = await pdf(doc).toBuffer();
    const pdfBuffer = await ensureBuffer(pdfStream);
    
    await log(job.id, 'info', 'STEP:pdf_rendered', { sizeBytes: pdfBuffer.length });
    
    // Upload to Supabase Storage
    const fileName = `purchase-round-${purchaseRunId}-${Date.now()}.pdf`;
    const storagePath = `ai-analysis/${fileName}`;
    
    const { error: uploadError } = await supabase.storage
      .from('exports')
      .upload(storagePath, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true
      });
    
    if (uploadError) {
      throw new Error(`Failed to upload PDF: ${uploadError.message}`);
    }
    
    // Get public URL
    const { data: urlData } = supabase.storage
      .from('exports')
      .getPublicUrl(storagePath);
    
    const pdfUrl = urlData?.publicUrl;
    
    await log(job.id, 'info', 'STEP:pdf_uploaded', { pdfUrl });
    
    // Update purchase_ai_runs with pdf_url
    await supabase
      .from('purchase_ai_runs')
      .update({ pdf_url: pdfUrl })
      .eq('id', purchaseRunId);
    
    await setJobSucceeded(job.id);
    await log(job.id, 'info', 'STEP:export_purchase_round_complete', { pdfUrl });
    
  } catch (err: any) {
    await log(job.id, 'error', 'STEP:export_purchase_round_error', { error: err.message });
    await setJobFailedOrRequeue(job, err.message || 'Export failed');
  }
}

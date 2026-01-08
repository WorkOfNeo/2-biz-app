'use client';
import React from 'react';
import { useParams, useRouter } from 'next/navigation';
import useSWR from 'swr';
import { supabase } from '../../../../lib/supabaseClient';
import { Card, CardContent, CardHeader, CardTitle } from '../../../../components/ui/card';
import { Input } from '../../../../components/ui/input';
import { Button } from '../../../../components/ui/button';
import { Badge } from '../../../../components/ui/badge';
import { SearchSelect } from '../../../../components/SearchSelect';
import { Trash2, Check, FileText, FileSpreadsheet, Download, Mail, Send, RefreshCw, MessageSquare } from 'lucide-react';

type AppPo = {
  id: number;
  po_no: string;
  spy_po_no: string | null;
  status: string;
  supplier: string | null;
  styles: number | null;
  ordered: number | null;
  shipped: number | null;
  etd: string | null;
  eta: string | null;
  meta: any;
  created_at: string;
  updated_at: string;
  confirmed: boolean;
};

type OrderItem = {
  style_no: string;
  color: string;
  quantities: number[];
  total: number;
};

type StockRow = {
  style_no: string;
  color: string;
  sizes: string[];
  section: string;
  row_label: string | null;
  values: number[];
  scraped_at: string;
};

type StyleMeta = {
  style_no: string;
  style_name: string | null;
  supplier: string | null;
  image_url: string | null;
};

type OtherPoItem = {
  po_no: string;
  quantities: number[];
};

export default function AppPoDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  // Modal state
  const [showModal, setShowModal] = React.useState(false);
  const [modalStep, setModalStep] = React.useState<1 | 2>(1);
  const [selectedSeason, setSelectedSeason] = React.useState<string>('');
  const [jobId, setJobId] = React.useState<number | null>(null);
  const [jobProgress, setJobProgress] = React.useState(0);
  const [jobStatus, setJobStatus] = React.useState('');
  const [jobError, setJobError] = React.useState('');
  const [isComplete, setIsComplete] = React.useState(false);
  const [spyPoNumber, setSpyPoNumber] = React.useState('');
  
  // Sync state
  const [isSyncing, setIsSyncing] = React.useState(false);
  const [syncJobId, setSyncJobId] = React.useState<string | null>(null);
  const [syncProgress, setSyncProgress] = React.useState(0);
  const [syncStatus, setSyncStatus] = React.useState('');
  const [syncError, setSyncError] = React.useState('');
  const [syncComplete, setSyncComplete] = React.useState(false);
  
  // Action dialogs
  const [showDeleteDialog, setShowDeleteDialog] = React.useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isConfirming, setIsConfirming] = React.useState(false);
  const [showPoNotFoundDialog, setShowPoNotFoundDialog] = React.useState(false);
  const [isRemovingSpyPo, setIsRemovingSpyPo] = React.useState(false);

  // Conversation state
  const [showDraftModal, setShowDraftModal] = React.useState(false);
  const [draftType, setDraftType] = React.useState<'initial' | 'followup_2weeks' | 'followup_1week' | 'followup_etd'>('initial');
  const [draftSubject, setDraftSubject] = React.useState('');
  const [draftBody, setDraftBody] = React.useState('');
  const [draftBodyHtml, setDraftBodyHtml] = React.useState('');
  const [supplierEmail, setSupplierEmail] = React.useState('');
  const [isGeneratingDraft, setIsGeneratingDraft] = React.useState(false);
  const [isSendingEmail, setIsSendingEmail] = React.useState(false);
  const [emailPreviewMode, setEmailPreviewMode] = React.useState(false);

  const { data: po, error, isLoading, mutate: mutatePo } = useSWR(
    id ? ['app-po', id] : null,
    async () => {
      const { data, error } = await supabase
        .from('app_pos')
        .select('*')
        .eq('id', id)
        .single();
      
      if (error) throw error;
      return data as AppPo;
    }
  );

  // Fetch seasons for dropdown (include NOOS and exclude hidden)
  const { data: seasons } = useSWR(
    'seasons:push-order',
    async () => {
      const { data, error } = await supabase
        .from('seasons')
        .select('id, name, year, hidden')
        .or('hidden.is.null,hidden.eq.false')
        .order('year', { ascending: false, nullsFirst: true })
        .order('name', { ascending: false });
      
      if (error) throw error;
      return data as Array<{ id: string; name: string; year: number | null; hidden?: boolean }>;
    }
  );

  // Format seasons for SearchSelect
  const seasonItems = React.useMemo(() => {
    if (!seasons) return [];
    
    return seasons.map((season) => {
      return {
        value: season.id,
        label: season.name,
        description: season.year ? `Year ${season.year}` : undefined
      };
    });
  }, [seasons]);

  // Fetch supplier data for ETD/ETA calculation
  const { data: supplierData } = useSWR(
    po?.supplier ? ['supplier:lead-times', po.supplier] : null,
    async () => {
      const { data, error } = await supabase
        .from('suppliers')
        .select('id, name, lead_time_days, travel_time_days, notes')
        .eq('name', po!.supplier)
        .maybeSingle();
      if (error) console.error('Error fetching supplier:', error);
      return data as { id: string; name: string; lead_time_days: number; travel_time_days: number; notes?: string } | null;
    }
  );

  // Fetch conversation for this PO
  const { data: conversation, mutate: mutateConversation } = useSWR(
    id ? ['conversation', id] : null,
    async () => {
      const { data: conv, error: convError } = await supabase
        .from('conversations')
        .select('*')
        .eq('app_po_id', id)
        .maybeSingle();
      
      if (convError) {
        console.error('Error fetching conversation:', convError);
        return null;
      }
      
      if (!conv) return null;

      // Get messages for this conversation
      const { data: messages } = await supabase
        .from('conversation_messages')
        .select('*')
        .eq('conversation_id', conv.id)
        .order('sent_at', { ascending: true });

      return {
        ...conv,
        messages: messages || [],
      };
    }
  );

  // ETD/ETA state - initialize from po or calculate from supplier
  const [etdInput, setEtdInput] = React.useState('');
  const [etaInput, setEtaInput] = React.useState('');
  const [isSavingDates, setIsSavingDates] = React.useState(false);

  // Calculate default dates from supplier lead times
  React.useEffect(() => {
    if (!po) return;
    
    // If po already has ETD/ETA, use those
    if (po.etd) {
      setEtdInput(po.etd.split('T')[0] || '');
    } else if (supplierData?.lead_time_days) {
      // Calculate default ETD from supplier lead time
      const today = new Date();
      const etdDate = new Date(today);
      etdDate.setDate(today.getDate() + supplierData.lead_time_days);
      setEtdInput(etdDate.toISOString().split('T')[0] || '');
    }
    
    if (po.eta) {
      setEtaInput(po.eta.split('T')[0] || '');
    } else if (supplierData?.lead_time_days && supplierData?.travel_time_days) {
      // Calculate default ETA from ETD + travel time
      const today = new Date();
      const etdDate = new Date(today);
      etdDate.setDate(today.getDate() + supplierData.lead_time_days);
      const etaDate = new Date(etdDate);
      etaDate.setDate(etdDate.getDate() + supplierData.travel_time_days);
      setEtaInput(etaDate.toISOString().split('T')[0] || '');
    }
  }, [po?.etd, po?.eta, supplierData]);

  // Save ETD/ETA to database
  const handleSaveDates = async () => {
    if (!po) return;
    setIsSavingDates(true);
    try {
      const { error } = await supabase
        .from('app_pos')
        .update({ 
          etd: etdInput || null, 
          eta: etaInput || null 
        })
        .eq('id', po.id);
      if (error) throw error;
      mutatePo();
    } catch (err: any) {
      console.error('Failed to save dates:', err);
      alert('Failed to save dates: ' + err.message);
    } finally {
      setIsSavingDates(false);
    }
  };

  // Check if dates have changed
  const datesChanged = React.useMemo(() => {
    const currentEtd = po?.etd?.split('T')[0] || '';
    const currentEta = po?.eta?.split('T')[0] || '';
    return etdInput !== currentEtd || etaInput !== currentEta;
  }, [po?.etd, po?.eta, etdInput, etaInput]);

  // Generate email draft
  const handleGenerateDraft = async (type: 'initial' | 'followup_2weeks' | 'followup_1week' | 'followup_etd') => {
    if (!po) return;
    setDraftType(type);
    setIsGeneratingDraft(true);
    setShowDraftModal(true);
    setDraftSubject('');
    setDraftBody('');
    setDraftBodyHtml('');
    setEmailPreviewMode(false);

    try {
      const res = await fetch('/api/conversations/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_po_id: po.id, type }),
      });
      const data = await res.json();
      
      if (data.success && data.draft) {
        setDraftSubject(data.draft.subject);
        setDraftBody(data.draft.body_text);
        setDraftBodyHtml(data.draft.body_html);
      } else {
        throw new Error(data.error || 'Failed to generate draft');
      }
    } catch (err: any) {
      console.error('Failed to generate draft:', err);
      alert('Failed to generate draft: ' + err.message);
      setShowDraftModal(false);
    } finally {
      setIsGeneratingDraft(false);
    }
  };

  // Send email
  const handleSendEmail = async () => {
    if (!po || !supplierEmail || !draftSubject || !draftBodyHtml) return;
    
    setIsSendingEmail(true);
    try {
      // Get attachments from po.meta.spy_files
      const attachments = (po.meta?.spy_files || [])
        .filter((f: any) => f.path)
        .map((f: any) => ({
          name: f.path.split('/').pop() || `${po.spy_po_no || po.po_no}_${f.type}`,
          path: f.path,
        }));

      const res = await fetch('/api/conversations/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_po_id: po.id,
          to_email: supplierEmail,
          subject: draftSubject,
          body_html: draftBodyHtml,
          body_text: draftBody,
          attachments,
        }),
      });
      
      const data = await res.json();
      
      if (data.success) {
        alert('Email sent successfully!');
        setShowDraftModal(false);
        mutateConversation();
      } else {
        throw new Error(data.error || 'Failed to send email');
      }
    } catch (err: any) {
      console.error('Failed to send email:', err);
      alert('Failed to send email: ' + err.message);
    } finally {
      setIsSendingEmail(false);
    }
  };

  // Generate signed URLs for files stored in Supabase
  const { data: fileUrls } = useSWR(
    po?.meta?.spy_files?.length ? ['file-urls', po.id, po.meta.spy_files.map((f: any) => f.path).join(',')] : null,
    async () => {
      const files = po!.meta.spy_files as Array<{ type: string; path?: string; url?: string }>;
      const urls: Record<string, string> = {};
      
      for (const file of files) {
        if (file.path) {
          // Generate signed URL from Supabase storage
          const { data } = await supabase.storage
            .from('documents')
            .createSignedUrl(file.path, 3600); // 1 hour expiry
          
          if (data?.signedUrl) {
            urls[file.path] = data.signedUrl;
          }
        }
      }
      
      return urls;
    },
    { revalidateOnFocus: false }
  );

  // Poll job progress
  React.useEffect(() => {
    if (!jobId || isComplete || jobError) return;

    const interval = setInterval(async () => {
      try {
        // Fetch job status
        const { data: job, error: jobErr } = await supabase
          .from('jobs')
          .select('status')
          .eq('id', jobId)
          .single();

        if (jobErr) {
          setJobError(jobErr.message);
          return;
        }

        if (job.status === 'failed') {
          setJobError('Job failed. Check job details for more information.');
          setJobProgress(0);
          return;
        }

        // Fetch job logs for progress
        const { data: logs, error: logsErr } = await supabase
          .from('job_logs')
          .select('level, msg, data')
          .eq('job_id', jobId)
          .order('ts', { ascending: false })
          .limit(100);

        if (logsErr) {
          console.error('Failed to fetch logs:', logsErr);
          return;
        }

        // Parse progress from logs
        const progressLogs = (logs || []).filter((log: any) => log.level === 'progress');
        
        if (progressLogs.length > 0) {
          const latestProgress = progressLogs[0];
          if (!latestProgress) return;
          const stage = latestProgress.msg;

          // Calculate progress based on stage
          const stages = [
            'STAGE:init',
            'STAGE:supplier_start',
            'STAGE:po_created',
            'STAGE:style_adding',
            'STAGE:style_added',
            'STAGE:po_confirmed',
            'STAGE:complete'
          ];

          const currentStageIndex = stages.findIndex(s => stage.includes(s.split(':')[1]));
          
          if (currentStageIndex >= 0) {
            const progress = ((currentStageIndex + 1) / stages.length) * 100;
            setJobProgress(Math.min(progress, 100));

            // Update status text
            const data = latestProgress.data || {};
            if (stage.includes('init')) {
              setJobStatus(`Initializing... (${data.total_suppliers || 0} suppliers)`);
            } else if (stage.includes('supplier_start')) {
              setJobStatus(`Processing supplier ${data.current || 0}/${data.total || 0}: ${data.supplier || ''}`);
            } else if (stage.includes('po_created')) {
              setJobStatus(`PO created for ${data.supplier || ''}`);
            } else if (stage.includes('style_adding')) {
              setJobStatus(`Adding style ${data.current || 0}/${data.total || 0}: ${data.style_no || ''} - ${data.color || ''}`);
            } else if (stage.includes('style_added')) {
              setJobStatus(`Added style: ${data.style_no || ''} - ${data.color || ''}`);
            } else if (stage.includes('po_confirmed')) {
              setJobStatus(`PO confirmed: ${data.spy_po_no || ''}`);
              if (data.spy_po_no) {
                setSpyPoNumber(data.spy_po_no);
              }
            } else if (stage.includes('complete')) {
              setJobStatus('Push to SPY completed!');
              setJobProgress(100);
              setIsComplete(true);
            }
          }
        }

        // Check if job succeeded
        if (job.status === 'succeeded') {
          setJobProgress(100);
          setIsComplete(true);
          setJobStatus('Push to SPY completed successfully!');
        }
      } catch (error: any) {
        console.error('Polling error:', error);
      }
    }, 2000); // Poll every 2 seconds

    return () => clearInterval(interval);
  }, [jobId, isComplete, jobError]);

  // Poll sync job progress
  React.useEffect(() => {
    if (!syncJobId || syncComplete || syncError) return;

    const interval = setInterval(async () => {
      try {
        // Fetch job status
        const { data: job, error: jobErr } = await supabase
          .from('jobs')
          .select('status')
          .eq('id', syncJobId)
          .single();

        if (jobErr) {
          setSyncError(jobErr.message);
          return;
        }

        // Fetch job logs for progress
        const { data: logs, error: logsErr } = await supabase
          .from('job_logs')
          .select('level, msg, data')
          .eq('job_id', syncJobId)
          .order('ts', { ascending: false })
          .limit(100);

        if (job.status === 'failed') {
          // Check if it's a PO not found error
          const errorLogs = (logs || []).filter((log: any) => log.level === 'error');
          const poNotFoundLog = errorLogs.find((log: any) => 
            log.msg && log.msg.includes('sync_po_not_found')
          );
          
          if (poNotFoundLog) {
            // Stop syncing and show the PO not found dialog
            setIsSyncing(false);
            setSyncProgress(0);
            setSyncError('');
            setShowPoNotFoundDialog(true);
            return;
          }
          
          setSyncError('Sync failed. Check job details for more information.');
          setSyncProgress(0);
          setIsSyncing(false);
          return;
        }

        if (logsErr) {
          console.error('Failed to fetch sync logs:', logsErr);
          return;
        }

        // Parse progress from logs
        const progressLogs = (logs || []).filter((log: any) => log.level === 'progress');
        
        if (progressLogs.length > 0) {
          const latestProgress = progressLogs[0];
          if (!latestProgress) return;
          const stage = latestProgress.msg;

          // Calculate progress based on stage
          const stages = [
            'STAGE:navigating_to_running_orders',
            'STAGE:downloading_files',
            'STAGE:sync_complete'
          ];

          const currentStageIndex = stages.findIndex(s => stage.includes(s.split(':')[1]));
          
          if (currentStageIndex >= 0) {
            const progress = ((currentStageIndex + 1) / stages.length) * 100;
            setSyncProgress(Math.min(progress, 100));

            // Update status text
            if (stage.includes('navigating')) {
              setSyncStatus('Finding PO in running orders...');
            } else if (stage.includes('downloading')) {
              setSyncStatus('Downloading files...');
            } else if (stage.includes('complete')) {
              setSyncStatus('Sync completed!');
              setSyncProgress(100);
              setSyncComplete(true);
              setIsSyncing(false);
              // Refresh PO data to get updated spy_po_no
              mutatePo();
            }
          }
        }

        // Check if job succeeded
        if (job.status === 'succeeded') {
          setSyncProgress(100);
          setSyncComplete(true);
          setSyncStatus('Sync completed successfully!');
          setIsSyncing(false);
          // Refresh PO data
          mutatePo();
        }
      } catch (error: any) {
        console.error('Sync polling error:', error);
      }
    }, 2000); // Poll every 2 seconds

    return () => clearInterval(interval);
  }, [syncJobId, syncComplete, syncError, mutatePo]);

  // Extract order items from meta
  const orderItems: OrderItem[] = React.useMemo(() => {
    if (!po?.meta?.items) return [];
    return po.meta.items as OrderItem[];
  }, [po]);

  // Get unique style numbers
  const styleNos = React.useMemo(() => {
    return Array.from(new Set(orderItems.map(item => item.style_no)));
  }, [orderItems]);

  // Fetch style metadata (images, names, supplier)
  const { data: styleMetas } = useSWR(
    styleNos.length > 0 ? ['styles-meta', styleNos.join(',')] : null,
    async () => {
      const { data, error } = await supabase
        .from('styles')
        .select('style_no, style_name, supplier, image_url')
        .in('style_no', styleNos);
      
      if (error) throw error;
      
      const map = new Map<string, StyleMeta>();
      (data || []).forEach((row: any) => {
        map.set(row.style_no, row as StyleMeta);
      });
      return map;
    }
  );

  // Fetch stock data for sold information
  const { data: stockData } = useSWR(
    styleNos.length > 0 ? ['stock-data', styleNos.join(',')] : null,
    async () => {
      const colors = Array.from(new Set(orderItems.map(item => item.color)));
      const { data, error } = await supabase
        .from('style_stock')
        .select('style_no, color, sizes, section, row_label, values, scraped_at')
        .in('style_no', styleNos)
        .in('color', colors);
      
      if (error) throw error;
      return (data || []) as StockRow[];
    }
  );

  // Fetch other APP PO's for the same style/color combinations
  const { data: otherPos } = useSWR(
    orderItems.length > 0 && po ? ['other-app-pos', orderItems.map(i => `${i.style_no}|${i.color}`).join(',')] : null,
    async () => {
      const { data, error } = await supabase
        .from('app_pos')
        .select('id, po_no, meta')
        .neq('id', po!.id);
      
      if (error) throw error;
      
      // Build a map of style_no|color -> array of {po_no, quantities}
      const map = new Map<string, OtherPoItem[]>();
      
      (data || []).forEach((otherPo: any) => {
        if (!otherPo.meta?.items) return;
        
        (otherPo.meta.items as OrderItem[]).forEach(item => {
          const key = `${item.style_no}|${item.color}`.toLowerCase();
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push({
            po_no: otherPo.po_no,
            quantities: item.quantities
          });
        });
      });
      
      return map;
    }
  );

  // Helper to get stock and sold data for a style/color
  const getStockSoldData = (style_no: string, color: string) => {
    if (!stockData) return { sizes: [], stock: [], sold: [], salesPressure: [] };
    
    const rows = stockData.filter(
      r => r.style_no === style_no && r.color.toLowerCase() === color.toLowerCase()
    );
    
    if (rows.length === 0) return { sizes: [], stock: [], sold: [], salesPressure: [] };
    
    // Get latest row per section
    const latestBySection = new Map<string, StockRow>();
    for (const r of rows) {
      const key = `${r.section}|${r.row_label ?? ''}`;
      const current = latestBySection.get(key);
      if (!current || new Date(r.scraped_at) > new Date(current.scraped_at)) {
        latestBySection.set(key, r);
      }
    }
    
    const latestRows = Array.from(latestBySection.values());
    const stockRow = latestRows.find(r => r.section === 'Stock');
    const soldRows = latestRows.filter(r => r.section === 'Sold');
    
    const sizes = stockRow?.sizes || soldRows[0]?.sizes || [];
    const num = sizes.length;
    
    const ensureNums = (arr: any[], len: number): number[] =>
      Array.from({ length: len }, (_, i) => Number(arr?.[i] ?? 0) || 0);
    
    const stock = stockRow ? ensureNums(stockRow.values, num) : Array(num).fill(0);
    const sold = soldRows.reduce((acc, r) => {
      const vals = ensureNums(r.values, num);
      return acc.map((v, i) => v + (vals[i] || 0));
    }, Array(num).fill(0) as number[]);
    
    // Calculate sales pressure (percentage of each size)
    const totalSold = sold.reduce((a, b) => a + b, 0);
    const salesPressure = totalSold > 0 
      ? sold.map(s => (s / totalSold) * 100) 
      : sizes.map(() => 0);
    
    return { sizes, stock, sold, salesPressure };
  };

  // Legacy helper for backward compatibility
  const getSoldData = (style_no: string, color: string) => {
    const data = getStockSoldData(style_no, color);
    return { sizes: data.sizes, sold: data.sold };
  };
  
  // Original helper to get sold data for a style/color (for reference)
  const getSoldDataLegacy = (style_no: string, color: string) => {
    if (!stockData) return { sizes: [], sold: [] };
    
    const rows = stockData.filter(
      r => r.style_no === style_no && r.color === color
    );
    
    if (rows.length === 0) return { sizes: [], sold: [] };
    
    // Get latest row per section
    const latestBySection = new Map<string, StockRow>();
    rows.forEach(r => {
      const key = `${r.section}|${r.row_label ?? ''}`;
      const current = latestBySection.get(key);
      if (!current || new Date(r.scraped_at) > new Date(current.scraped_at)) {
        latestBySection.set(key, r);
      }
    });
    
    const latestRows = Array.from(latestBySection.values());
    const sizes = (latestRows.find(r => r.section === 'Stock') || latestRows[0])?.sizes || [];
    const num = sizes.length;
    const zero = Array(num).fill(0);
    
    const ensureNums = (arr: any[], len: number) =>
      Array.from({ length: len }, (_, i) => Number(arr?.[i] ?? 0) || 0);
    
    const soldRows = latestRows.filter(r => r.section === 'Sold');
    const sold = soldRows.reduce((acc, r) => {
      const vals = ensureNums(
        Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]')),
        num
      );
      return acc.map((v, i) => v + vals[i]);
    }, zero.slice());
    
    return { sizes, sold };
  };

  // Group items by supplier
  const groupedBySupplier = React.useMemo(() => {
    if (!styleMetas) return [];
    
    const groups = new Map<string, OrderItem[]>();
    
    orderItems.forEach(item => {
      const meta = styleMetas.get(item.style_no);
      const supplier = meta?.supplier || 'Unknown Supplier';
      
      if (!groups.has(supplier)) groups.set(supplier, []);
      groups.get(supplier)!.push(item);
    });
    
    return Array.from(groups.entries()).map(([supplier, items]) => ({
      supplier,
      items
    }));
  }, [orderItems, styleMetas]);

  if (isLoading) {
    return (
      <div className="p-4 max-w-7xl mx-auto">
        <div className="text-center py-8 text-slate-500">Loading...</div>
      </div>
    );
  }

  if (error || !po) {
    return (
      <div className="p-4 max-w-7xl mx-auto">
        <div className="text-center py-8 text-red-600">
          Purchase order not found
        </div>
        <div className="text-center">
          <Button variant="outline" onClick={() => router.push('/purchase/app-pos')}>
            Back to list
          </Button>
        </div>
      </div>
    );
  }

  const handleSyncOrder = async () => {
    if (!po.spy_po_no) {
      setSyncError('No SPY PO number found. Push order first.');
      return;
    }
    
    // Reset state
    setIsSyncing(true);
    setSyncError('');
    setSyncProgress(0);
    setSyncStatus('Starting sync...');
    setSyncComplete(false);
    
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setSyncError('Not authenticated');
        setIsSyncing(false);
        return;
      }
      
      const res = await fetch('/api/sync-app-po', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          po_id: Number(id),
          spy_po_no: po.spy_po_no
        })
      });
      
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to sync order');
      }
      
      const { jobId } = await res.json();
      setSyncJobId(jobId);
      setSyncStatus('Job enqueued, waiting to start...');
    } catch (error: any) {
      setSyncError(error.message || 'Failed to sync order');
      setIsSyncing(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      const { error } = await supabase
        .from('app_pos')
        .delete()
        .eq('id', id);
      
      if (error) throw error;
      
      // Navigate back to list
      router.push('/purchase/app-pos');
    } catch (error: any) {
      alert(`Failed to delete order: ${error.message}`);
      setIsDeleting(false);
      setShowDeleteDialog(false);
    }
  };

  const handleConfirm = async () => {
    setIsConfirming(true);
    try {
      const { error } = await supabase
        .from('app_pos')
        .update({ confirmed: true })
        .eq('id', id);
      
      if (error) throw error;
      
      // Refresh the data
      await mutatePo();
      setShowConfirmDialog(false);
    } catch (error: any) {
      alert(`Failed to confirm order: ${error.message}`);
    } finally {
      setIsConfirming(false);
    }
  };

  const handleRemoveAppPo = async () => {
    setIsRemovingSpyPo(true);
    try {
      const { error } = await supabase
        .from('app_pos')
        .delete()
        .eq('id', id);
      
      if (error) throw error;
      
      // Navigate back to list
      router.push('/purchase/app-pos');
    } catch (error: any) {
      alert(`Failed to remove APP PO: ${error.message}`);
      setIsRemovingSpyPo(false);
    }
  };

  const handlePushFromDialog = async () => {
    setShowPoNotFoundDialog(false);
    
    // First, clear the old SPY PO number
    try {
      await supabase
        .from('app_pos')
        .update({ spy_po_no: null })
        .eq('id', id);
      
      await mutatePo();
    } catch (error: any) {
      console.error('Failed to clear old SPY PO number:', error);
    }
    
    // Then open the push modal
    setShowModal(true);
  };

  return (
    <div className="p-4 space-y-4 max-w-7xl mx-auto">
      {/* Back Button */}
      <div>
        <Button 
          variant="ghost" 
          size="sm"
          onClick={() => router.push('/purchase/app-pos')}
          className="hover:bg-slate-100"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Button>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-slate-500">Purchase / App PO's</div>
          <h1 className="text-2xl font-semibold">{po.po_no}</h1>
          {po.confirmed && (
            <Badge className="mt-1 bg-green-100 text-green-800 border-green-300">
              Confirmed
            </Badge>
          )}
        </div>
        <div className="flex gap-2">
          <Button 
            variant="outline"
            onClick={() => setShowDeleteDialog(true)}
            disabled={po.confirmed}
            className="border-red-300 text-red-600 hover:bg-red-50"
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Delete
          </Button>
          {!po.confirmed && (
            <Button 
              variant="outline"
              onClick={() => setShowConfirmDialog(true)}
              className="border-green-300 text-green-600 hover:bg-green-50"
            >
              <Check className="w-4 h-4 mr-2" />
              Confirm
            </Button>
          )}
          <Button onClick={() => setShowModal(true)}>
            Push Order
          </Button>
          {po.spy_po_no && (
            <Button 
              variant="outline"
              onClick={handleSyncOrder}
              disabled={isSyncing}
            >
              {isSyncing ? 'Syncing...' : 'Sync Orders'}
            </Button>
          )}
        </div>
      </div>
      
      {/* Sync error display */}
      {syncError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">
          {syncError}
        </div>
      )}

      {/* Sync progress display */}
      {isSyncing && (
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">Syncing Order...</h3>
                <span className="text-sm text-slate-600">{Math.round(syncProgress)}%</span>
              </div>
              <div className="w-full bg-slate-200 rounded-full h-2">
                <div 
                  className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${syncProgress}%` }}
                />
              </div>
              <p className="text-sm text-slate-600">{syncStatus}</p>
              {syncComplete && (
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Sync completed successfully!
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Two Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left Column: Purchase Order Details + Order Details */}
        <div className="lg:col-span-2 space-y-4">
          {/* PO Number & SPY PO No. */}
          <Card>
            <CardHeader>
              <CardTitle>Purchase Order Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium text-slate-700 block mb-1">
                    PO Number
                  </label>
                  <Input value={po.po_no} disabled className="bg-slate-50" />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-700 block mb-1">
                    SPY PO No.
                  </label>
                  <Input 
                    value={po.spy_po_no || ''} 
                    placeholder="Not pushed to SPY yet" 
                    disabled 
                    className="bg-slate-50" 
                  />
                </div>
              </div>
              
              {/* ETD/ETA Inputs */}
              <div className="pt-3 border-t">
                <div className="flex items-center justify-between mb-3">
                  <label className="text-sm font-medium text-slate-700">
                    Shipping Dates
                  </label>
                  {supplierData && (
                    <span className="text-xs text-slate-500">
                      Based on {supplierData.name}: {supplierData.lead_time_days}d lead + {supplierData.travel_time_days}d travel
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-slate-500 block mb-1">ETD (Ex-Factory)</label>
                    <Input
                      type="date"
                      value={etdInput}
                      onChange={(e) => setEtdInput(e.target.value)}
                      className="h-9"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 block mb-1">ETA (Arrival)</label>
                    <Input
                      type="date"
                      value={etaInput}
                      onChange={(e) => setEtaInput(e.target.value)}
                      className="h-9"
                    />
                  </div>
                </div>
                {datesChanged && (
                  <div className="mt-3">
                    <Button
                      size="sm"
                      onClick={handleSaveDates}
                      disabled={isSavingDates}
                      className="bg-[#8FA894] hover:bg-[#8FA894]/90"
                    >
                      {isSavingDates ? 'Saving...' : 'Save Dates'}
                    </Button>
                  </div>
                )}
              </div>
              
              {/* File Downloads */}
              {po.meta?.spy_files && po.meta.spy_files.length > 0 && (
                <div className="pt-2 border-t">
                  <label className="text-sm font-medium text-slate-700 block mb-2">
                    Documents
                  </label>
                  <div className="flex gap-2">
                    {po.meta.spy_files.map((file: any, idx: number) => {
                      // Use signed URL from Supabase if available, otherwise fall back to external URL
                      const downloadUrl = file.path && fileUrls?.[file.path] 
                        ? fileUrls[file.path] 
                        : file.url;
                      
                      if (!downloadUrl) return null;
                      
                      return (
                        <a
                          key={idx}
                          href={downloadUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          download
                          className="flex items-center gap-2 px-3 py-2 border rounded-lg hover:bg-slate-50 transition-colors"
                        >
                          {file.type === 'pdf' ? (
                            <FileText className="w-5 h-5 text-red-600" />
                          ) : (
                            <FileSpreadsheet className="w-5 h-5 text-green-600" />
                          )}
                          <span className="text-sm font-medium">
                            {file.type === 'pdf' ? 'PDF' : 'Excel'}
                          </span>
                          <Download className="w-4 h-4 text-slate-400" />
                        </a>
                      );
                    })}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Order Content */}
          <Card>
            <CardHeader>
              <CardTitle>Order Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-8">
          {groupedBySupplier.length === 0 ? (
            <div className="text-center py-8 text-slate-500">
              No items in this order
            </div>
          ) : (
            groupedBySupplier.map(({ supplier, items }) => (
              <div key={supplier} className="space-y-6">
                {/* Supplier Header */}
                <div className="pb-3 border-b-2 border-slate-900">
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-semibold">{supplier}</h3>
                    <Badge>{items.length} item{items.length !== 1 ? 's' : ''}</Badge>
                  </div>
                </div>

                {/* Items grouped by style */}
                {items.map((item) => {
                  const meta = styleMetas?.get(item.style_no);
                  const { sizes, stock, sold, salesPressure } = getStockSoldData(item.style_no, item.color);
                  const key = `${item.style_no}|${item.color}`.toLowerCase();
                  const otherPoItems = otherPos?.get(key) || [];
                  
                  // Calculate other PO's totals per size
                  const otherPoTotals = otherPoItems.reduce((acc, opi) => {
                    return acc.map((v, i) => v + (opi.quantities[i] || 0));
                  }, Array(item.quantities.length).fill(0));
                  
                  // Calculate Net Need: Stock - Sold + This PO + Other PO's
                  const netNeed = item.quantities.map((qty, i) => {
                    const stockVal = stock[i] || 0;
                    const soldVal = sold[i] || 0;
                    const otherVal = otherPoTotals[i] || 0;
                    return stockVal - soldVal + qty + otherVal;
                  });
                  
                  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

                  return (
                    <div key={key} className="space-y-3 pb-6 border-b last:border-b-0">
                      {/* Style Header */}
                      <div className="flex gap-4">
                        {/* Image */}
                        <div className="flex-shrink-0" style={{ maxWidth: '160px' }}>
                          {meta?.image_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={meta.image_url}
                              alt={meta.style_name || item.style_no}
                              className="w-full h-auto object-cover rounded border"
                            />
                          ) : (
                            <div className="w-40 h-40 rounded border bg-gray-100 flex items-center justify-center text-xs text-gray-400">
                              No image
                            </div>
                          )}
                        </div>

                        {/* Style Info */}
                        <div className="flex-1 min-w-0">
                          <div className="text-base font-semibold mb-1">
                            {item.style_no}
                          </div>
                          <div className="text-sm text-slate-600 mb-2">
                            {meta?.style_name || '—'}
                          </div>
                          <div className="text-sm text-slate-700">
                            Color: <span className="font-medium">{item.color}</span>
                          </div>
                        </div>
                      </div>

                      {/* Data Table */}
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm border border-slate-300">
                          <thead className="bg-slate-100">
                            <tr>
                              <th className="p-2 text-left font-semibold border-r border-slate-300 w-32">
                                Metric
                              </th>
                              {(sizes.length > 0 ? sizes : item.quantities.map((_, i) => `Size ${i + 1}`)).map((size, i) => (
                                <th key={i} className="p-2 text-center font-semibold border-r border-slate-300 min-w-[70px]">
                                  {size}
                                </th>
                              ))}
                              <th className="p-2 text-center font-semibold min-w-[80px]">
                                Total
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {/* Stock Row */}
                            <tr className="border-t border-slate-300 bg-slate-50">
                              <td className="p-2 font-medium border-r border-slate-300 bg-slate-100">
                                Stock
                              </td>
                              {item.quantities.map((_, i) => (
                                <td key={i} className="p-2 text-center border-r border-slate-300 text-slate-700 font-semibold">
                                  {stock[i] || 0}
                                </td>
                              ))}
                              <td className="p-2 text-center font-bold text-slate-700">
                                {sum(stock)}
                              </td>
                            </tr>

                            {/* Sold Row */}
                            <tr className="border-t border-slate-300 bg-red-50">
                              <td className="p-2 font-medium border-r border-slate-300 bg-red-100">
                                Sold
                              </td>
                              {item.quantities.map((_, i) => (
                                <td key={i} className="p-2 text-center border-r border-slate-300 text-red-700 font-semibold">
                                  {sold[i] || 0}
                                </td>
                              ))}
                              <td className="p-2 text-center font-bold text-red-700">
                                {sum(sold)}
                              </td>
                            </tr>
                            
                            {/* Sales Pressure Row */}
                            <tr className="border-t border-slate-300 bg-red-50/50">
                              <td className="p-2 font-medium border-r border-slate-300 bg-red-50 text-red-600 text-xs">
                                Sales %
                              </td>
                              {item.quantities.map((_, i) => (
                                <td key={i} className="p-2 text-center border-r border-slate-300 text-red-600 text-xs">
                                  {(salesPressure[i] || 0).toFixed(1)}%
                                </td>
                              ))}
                              <td className="p-2 text-center font-bold text-red-600 text-xs">
                                100%
                              </td>
                            </tr>

                            {/* APP PO Row (this order) */}
                            <tr className="border-t border-slate-300 bg-green-50">
                              <td className="p-2 font-medium border-r border-slate-300 bg-green-100">
                                APP PO
                              </td>
                              {item.quantities.map((qty, i) => (
                                <td key={i} className="p-2 text-center border-r border-slate-300 text-green-700 font-semibold">
                                  {qty}
                                </td>
                              ))}
                              <td className="p-2 text-center font-bold text-green-700">
                                {sum(item.quantities)}
                              </td>
                            </tr>

                            {/* Other APP PO's Row */}
                            {otherPoItems.length > 0 && (
                              <tr className="border-t border-slate-300 bg-slate-50">
                                <td className="p-2 font-medium border-r border-slate-300 bg-slate-100">
                                  Other APP PO's
                                </td>
                                {otherPoTotals.map((total, i) => (
                                  <td key={i} className="p-2 text-center border-r border-slate-300 text-slate-600 font-semibold">
                                    {total}
                                  </td>
                                ))}
                                <td className="p-2 text-center font-bold text-slate-600">
                                  {sum(otherPoTotals)}
                                </td>
                              </tr>
                            )}

                            {/* Net Need Row */}
                            <tr className="border-t border-slate-300 bg-blue-50">
                              <td className="p-2 font-medium border-r border-slate-300 bg-blue-100">
                                Net Need
                              </td>
                              {netNeed.map((need, i) => (
                                <td 
                                  key={i} 
                                  className={`p-2 text-center border-r border-slate-300 font-semibold ${
                                    need > 0 ? 'text-green-700' : need < 0 ? 'text-red-700' : 'text-slate-600'
                                  }`}
                                >
                                  {need}
                                </td>
                              ))}
                              <td className={`p-2 text-center font-bold ${
                                sum(netNeed) > 0 ? 'text-green-700' : sum(netNeed) < 0 ? 'text-red-700' : 'text-slate-600'
                              }`}>
                                {sum(netNeed)}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>

                      {/* Show other PO details if any */}
                      {otherPoItems.length > 0 && (
                        <div className="text-xs text-slate-500 pl-2">
                          Other PO's: {otherPoItems.map(opi => opi.po_no).join(', ')}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </CardContent>
      </Card>
        </div>

        {/* Right Column: Follow-ups & Info */}
        <div className="lg:col-span-1 space-y-4">
          {/* Follow-up Reminders */}
          <Card className="sticky top-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Follow-ups
                {po.meta?.followups?.length > 0 && (
                  <Badge className="bg-[#B8A8D8]/20 text-[#B8A8D8]">
                    {po.meta.followups.filter((f: any) => !f.completed).length} pending
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {po.meta?.followups && po.meta.followups.length > 0 ? (
                <div className="space-y-3">
                  {po.meta.followups.map((followup: any, idx: number) => {
                    const isCompleted = followup.completed;
                    const isPast = new Date(followup.date) < new Date();
                    const isToday = new Date(followup.date).toDateString() === new Date().toDateString();
                    
                    return (
                      <div
                        key={idx}
                        className={`
                          p-3 rounded-lg border transition-all
                          ${isCompleted 
                            ? 'bg-green-50/50 border-green-200 opacity-60' 
                            : isPast 
                              ? 'bg-amber-50 border-amber-200' 
                              : isToday
                                ? 'bg-blue-50 border-blue-200'
                                : 'bg-slate-50 border-slate-200'
                          }
                        `}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className={`text-xs font-medium ${
                                isCompleted 
                                  ? 'text-green-700' 
                                  : isPast 
                                    ? 'text-amber-700' 
                                    : 'text-slate-700'
                              }`}>
                                {new Date(followup.date).toLocaleDateString('en-US', { 
                                  month: 'short', 
                                  day: 'numeric',
                                  year: 'numeric'
                                })}
                              </span>
                              {isToday && !isCompleted && (
                                <Badge className="bg-blue-500 text-white text-[10px]">Today</Badge>
                              )}
                              {isPast && !isCompleted && (
                                <Badge className="bg-amber-500 text-white text-[10px]">Overdue</Badge>
                              )}
                            </div>
                            <div className="text-sm text-slate-700">{followup.description}</div>
                            <div className="text-xs text-slate-500 mt-1 capitalize">
                              {followup.type.replace(/_/g, ' ')}
                            </div>
                            {followup.note && (
                              <div className="text-xs text-slate-600 mt-2 p-2 bg-white/50 rounded border">
                                {followup.note}
                              </div>
                            )}
                            {/* Draft Email button for follow-ups with draftType */}
                            {!isCompleted && followup.draftType && (
                              <button
                                onClick={() => handleGenerateDraft(followup.draftType)}
                                className="mt-2 flex items-center gap-1 text-xs text-[#8FA894] hover:text-[#8FA894]/80 font-medium"
                              >
                                <Mail className="w-3 h-3" />
                                Draft Email
                              </button>
                            )}
                          </div>
                          <div className="flex flex-col gap-1">
                            {!isCompleted && (
                              <button
                                onClick={async () => {
                                  const note = prompt('Add a note (optional):');
                                  const updatedFollowups = [...po.meta.followups];
                                  updatedFollowups[idx] = {
                                    ...followup,
                                    completed: true,
                                    completedAt: new Date().toISOString(),
                                    note: note || undefined,
                                  };
                                  
                                  try {
                                    await supabase
                                      .from('app_pos')
                                      .update({ 
                                        meta: { ...po.meta, followups: updatedFollowups } 
                                      })
                                      .eq('id', id);
                                    mutatePo();
                                  } catch (err) {
                                    console.error('Failed to update followup:', err);
                                  }
                                }}
                                className="p-1.5 rounded-full hover:bg-green-100 text-green-600 transition-colors"
                                title="Mark as done"
                              >
                                <Check className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-6 text-slate-500 text-sm">
                  {po.meta?.source === 'smart_draft' ? (
                    'No follow-up reminders set'
                  ) : (
                    <div className="space-y-2">
                      <div>No follow-up reminders</div>
                      <div className="text-xs text-slate-400">
                        Orders created via Smart Draft include automatic follow-up suggestions
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
          
          {/* Conversations Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4" />
                Conversation
                {conversation?.status && (
                  <Badge className={`text-xs ${
                    conversation.status === 'confirmed' ? 'bg-green-100 text-green-700' :
                    conversation.status === 'active' ? 'bg-blue-100 text-blue-700' :
                    'bg-slate-100 text-slate-700'
                  }`}>
                    {conversation.status}
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {conversation && conversation.messages?.length > 0 ? (
                <div className="space-y-3">
                  {/* Message Thread */}
                  <div className="max-h-64 overflow-y-auto space-y-2">
                    {conversation.messages.slice(-5).map((msg: any) => (
                      <div
                        key={msg.id}
                        className={`p-2 rounded-lg text-sm ${
                          msg.direction === 'outbound'
                            ? 'bg-[#C5D5CA]/30 ml-4'
                            : 'bg-blue-50 mr-4'
                        }`}
                      >
                        <div className="flex justify-between items-start mb-1">
                          <span className={`text-xs font-medium ${
                            msg.direction === 'outbound' ? 'text-[#8FA894]' : 'text-blue-600'
                          }`}>
                            {msg.direction === 'outbound' ? 'You' : po.supplier}
                          </span>
                          <span className="text-[10px] text-slate-400">
                            {new Date(msg.sent_at).toLocaleDateString('en-US', { 
                              month: 'short', 
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit'
                            })}
                          </span>
                        </div>
                        <div className="text-slate-700 text-xs line-clamp-3">
                          {msg.body_text?.slice(0, 150) || '(No preview)'}
                          {msg.body_text?.length > 150 && '...'}
                        </div>
                        {msg.ai_analysis && (
                          <div className="mt-1 flex gap-1 flex-wrap">
                            {msg.ai_analysis.confirmed && (
                              <Badge className="bg-green-100 text-green-700 text-[10px]">Confirmed</Badge>
                            )}
                            {msg.ai_analysis.action_needed && (
                              <Badge className="bg-amber-100 text-amber-700 text-[10px]">Action Needed</Badge>
                            )}
                            {msg.ai_analysis.questions?.length > 0 && (
                              <Badge className="bg-purple-100 text-purple-700 text-[10px]">
                                {msg.ai_analysis.questions.length} Question(s)
                              </Badge>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  
                  {/* AI Summary */}
                  {conversation.ai_summary && (
                    <div className="text-xs bg-slate-50 rounded p-2 border">
                      <span className="font-medium text-slate-600">AI Summary: </span>
                      {conversation.ai_summary}
                    </div>
                  )}
                  
                  {/* Quick Actions */}
                  <div className="flex gap-2 pt-2 border-t">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleGenerateDraft('initial')}
                      className="flex-1 text-xs"
                    >
                      <Mail className="w-3 h-3 mr-1" />
                      New Email
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="text-center py-4 text-slate-500 text-sm">
                    <Mail className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p>No conversation started yet</p>
                    <p className="text-xs mt-1 text-slate-400">
                      Draft an email to the supplier to begin tracking
                    </p>
                  </div>
                  
                  {/* Draft Email Options */}
                  <div className="space-y-2">
                    <Button
                      size="sm"
                      onClick={() => handleGenerateDraft('initial')}
                      className="w-full bg-[#8FA894] hover:bg-[#8FA894]/90"
                      disabled={isGeneratingDraft}
                    >
                      <Mail className="w-4 h-4 mr-2" />
                      Draft Order Confirmation Email
                    </Button>
                    
                    {po.etd && (
                      <div className="grid grid-cols-2 gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleGenerateDraft('followup_2weeks')}
                          className="text-xs"
                          disabled={isGeneratingDraft}
                        >
                          2 Week Follow-up
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleGenerateDraft('followup_1week')}
                          className="text-xs"
                          disabled={isGeneratingDraft}
                        >
                          1 Week Follow-up
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          
          {/* Order Info Card */}
          {(po.meta?.deadline || po.meta?.notes || po.meta?.source === 'smart_draft') && (
            <Card>
              <CardHeader>
                <CardTitle>Order Info</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {po.meta?.source === 'smart_draft' && (
                  <div className="flex items-center gap-2">
                    <Badge className="bg-[#B8A8D8]/20 text-[#B8A8D8]">Smart Draft</Badge>
                  </div>
                )}
                {po.meta?.deadline && (
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Deadline</div>
                    <div className="text-sm font-medium">
                      {new Date(po.meta.deadline).toLocaleDateString('en-US', {
                        month: 'long',
                        day: 'numeric',
                        year: 'numeric'
                      })}
                    </div>
                  </div>
                )}
                {po.meta?.supplier_lead_time_days && (
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Lead Time</div>
                    <div className="text-sm">
                      {po.meta.supplier_lead_time_days} days production
                      {po.meta?.supplier_travel_time_days && (
                        <span className="text-slate-500"> + {po.meta.supplier_travel_time_days} days travel</span>
                      )}
                    </div>
                  </div>
                )}
                {po.meta?.notes && (
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Notes</div>
                    <div className="text-sm text-slate-700">{po.meta.notes}</div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Push Order Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4">
            {modalStep === 1 ? (
              <>
                <div className="p-6 border-b">
                  <h2 className="text-xl font-semibold">Push Order to SPY</h2>
                  <p className="text-sm text-slate-600 mt-1">
                    Select the season for this purchase order
                  </p>
                </div>
                <div className="p-6">
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Season
                  </label>
                  <SearchSelect
                    items={seasonItems}
                    value={selectedSeason}
                    onChange={setSelectedSeason}
                    placeholder="Select a season..."
                    clearable={false}
                    className="w-full"
                  />
                </div>
                <div className="p-6 border-t flex justify-end gap-3">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setShowModal(false);
                      setModalStep(1);
                      setSelectedSeason('');
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={async () => {
                      if (!selectedSeason) return;
                      
                      setModalStep(2);
                      setJobStatus('Starting push to SPY...');
                      
                      try {
                        const { data: { session } } = await supabase.auth.getSession();
                        if (!session) {
                          setJobError('Not authenticated');
                          return;
                        }
                        
                        const res = await fetch('/api/push-app-po', {
                          method: 'POST',
                          headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${session.access_token}`
                          },
                          body: JSON.stringify({
                            po_id: Number(id),
                            season_id: selectedSeason // This is now the UUID string
                          })
                        });
                        
                        if (!res.ok) {
                          const error = await res.json();
                          throw new Error(error.error || 'Failed to start job');
                        }
                        
                        const { jobId: newJobId } = await res.json();
                        setJobId(newJobId);
                        setJobStatus('Job enqueued, waiting to start...');
                      } catch (error: any) {
                        setJobError(error.message);
                        setJobStatus('Failed to start job');
                      }
                    }}
                    disabled={!selectedSeason}
                  >
                    Next
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="p-6 border-b">
                  <h2 className="text-xl font-semibold">Pushing Order to SPY</h2>
                  <p className="text-sm text-slate-600 mt-1">
                    {jobStatus}
                  </p>
                </div>
                <div className="p-6">
                  {jobError ? (
                    <div className="bg-red-50 border border-red-200 rounded-md p-4">
                      <div className="font-semibold text-red-900">Error</div>
                      <div className="text-sm text-red-700 mt-1">{jobError}</div>
                    </div>
                  ) : (
                    <>
                      {/* Progress Bar */}
                      <div className="mb-4">
                        <div className="w-full bg-slate-200 rounded-full h-4">
                          <div
                            className="bg-blue-600 h-4 rounded-full transition-all duration-300"
                            style={{ width: `${jobProgress}%` }}
                          />
                        </div>
                        <div className="text-sm text-slate-600 mt-2 text-center">
                          {Math.round(jobProgress)}%
                        </div>
                      </div>

                      {isComplete && spyPoNumber && (
                        <div className="bg-green-50 border border-green-200 rounded-md p-4 mb-4">
                          <div className="font-semibold text-green-900">Success!</div>
                          <div className="text-sm text-green-700 mt-1">
                            SPY PO Number: <strong>{spyPoNumber}</strong>
                          </div>
                        </div>
                      )}

                      {jobId && (
                        <div className="text-sm text-slate-500 mt-4">
                          <a
                            href={`/admin/jobs/${jobId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline hover:text-slate-700"
                          >
                            View Job Details →
                          </a>
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div className="p-6 border-t flex justify-end">
                  <Button
                    onClick={() => {
                      setShowModal(false);
                      setModalStep(1);
                      setSelectedSeason('');
                      setJobId(null);
                      setJobProgress(0);
                      setJobStatus('');
                      setJobError('');
                      setIsComplete(false);
                      setSpyPoNumber('');
                      mutatePo(); // Refresh PO data
                    }}
                  >
                    Close
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      
      {/* Delete Confirmation Dialog */}
      {showDeleteDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                <Trash2 className="w-6 h-6 text-red-600" />
              </div>
              <div>
                <h3 className="font-semibold text-lg">Delete Purchase Order</h3>
                <p className="text-sm text-slate-600">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-slate-700 mb-6">
              Are you sure you want to delete this purchase order? This will permanently remove all data associated with this order.
            </p>
            <div className="flex gap-3 justify-end">
              <Button 
                variant="outline" 
                onClick={() => setShowDeleteDialog(false)}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button 
                onClick={handleDelete}
                disabled={isDeleting}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {isDeleting ? 'Deleting...' : 'Delete Order'}
              </Button>
            </div>
          </div>
        </div>
      )}
      
      {/* Confirm Order Dialog */}
      {showConfirmDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
                <Check className="w-6 h-6 text-green-600" />
              </div>
              <div>
                <h3 className="font-semibold text-lg">Confirm Purchase Order</h3>
                <p className="text-sm text-slate-600">Mark this order as confirmed</p>
              </div>
            </div>
            <p className="text-slate-700 mb-6">
              Are you sure you want to confirm this purchase order? Confirmed orders will be moved to a separate section.
            </p>
            <div className="flex gap-3 justify-end">
              <Button 
                variant="outline" 
                onClick={() => setShowConfirmDialog(false)}
                disabled={isConfirming}
              >
                Cancel
              </Button>
              <Button 
                onClick={handleConfirm}
                disabled={isConfirming}
                className="bg-green-600 hover:bg-green-700 text-white"
              >
                {isConfirming ? 'Confirming...' : 'Confirm Order'}
              </Button>
            </div>
          </div>
        </div>
      )}
      
      {/* PO Not Found Dialog */}
      {showPoNotFoundDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-yellow-100 flex items-center justify-center">
                <svg className="w-6 h-6 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div>
                <h3 className="font-semibold text-lg">SPY PO Not Found</h3>
                <p className="text-sm text-slate-600">PO {po.spy_po_no} doesn't exist in SPY</p>
              </div>
            </div>
            <p className="text-slate-700 mb-6">
              The SPY PO number <strong>{po.spy_po_no}</strong> was not found in the SPY Running Orders. 
              You can push this order to SPY again (this will create a new SPY PO number), or delete this APP PO entirely.
            </p>
            <div className="flex flex-col gap-3">
              <Button 
                onClick={handlePushFromDialog}
                disabled={isRemovingSpyPo}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white"
              >
                Push Order to SPY
              </Button>
              <Button 
                variant="outline"
                onClick={handleRemoveAppPo}
                disabled={isRemovingSpyPo}
                className="w-full border-red-300 text-red-600 hover:bg-red-50"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                {isRemovingSpyPo ? 'Removing...' : 'Remove APP PO'}
              </Button>
              <Button 
                variant="outline"
                onClick={() => setShowPoNotFoundDialog(false)}
                disabled={isRemovingSpyPo}
                className="w-full"
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Draft Email Modal */}
      {showDraftModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col">
            <div className="p-6 border-b">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Mail className="w-5 h-5" />
                {draftType === 'initial' ? 'Order Confirmation Email' : 
                 draftType === 'followup_2weeks' ? '2-Week Follow-up' :
                 draftType === 'followup_1week' ? '1-Week Follow-up' :
                 'ETD Follow-up'}
              </h2>
              <p className="text-sm text-slate-600 mt-1">
                Review and send the email to the supplier
              </p>
            </div>
            
            <div className="p-6 overflow-y-auto flex-1 space-y-4">
              {isGeneratingDraft ? (
                <div className="flex items-center justify-center py-12">
                  <div className="text-center">
                    <RefreshCw className="w-8 h-8 animate-spin mx-auto text-[#8FA894]" />
                    <p className="text-sm text-slate-600 mt-3">Generating draft...</p>
                  </div>
                </div>
              ) : (
                <>
                  {/* To Email */}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      To <span className="text-red-500">*</span>
                    </label>
                    <Input
                      type="email"
                      value={supplierEmail}
                      onChange={(e) => setSupplierEmail(e.target.value)}
                      placeholder="supplier@example.com"
                      className={`w-full ${!supplierEmail ? 'border-amber-300 bg-amber-50/50' : ''}`}
                    />
                    {!supplierEmail && (
                      <p className="text-xs text-amber-600 mt-1">
                        Enter the supplier's email address
                      </p>
                    )}
                    {supplierData?.notes && (
                      <p className="text-xs text-slate-500 mt-1">
                        Supplier notes: {supplierData.notes}
                      </p>
                    )}
                  </div>
                  
                  {/* Subject */}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      Subject
                    </label>
                    <Input
                      value={draftSubject}
                      onChange={(e) => setDraftSubject(e.target.value)}
                      placeholder="Email subject"
                      className="w-full font-medium"
                    />
                  </div>
                  
                  {/* Body with tabs for Edit/Preview */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-sm font-medium text-slate-700">
                        Message
                      </label>
                      <div className="flex gap-1 bg-slate-100 rounded-md p-0.5">
                        <button
                          type="button"
                          onClick={() => setEmailPreviewMode && setEmailPreviewMode(false)}
                          className={`px-2 py-1 text-xs rounded ${!emailPreviewMode ? 'bg-white shadow-sm' : 'text-slate-600'}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => setEmailPreviewMode && setEmailPreviewMode(true)}
                          className={`px-2 py-1 text-xs rounded ${emailPreviewMode ? 'bg-white shadow-sm' : 'text-slate-600'}`}
                        >
                          Preview
                        </button>
                      </div>
                    </div>
                    
                    {emailPreviewMode ? (
                      <div 
                        className="w-full min-h-[200px] border rounded-md p-4 bg-white text-sm prose prose-sm max-w-none"
                        dangerouslySetInnerHTML={{ __html: draftBodyHtml || '<p class="text-slate-400">No content yet...</p>' }}
                      />
                    ) : (
                      <textarea
                        value={draftBody}
                        onChange={(e) => {
                          setDraftBody(e.target.value);
                          // Convert to HTML with proper formatting
                          const html = e.target.value
                            .split('\n\n')
                            .map(para => {
                              // Handle lists
                              if (para.startsWith('- ')) {
                                const items = para.split('\n').map(line => 
                                  line.startsWith('- ') ? `<li>${line.slice(2)}</li>` : line
                                );
                                return `<ul>${items.join('')}</ul>`;
                              }
                              return `<p style="margin: 0 0 10px 0;">${para.replace(/\n/g, '<br>')}</p>`;
                            })
                            .join('');
                          setDraftBodyHtml(html);
                        }}
                        className="w-full min-h-[200px] border rounded-md p-3 text-sm font-mono resize-y focus:ring-2 focus:ring-[#8FA894]/20 focus:border-[#8FA894]"
                        placeholder="Hi,

I have orders for you here...

Thank you, have a nice day."
                      />
                    )}
                  </div>
                  
                  {/* Attachments Preview */}
                  {po.meta?.spy_files && po.meta.spy_files.length > 0 && (
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Attachments ({po.meta.spy_files.filter((f: any) => f.path).length})
                      </label>
                      <div className="flex gap-2 flex-wrap">
                        {po.meta.spy_files.filter((f: any) => f.path).map((file: any, idx: number) => (
                          <div
                            key={idx}
                            className="flex items-center gap-2 px-3 py-2 bg-slate-50 border rounded-lg text-sm"
                          >
                            {file.type === 'pdf' ? (
                              <FileText className="w-4 h-4 text-red-600" />
                            ) : (
                              <FileSpreadsheet className="w-4 h-4 text-green-600" />
                            )}
                            <span className="text-slate-700">{file.path.split('/').pop()}</span>
                            <Check className="w-3 h-3 text-green-500" />
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-slate-500 mt-1">
                        These files will be attached to the email
                      </p>
                    </div>
                  )}
                  
                  {/* Quick tips */}
                  <div className="bg-blue-50 rounded-lg p-3 text-xs text-blue-700">
                    <strong>Tip:</strong> Use blank lines to separate paragraphs. Start lines with "- " for bullet points.
                  </div>
                </>
              )}
            </div>
            
            <div className="p-6 border-t flex justify-between gap-3">
              <Button
                variant="outline"
                onClick={() => setShowDraftModal(false)}
              >
                Cancel
              </Button>
              
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    navigator.clipboard.writeText(draftBody);
                    alert('Email copied to clipboard!');
                  }}
                  disabled={isGeneratingDraft || !draftBody}
                >
                  Copy to Clipboard
                </Button>
                <Button
                  onClick={handleSendEmail}
                  disabled={isGeneratingDraft || isSendingEmail || !supplierEmail || !draftSubject}
                  className="bg-[#8FA894] hover:bg-[#8FA894]/90"
                >
                  {isSendingEmail ? (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4 mr-2" />
                      Send Email
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


'use client';
import React, { useMemo, useState } from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { 
  ChevronRight, 
  ChevronDown, 
  Download, 
  FileText, 
  Search, 
  Play, 
  CheckCircle2, 
  Loader2,
  Filter,
  Calendar,
  Package,
  X
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';

type ExportRow = { 
  id: string; 
  kind: string; 
  title: string | null; 
  path: string; 
  public_url: string | null; 
  created_at: string; 
  comment: string | null;
  meta?: any;
};

// Kind labels and colors
const KIND_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  'general_salesmen_pdfs': { 
    label: 'Salesmen PDFs', 
    color: 'bg-[#B8A8D8]/20 text-[#6B5B95] border-[#B8A8D8]',
    icon: <FileText className="h-3.5 w-3.5" />
  },
  'overview_pdf': { 
    label: 'Overview', 
    color: 'bg-[#C5D5CA]/30 text-[#5A7D5E] border-[#C5D5CA]',
    icon: <FileText className="h-3.5 w-3.5" />
  },
  'countries_pdf': { 
    label: 'Countries', 
    color: 'bg-[#D4E4E8]/40 text-[#4A6B7C] border-[#D4E4E8]',
    icon: <FileText className="h-3.5 w-3.5" />
  },
  'top_styles_pdf': { 
    label: 'Top Styles', 
    color: 'bg-amber-50 text-amber-700 border-amber-200',
    icon: <FileText className="h-3.5 w-3.5" />
  },
  'stock_list_pdf': { 
    label: 'Stock List', 
    color: 'bg-slate-50 text-slate-600 border-slate-200',
    icon: <Package className="h-3.5 w-3.5" />
  },
  'general_pdf_zip': {
    label: 'General ZIP',
    color: 'bg-[#B8A8D8]/20 text-[#6B5B95] border-[#B8A8D8]',
    icon: <Package className="h-3.5 w-3.5" />
  },
};

function promptComment(): Promise<string | null> {
  return new Promise((resolve) => {
    const comment = window.prompt('Enter a comment for this export (optional):');
    resolve(comment || null);
  });
}

export default function StatisticsExportsPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  
  const { data, mutate } = useSWR('exports:all', async () => {
    const { data, error } = await supabase
      .from('exports')
      .select('id, kind, title, path, public_url, meta, created_at, comment')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []) as ExportRow[];
  }, { refreshInterval: 10000 });

  const { data: saved } = useSWR('app-settings:season-compare', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'season_compare').maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.value as { s1?: string; s2?: string }) ?? {};
  });

  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ index: number; total: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [jobDone, setJobDone] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [zipProgress, setZipProgress] = useState<Record<string, { done: number; total: number } | null>>({});

  // Get unique kinds for filter
  const allKinds = useMemo(() => {
    const kinds = new Set<string>();
    (data ?? []).forEach(r => kinds.add(r.kind));
    return Array.from(kinds).sort();
  }, [data]);

  // Filter exports
  const filteredData = useMemo(() => {
    let result = data ?? [];
    
    if (kindFilter) {
      result = result.filter(r => r.kind === kindFilter);
    }
    
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(r => 
        (r.title?.toLowerCase().includes(q)) ||
        (r.comment?.toLowerCase().includes(q)) ||
        (r.kind.toLowerCase().includes(q)) ||
        (r.meta?.seasons?.s1?.toLowerCase().includes(q)) ||
        (r.meta?.seasons?.s2?.toLowerCase().includes(q))
      );
    }
    
    return result;
  }, [data, kindFilter, searchQuery]);

  async function waitForUrlReady(url: string, attempts = 8, delayMs = 750): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        if (res.ok) return true;
      } catch {}
      await new Promise(r => setTimeout(r, delayMs));
    }
    return false;
  }

  function timeAgo(iso: string): string {
    const d = new Date(iso).getTime();
    const diff = Math.floor((Date.now() - d) / 1000);
    const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
      [60, 'second'],
      [60, 'minute'],
      [24, 'hour'],
      [7, 'day'],
      [4.34524, 'week'],
      [12, 'month'],
      [Number.POSITIVE_INFINITY, 'year']
    ];
    let unit: Intl.RelativeTimeFormatUnit = 'second';
    let value = -diff;
    let acc = diff;
    for (let i = 0, n = diff; i < units.length; i++) {
      const pair = units[i];
      if (!pair) break;
      const [step, u] = pair;
      if (n < step) { unit = u; value = -Math.round(acc); break; }
      n = Math.floor(n / step);
      acc = n;
      unit = u;
      value = -Math.round(acc);
    }
    const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    return rtf.format(value as number, unit);
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('da-DK', { 
      day: 'numeric', 
      month: 'short', 
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  React.useEffect(() => {
    let timer: any;
    if (jobId) {
      setRunning(true);
      setElapsed(0);
      const t = setInterval(() => setElapsed((v: number) => v + 1), 1000);
      timer = setInterval(async () => {
        try {
          const { data: logs } = await supabase
            .from('job_logs')
            .select('msg, data')
            .eq('job_id', jobId)
            .order('ts', { ascending: false })
            .limit(50);
          for (const l of (logs ?? []) as any[]) {
            if ((l.msg === 'STEP:export_general_progress' || l.msg === 'STEP:export_overview_progress' || l.msg === 'STEP:export_countries_progress') && l.data) {
              setProgress({ index: Number(l.data.index || 0), total: Number(l.data.total || 0) });
              break;
            }
            if (l.msg === 'STEP:complete') {
              setRunning(false); setJobId(null); setProgress(null); setJobDone(true);
              mutate();
              setTimeout(() => setJobDone(false), 4000);
              break;
            }
          }
          const { data: jobRow } = await supabase.from('jobs').select('status').eq('id', jobId).maybeSingle();
          if ((jobRow as any)?.status === 'succeeded' || (jobRow as any)?.status === 'failed' || (jobRow as any)?.status === 'cancelled') {
            setRunning(false); setJobId(null); setProgress(null); setJobDone(true);
            mutate();
            setTimeout(() => setJobDone(false), 3000);
          }
        } catch {}
      }, 1500);
      return () => { if (timer) clearInterval(timer); clearInterval(t); };
    }
    return () => { if (timer) clearInterval(timer); };
  }, [jobId, mutate]);

  async function enqueueGeneralReactPdf() {
    const comment = await promptComment();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in');
    const token = session.access_token;
    const body = { type: 'export_overview', payload: { mode: 'general_salesmen_react_pdf', requestedBy: session.user.email, s1: saved?.s1, s2: saved?.s2, comment } };
    const res = await fetch('/api/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    const js = await res.json();
    setJobId(js.jobId);
  }

  async function enqueueOverviewPdf() {
    const comment = await promptComment();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in');
    const token = session.access_token;
    const body = { type: 'export_overview', payload: { mode: 'overview_react_pdf', requestedBy: session.user.email, s1: saved?.s1, s2: saved?.s2, comment } };
    const res = await fetch('/api/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    const js = await res.json();
    setJobId(js.jobId);
  }

  async function enqueueCountriesPdf() {
    const comment = await promptComment();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in');
    const token = session.access_token;
    const body = { type: 'export_overview', payload: { mode: 'countries_react_pdf', requestedBy: session.user.email, s1: saved?.s1, s2: saved?.s2, comment } };
    const res = await fetch('/api/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    const js = await res.json();
    setJobId(js.jobId);
  }

  async function enqueueTopStylesPdf() {
    const comment = await promptComment();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in');
    const token = session.access_token;
    const body = { type: 'export_top_styles', payload: { requestedBy: session.user.email, comment } };
    const res = await fetch('/api/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    const js = await res.json();
    setJobId(js.jobId);
  }

  async function createJob(body: any, comment?: string | null) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in');
    const token = session.access_token;
    if (comment !== undefined && body.payload) {
      body.payload.comment = comment;
    }
    const res = await fetch('/api/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    const js = await res.json();
    return js.jobId as string;
  }

  async function waitForJob(jobId: string) {
    for (let i = 0; i < 120; i++) {
      try {
        const { data } = await supabase.from('jobs').select('status').eq('id', jobId).maybeSingle();
        const st = (data as any)?.status as string | undefined;
        if (st === 'succeeded' || st === 'failed' || st === 'cancelled') return st;
      } catch {}
      await new Promise(r => setTimeout(r, 1500));
    }
    return 'timeout';
  }

  async function enqueueAllExportsSequential() {
    if (running || jobId) return;
    const comment = await promptComment();
    try {
      setRunning(true);
      setProgress(null);
      let id = await createJob({ type: 'export_overview', payload: { mode: 'general_salesmen_react_pdf' } }, comment);
      setJobId(id);
      await waitForJob(id);
      id = await createJob({ type: 'export_overview', payload: { mode: 'overview_react_pdf' } }, comment);
      setJobId(id);
      await waitForJob(id);
      id = await createJob({ type: 'export_overview', payload: { mode: 'countries_react_pdf' } }, comment);
      setJobId(id);
      await waitForJob(id);
      id = await createJob({ type: 'export_top_styles', payload: {} }, comment);
      setJobId(id);
      await waitForJob(id);
      id = await createJob({ type: 'export_stock_list', payload: {} }, comment);
      setJobId(id);
      await waitForJob(id);
      setJobId(null);
      setRunning(false);
      setJobDone(true);
      mutate();
      setTimeout(() => setJobDone(false), 4000);
    } catch (e) {
      setRunning(false);
    }
  }

  function toggleSelect(exportId: string, filePath: string) {
    setSelected((prev) => {
      const copy: Record<string, Set<string>> = { ...prev };
      const set = new Set(copy[exportId] ? Array.from(copy[exportId]) : []);
      if (set.has(filePath)) set.delete(filePath); else set.add(filePath);
      copy[exportId] = set;
      return copy;
    });
  }

  function toggleSelectAll(exportId: string, filePaths: string[], on: boolean) {
    setSelected((prev) => {
      const copy: Record<string, Set<string>> = { ...prev };
      copy[exportId] = on ? new Set(filePaths) : new Set();
      return copy;
    });
  }

  function isSelected(exportId: string, filePath: string): boolean {
    return Boolean(selected[exportId] && selected[exportId].has(filePath));
  }

  async function downloadSelectedAsZip(exportId: string, files: Array<{ path: string; name?: string }>) {
    const chosen = files.filter((f) => selected[exportId]?.has(f.path));
    if (chosen.length === 0) return;
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    setZipProgress((p) => ({ ...p, [exportId]: { done: 0, total: chosen.length } }));
    for (const f of chosen) {
      try {
        const { data: blob, error } = await supabase.storage.from('exports').download(f.path);
        if (!error && blob) {
          const filename = f.name ? `${f.name}.pdf` : (f.path.split('/').pop() || 'file.pdf');
          zip.file(filename, blob as unknown as Blob);
        }
      } catch {}
      setZipProgress((p) => {
        const cur = p[exportId] || { done: 0, total: chosen.length };
        return { ...p, [exportId]: { done: Math.min(cur.done + 1, cur.total), total: cur.total } };
      });
    }
    const out = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(out);
    const a = document.createElement('a');
    a.href = url; a.download = 'selected.pdf.zip';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    setZipProgress((p) => ({ ...p, [exportId]: null }));
  }

  async function downloadPath(path: string, publicUrl?: string | null) {
    try {
      const { data: file, error } = await supabase.storage.from('exports').download(path);
      if (error || !file) throw error || new Error('Download failed');
      const blobUrl = URL.createObjectURL(file as unknown as Blob);
      const a = document.createElement('a');
      a.href = blobUrl; a.download = path.split('/').pop() || 'file.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(blobUrl);
    } catch {
      if (publicUrl) {
        try {
          const ready = await waitForUrlReady(publicUrl);
          if (ready) { window.open(publicUrl, '_blank', 'noopener'); return; }
        } catch {}
      }
      alert('File is not ready yet. Please try again in a moment.');
    }
  }

  async function downloadChildWithFallback(filePath?: string | null, publicUrl?: string | null, zipPath?: string | null) {
    if (filePath) {
      try {
        const { data: file, error } = await supabase.storage.from('exports').download(filePath);
        if (!error && file) {
          const blobUrl = URL.createObjectURL(file as unknown as Blob);
          const a = document.createElement('a');
          a.href = blobUrl; a.download = filePath.split('/').pop() || 'file.pdf';
          document.body.appendChild(a); a.click(); a.remove();
          URL.revokeObjectURL(blobUrl);
          return;
        }
      } catch {}
    }
    if (publicUrl) {
      try {
        const ready = await waitForUrlReady(publicUrl);
        if (ready) { window.open(publicUrl, '_blank', 'noopener'); return; }
      } catch {}
    }
    if (zipPath) {
      try {
        const { data: zipBlob, error } = await supabase.storage.from('exports').download(zipPath);
        if (error || !zipBlob) throw error || new Error('Zip download failed');
        const { default: JSZip } = await import('jszip');
        const zip = await JSZip.loadAsync(zipBlob as unknown as Blob);
        const wanted = filePath ? (filePath.split('/').pop() || '') : '';
        let entry = wanted ? zip.file(new RegExp(`${wanted.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}$`)) : null;
        if (!entry || entry.length === 0) {
          entry = zip.file(/\.pdf$/i);
        }
        if (entry && entry.length > 0) {
          const first = entry[0] as any;
          if (first) {
            const content = await first.async('blob');
            const url = URL.createObjectURL(content);
            const a = document.createElement('a');
            a.href = url; a.download = (first.name?.split('/').pop()) || 'file.pdf';
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(url);
            return;
          }
        }
      } catch {}
    }
    alert('File is not ready yet. Please try again in a moment.');
  }

  function getKindConfig(kind: string) {
    return KIND_CONFIG[kind] || { 
      label: kind.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), 
      color: 'bg-gray-50 text-gray-600 border-gray-200',
      icon: <FileText className="h-3.5 w-3.5" />
    };
  }

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-[#8FA894]">Statistics</p>
          <h1 className="text-2xl font-semibold text-slate-900">Exports</h1>
        </div>
        
        <div className="flex items-center gap-3">
          {/* Status indicator */}
          {running && (
            <div className="flex items-center gap-2 rounded-full bg-[#B8A8D8]/20 px-3 py-1.5 text-sm text-[#6B5B95]">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Generating… {elapsed}s{progress ? ` (${progress.index}/${progress.total})` : ''}</span>
            </div>
          )}
          {!running && jobDone && (
            <div className="flex items-center gap-2 rounded-full bg-[#C5D5CA]/40 px-3 py-1.5 text-sm text-[#5A7D5E]">
              <CheckCircle2 className="h-4 w-4" />
              <span>Export complete</span>
            </div>
          )}
          
          {/* Actions dropdown */}
          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMenuOpen((v) => !v)}
              disabled={running}
              className="gap-2"
            >
              <Play className="h-3.5 w-3.5" />
              New Export
            </Button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-full z-20 mt-2 w-72 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                  <button
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-[#F5F3F0] disabled:opacity-50"
                    onClick={() => { enqueueGeneralReactPdf(); setMenuOpen(false); }}
                    disabled={running}
                  >
                    <FileText className="h-4 w-4 text-[#8FA894]" />
                    <div>
                      <div className="font-medium">Salesmen PDFs</div>
                      <div className="text-xs text-slate-500">Individual PDF per salesperson</div>
                    </div>
                  </button>
                  <button
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-[#F5F3F0] disabled:opacity-50"
                    onClick={() => { enqueueOverviewPdf(); setMenuOpen(false); }}
                    disabled={running}
                  >
                    <FileText className="h-4 w-4 text-[#8FA894]" />
                    <div>
                      <div className="font-medium">Overview PDF</div>
                      <div className="text-xs text-slate-500">Summary overview document</div>
                    </div>
                  </button>
                  <button
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-[#F5F3F0] disabled:opacity-50"
                    onClick={() => { enqueueCountriesPdf(); setMenuOpen(false); }}
                    disabled={running}
                  >
                    <FileText className="h-4 w-4 text-[#8FA894]" />
                    <div>
                      <div className="font-medium">Countries PDF</div>
                      <div className="text-xs text-slate-500">Statistics by country</div>
                    </div>
                  </button>
                  <button
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-[#F5F3F0] disabled:opacity-50"
                    onClick={() => { enqueueTopStylesPdf(); setMenuOpen(false); }}
                    disabled={running}
                  >
                    <FileText className="h-4 w-4 text-[#8FA894]" />
                    <div>
                      <div className="font-medium">Top 10 Styles</div>
                      <div className="text-xs text-slate-500">Best performing styles</div>
                    </div>
                  </button>
                  <button
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-[#F5F3F0] disabled:opacity-50"
                    onClick={async () => {
                      try {
                        const comment = await promptComment();
                        const { data: { session } } = await supabase.auth.getSession();
                        if (!session) throw new Error('Not signed in');
                        const token = session.access_token;
                        await fetch('/api/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ type: 'export_stock_list', payload: { comment } }) });
                      } finally { setMenuOpen(false); }
                    }}
                    disabled={running}
                  >
                    <Package className="h-4 w-4 text-[#8FA894]" />
                    <div>
                      <div className="font-medium">Stock Lists</div>
                      <div className="text-xs text-slate-500">Current stock PDFs</div>
                    </div>
                  </button>
                  <div className="my-1 border-t border-slate-100" />
                  <button
                    className="flex w-full items-center gap-3 rounded-md bg-slate-900 px-3 py-2.5 text-left text-sm text-white hover:bg-slate-800 disabled:opacity-50"
                    onClick={() => { enqueueAllExportsSequential(); setMenuOpen(false); }}
                    disabled={running}
                  >
                    <Play className="h-4 w-4" />
                    <div>
                      <div className="font-medium">Run All Exports</div>
                      <div className="text-xs text-slate-300">Generate all export types</div>
                    </div>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Filters */}
      <Card className="border-[#C5D5CA]/50 bg-[#FEFEFE]">
        <CardContent className="p-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            {/* Search */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                placeholder="Search exports by title, comment, or season..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 border-slate-200 focus:border-[#8FA894] focus:ring-[#8FA894]"
              />
            </div>
            
            {/* Kind filter pills */}
            <div className="flex flex-wrap items-center gap-2">
              <Filter className="h-4 w-4 text-slate-400" />
              <button
                onClick={() => setKindFilter(null)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-all ${
                  kindFilter === null 
                    ? 'bg-slate-900 text-white' 
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                All
              </button>
              {allKinds.map(kind => {
                const config = getKindConfig(kind);
                return (
                  <button
                    key={kind}
                    onClick={() => setKindFilter(kindFilter === kind ? null : kind)}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-all ${
                      kindFilter === kind 
                        ? 'bg-slate-900 text-white' 
                        : `${config.color} hover:opacity-80`
                    }`}
                  >
                    {config.label}
                  </button>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Results count */}
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>
          Showing {filteredData.length} of {data?.length ?? 0} exports
        </span>
        {(kindFilter || searchQuery) && (
          <button
            onClick={() => { setKindFilter(null); setSearchQuery(''); }}
            className="flex items-center gap-1 text-[#8FA894] hover:text-[#5A7D5E]"
          >
            <X className="h-3.5 w-3.5" />
            Clear filters
          </button>
        )}
      </div>

      {/* Exports list */}
      <div className="space-y-3">
        {filteredData.length === 0 ? (
          <Card className="border-dashed border-slate-200">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <FileText className="h-12 w-12 text-slate-300" />
              <p className="mt-4 text-sm font-medium text-slate-600">No exports found</p>
              <p className="mt-1 text-xs text-slate-400">
                {searchQuery || kindFilter 
                  ? 'Try adjusting your filters' 
                  : 'Generate your first export using the button above'}
              </p>
            </CardContent>
          </Card>
        ) : (
          filteredData.map((r) => {
            const files = (r.meta?.files as Array<{ name: string; path: string; publicUrl?: string | null }> | undefined) ?? [];
            const all = r.meta?.all as { path?: string | null; publicUrl?: string | null } | undefined;
            const hasChildren = Array.isArray(files) && files.length > 0;
            const config = getKindConfig(r.kind);
            const isExpanded = openId === r.id;

            return (
              <Card 
                key={r.id} 
                className={`overflow-hidden border-slate-200/80 transition-all ${isExpanded ? 'ring-2 ring-[#C5D5CA]/50' : 'hover:border-[#C5D5CA]'}`}
              >
                <div 
                  className={`flex items-center gap-4 p-4 ${hasChildren ? 'cursor-pointer' : ''}`}
                  onClick={() => hasChildren && setOpenId(isExpanded ? null : r.id)}
                >
                  {/* Icon */}
                  <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${config.color}`}>
                    {config.icon}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-slate-900">{r.title ?? config.label}</span>
                      <Badge className={config.color}>{config.label}</Badge>
                      {r.kind === 'general_salesmen_pdfs' && r.meta?.seasons?.s1 && (
                        <Badge className="bg-[#D4E4E8]/50 text-[#4A6B7C] border-[#D4E4E8]">
                          {r.meta.seasons.s1} vs {r.meta.seasons.s2}
                        </Badge>
                      )}
                      {hasChildren && (
                        <Badge className="bg-slate-100 text-slate-500 border-slate-200">
                          {files.length} files
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {timeAgo(r.created_at)}
                      </span>
                      {r.comment && (
                        <span className="truncate max-w-[200px]" title={r.comment}>
                          "{r.comment}"
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2">
                    {r.public_url && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          r.path ? downloadPath(r.path, r.public_url) : window.open(r.public_url!, '_blank', 'noopener');
                        }}
                        className="gap-1.5"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Download
                      </Button>
                    )}
                    {hasChildren && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                      >
                        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </Button>
                    )}
                  </div>
                </div>

                {/* Expanded children */}
                {hasChildren && isExpanded && (
                  <div className="border-t border-slate-100 bg-[#F5F3F0]/30 p-4">
                    {/* Combined download */}
                    {all?.publicUrl && (
                      <div className="mb-4 flex items-center justify-between rounded-lg bg-white p-3 border border-slate-200">
                        <div className="flex items-center gap-3">
                          <Package className="h-5 w-5 text-[#8FA894]" />
                          <div>
                            <div className="text-sm font-medium">All Combined</div>
                            <div className="text-xs text-slate-500">Single PDF with all salespersons</div>
                          </div>
                        </div>
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => { all.path ? downloadPath(all.path) : window.open(all.publicUrl!, '_blank', 'noopener'); }}
                          className="gap-1.5"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Download All
                        </Button>
                      </div>
                    )}

                    {/* Selection controls */}
                    {files.length > 0 && (
                      <div className="mb-3 flex items-center justify-between">
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-slate-300 text-[#8FA894] focus:ring-[#8FA894]"
                            checked={(selected[r.id]?.size ?? 0) === files.length}
                            onChange={(e) => toggleSelectAll(r.id, files.map((f: any) => f.path), e.target.checked)}
                          />
                          <span className="text-slate-600">Select all</span>
                        </label>
                        <div className="flex items-center gap-2">
                          {zipProgress[r.id] && (
                            <span className="text-xs text-slate-500">
                              Preparing {zipProgress[r.id]!.done}/{zipProgress[r.id]!.total}...
                            </span>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => downloadSelectedAsZip(r.id, files.map((f: any) => ({ path: f.path, name: f.name })))}
                            disabled={(selected[r.id]?.size ?? 0) === 0}
                            className="gap-1.5"
                          >
                            <Package className="h-3.5 w-3.5" />
                            Download Selected as ZIP
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* File list */}
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {files.map((f: any, i: number) => (
                        <div
                          key={i}
                          className={`flex items-center gap-3 rounded-lg border bg-white p-3 transition-all ${
                            isSelected(r.id, f.path) ? 'border-[#8FA894] bg-[#C5D5CA]/10' : 'border-slate-200 hover:border-slate-300'
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-slate-300 text-[#8FA894] focus:ring-[#8FA894]"
                            checked={isSelected(r.id, f.path)}
                            onChange={() => toggleSelect(r.id, f.path)}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="truncate text-sm font-medium text-slate-700">{f.name}</div>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-slate-400 hover:text-slate-600"
                            onClick={() => downloadChildWithFallback(f.path, f.publicUrl, r.path)}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}

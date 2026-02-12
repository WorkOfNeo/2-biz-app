'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as XLSX from 'xlsx';
import { supabase } from '../../../lib/supabaseClient';
import useSWR from 'swr';
import type { CustomerRow, SalespersonRow } from '@shared/types';
import { Modal } from '../../../components/Modal';
import { ProgressBar } from '../../../components/ProgressBar';
import { SearchSelect } from '../../../components/SearchSelect';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../../components/ui/table';
import { Input } from '../../../components/ui/input';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { Sheet, SheetHeader, SheetTitle, SheetContent, SheetClose } from '../../../components/ui/sheet';
import { Switch } from '../../../components/ui/switch';
import { cn } from '../../../lib/cn';

/* ───────── fuzzy multi-word search ───────── */
function fuzzyMatch(query: string, ...fields: (string | null | undefined)[]): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = fields.map((f) => (f ?? '').toLowerCase()).join(' ');
  return terms.every((t) => hay.includes(t));
}

/* ───────── multi-select filter dropdown ───────── */
function MultiFilterDropdown({
  label,
  options,
  selected,
  onSelectedChange,
}: {
  label: string;
  options: string[];
  selected: string[];
  onSelectedChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  function toggle(val: string) {
    if (selected.includes(val)) {
      onSelectedChange(selected.filter((s) => s !== val));
    } else {
      onSelectedChange([...selected, val]);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'h-8 inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs hover:bg-slate-50 transition-colors',
          selected.length > 0 && 'border-slate-400'
        )}
      >
        <span className="text-slate-600">{label}</span>
        {selected.length > 0 && (
          <Badge className="bg-slate-900 text-white border-0 px-1.5 py-0 text-[10px]">{selected.length}</Badge>
        )}
        <svg className="h-3 w-3 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-56 rounded-md border border-slate-200 bg-white shadow-lg">
          <div className="p-1.5 border-b border-slate-100">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className="w-full text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-slate-400"
              autoFocus
            />
          </div>
          <div className="max-h-52 overflow-auto py-1">
            {selected.length > 0 && (
              <button
                className="w-full text-left px-2.5 py-1 text-[11px] text-slate-500 hover:bg-slate-50"
                onClick={() => { onSelectedChange([]); setQuery(''); }}
              >
                Clear all
              </button>
            )}
            {filtered.length === 0 && (
              <div className="px-2.5 py-2 text-[11px] text-slate-400">No options.</div>
            )}
            {filtered.map((opt) => {
              const active = selected.includes(opt);
              return (
                <button
                  key={opt}
                  className={cn(
                    'w-full text-left px-2.5 py-1 text-xs hover:bg-slate-50 flex items-center gap-2',
                    active && 'bg-slate-50'
                  )}
                  onClick={() => toggle(opt)}
                >
                  <span className={cn(
                    'flex items-center justify-center h-3.5 w-3.5 rounded border text-[9px]',
                    active ? 'bg-slate-900 border-slate-900 text-white' : 'border-slate-300'
                  )}>
                    {active && '✓'}
                  </span>
                  <span className="truncate">{opt}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────── main page ───────── */
export default function CustomersSettingsPage() {
  const router = useRouter();

  // Bulk update modal state
  const [bulkOpen, setBulkOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [matchFileCol, setMatchFileCol] = useState('');
  const [valueFileCol, setValueFileCol] = useState('');
  const [matchDbCol, setMatchDbCol] = useState('customer_id');
  const [updateDbCol, setUpdateDbCol] = useState('city');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  // Search & filters
  const [search, setSearch] = useState('');
  const [filterCountry, setFilterCountry] = useState<string[]>([]);
  const [filterCity, setFilterCity] = useState<string[]>([]);
  const [filterSalesperson, setFilterSalesperson] = useState<string[]>([]);

  const { data: customers, mutate } = useSWR('customers', async () => {
    const { data, error } = await supabase
      .from('customers')
      .select('id, company, city, country, phone, priority, customer_id, stats_display_name, group_name, email, postal, currency, excluded, nulled, permanently_closed, salespersons(name)')
      .order('company', { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);
    return data as any[];
  }, { refreshInterval: 10000 });

  const { data: salespersons } = useSWR('salespersons', async () => {
    const { data, error } = await supabase.from('salespersons').select('*').order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return data as SalespersonRow[];
  });

  // Derive unique options for filter dropdowns
  const countryOptions = useMemo(() => {
    const set = new Set<string>();
    (customers ?? []).forEach((c) => { if (c.country) set.add(c.country); });
    return Array.from(set).sort();
  }, [customers]);

  const cityOptions = useMemo(() => {
    const set = new Set<string>();
    (customers ?? []).forEach((c) => { if (c.city) set.add(c.city); });
    return Array.from(set).sort();
  }, [customers]);

  const salespersonOptions = useMemo(() => {
    const set = new Set<string>();
    (customers ?? []).forEach((c) => { if (c.salespersons?.name) set.add(c.salespersons.name); });
    return Array.from(set).sort();
  }, [customers]);

  // Filtered & searched customer list
  const filtered = useMemo(() => {
    return (customers ?? []).filter((c) => {
      // Fuzzy multi-word search across all visible columns
      if (search && !fuzzyMatch(search, c.company, c.group_name, c.city, c.country, c.phone, c.salespersons?.name, c.customer_id, c.priority?.toString())) {
        return false;
      }
      // Dropdown filters (OR within same filter, AND across filters)
      if (filterCountry.length > 0 && !filterCountry.includes(c.country ?? '')) return false;
      if (filterCity.length > 0 && !filterCity.includes(c.city ?? '')) return false;
      if (filterSalesperson.length > 0 && !filterSalesperson.includes(c.salespersons?.name ?? '')) return false;
      return true;
    });
  }, [customers, search, filterCountry, filterCity, filterSalesperson]);

  const activeFilterCount = filterCountry.length + filterCity.length + filterSalesperson.length;

  const MATCHABLE_DB_COLS = useMemo(() => ['customer_id', 'company', 'email'], []);
  const UPDATEABLE_DB_COLS = useMemo(() => [
    'company', 'stats_display_name', 'group_name', 'email', 'city', 'postal', 'country', 'currency', 'excluded', 'nulled', 'permanently_closed'
  ], []);
  const preview = useMemo(() => rows.slice(0, 5), [rows]);

  // Edit drawer state
  const [editOpen, setEditOpen] = useState(false);
  const [editRow, setEditRow] = useState<any | null>(null);
  const [e_company, setECompany] = useState('');
  const [e_stats, setEStats] = useState('');
  const [e_group, setEGroup] = useState('');
  const [e_spName, setESPName] = useState('');
  const [e_email, setEEmail] = useState('');
  const [e_city, setECity] = useState('');
  const [e_postal, setEPostal] = useState('');
  const [e_country, setECountry] = useState('');
  const [e_currency, setECurrency] = useState('');
  const [e_excluded, setEExcluded] = useState(false);
  const [e_nulled, setENulled] = useState(false);
  const [e_closed, setEClosed] = useState(false);
  const [e_saving, setESaving] = useState(false);

  function openEdit(row: any) {
    setEditRow(row);
    setECompany(row.company ?? '');
    setEStats(row.stats_display_name ?? '');
    setEGroup(row.group_name ?? '');
    setESPName(row.salespersons?.name ?? '');
    setEEmail(row.email ?? '');
    setECity(row.city ?? '');
    setEPostal(row.postal ?? '');
    setECountry(row.country ?? '');
    setECurrency(row.currency ?? '');
    setEExcluded(!!row.excluded);
    setENulled(!!row.nulled);
    setEClosed(!!row.permanently_closed);
    setEditOpen(true);
  }

  async function saveEdit() {
    if (!editRow) return;
    try {
      setESaving(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const token = session.access_token;
      const res = await fetch(`${process.env.NEXT_PUBLIC_ORCHESTRATOR_URL}/customers/${editRow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          company: e_company,
          stats_display_name: e_stats,
          group_name: e_group,
          salesperson_name: e_spName,
          email: e_email,
          city: e_city,
          postal: e_postal,
          country: e_country,
          currency: e_currency,
          excluded: e_excluded,
          nulled: e_nulled,
          permanently_closed: e_closed,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setEditOpen(false);
      mutate();
    } catch (e: any) {
      alert(e?.message || 'Failed to save');
    } finally {
      setESaving(false);
    }
  }

  const parseFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = new Uint8Array(e.target?.result as ArrayBuffer);
      const wb = XLSX.read(data, { type: 'array' });
      const wsname = wb.SheetNames && wb.SheetNames.length > 0 ? wb.SheetNames[0] : undefined;
      if (!wsname) { setRows([]); setHeaders([]); return; }
      const ws = wb.Sheets[wsname as string];
      if (!ws) { setRows([]); setHeaders([]); return; }
      const json: Record<string, any>[] = XLSX.utils.sheet_to_json(ws, { defval: '' });
      setRows(json);
      const headerRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as any[];
      const hdr = Array.isArray(headerRows) && Array.isArray(headerRows[0]) ? (headerRows[0] as string[]) : [];
      setHeaders(hdr);
      setMatchFileCol(hdr[0] || '');
      setValueFileCol(hdr[1] || '');
    };
    reader.readAsArrayBuffer(file);
  }, []);

  async function runBulkUpdate() {
    try {
      setRunning(true);
      setResultMsg(null);
      setProgress(0);
      if (!matchFileCol || !valueFileCol || !matchDbCol || !updateDbCol) throw new Error('Please select mapping.');
      const total = rows.length;
      let ok = 0, fail = 0;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r) { setProgress(i + 1); continue; }
        const matchVal = r[matchFileCol as keyof typeof r];
        const newValRaw = r[valueFileCol as keyof typeof r];
        if (matchVal === undefined || matchVal === null || String(matchVal).trim() === '') { setProgress(i + 1); continue; }
        let newVal: any = newValRaw;
        if (['excluded', 'nulled', 'permanently_closed'].includes(updateDbCol)) {
          const s = String(newValRaw).toLowerCase().trim();
          newVal = s === 'true' || s === '1' || s === 'yes' || s === 'y';
        }
        const { error } = await supabase
          .from('customers')
          .update({ [updateDbCol]: newVal })
          .eq(matchDbCol, matchVal as any);
        if (error) { fail++; } else { ok++; }
        setProgress(i + 1);
      }
      setResultMsg(`Updated ${ok}/${total} rows${fail ? `, ${fail} failed` : ''}.`);
      mutate();
    } catch (e: any) {
      setResultMsg(`Error: ${e?.message ?? String(e)}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Customers</h2>
        <div className="relative">
          <details>
            <summary className="list-none">
              <Button variant="outline" size="sm">☰</Button>
            </summary>
            <div className="absolute right-0 z-10 mt-1 w-48 rounded-md border border-slate-200 bg-white shadow-lg">
              <div className="py-1 text-sm">
                <button className="block w-full px-3 py-1.5 text-left text-xs hover:bg-slate-50" onClick={() => setBulkOpen(true)}>
                  Bulk update (XLSX)
                </button>
                <button className="block w-full px-3 py-1.5 text-left text-xs hover:bg-slate-50" onClick={() => router.push('/settings/customers/scrape')}>
                  Scrape Customers
                </button>
              </div>
            </div>
          </details>
        </div>
      </div>

      {/* Search + Filters bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customers…"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <MultiFilterDropdown label="Country" options={countryOptions} selected={filterCountry} onSelectedChange={setFilterCountry} />
        <MultiFilterDropdown label="City" options={cityOptions} selected={filterCity} onSelectedChange={setFilterCity} />
        <MultiFilterDropdown label="Salesperson" options={salespersonOptions} selected={filterSalesperson} onSelectedChange={setFilterSalesperson} />
        {activeFilterCount > 0 && (
          <button
            onClick={() => { setFilterCountry([]); setFilterCity([]); setFilterSalesperson([]); }}
            className="text-[11px] text-slate-500 hover:text-slate-700 underline"
          >
            Clear filters
          </button>
        )}
        <span className="ml-auto text-[11px] text-slate-400">{filtered.length} customers</span>
      </div>

      {/* Table */}
      <div className="overflow-auto border border-slate-200 rounded-md">
        <Table>
          <TableHeader className="bg-slate-50 sticky top-0">
            <TableRow>
              <TableHead className="h-7 px-2">Customer</TableHead>
              <TableHead className="h-7 px-2">Group</TableHead>
              <TableHead className="h-7 px-2">City</TableHead>
              <TableHead className="h-7 px-2">Country</TableHead>
              <TableHead className="h-7 px-2">Phone</TableHead>
              <TableHead className="h-7 px-2">Priority</TableHead>
              <TableHead className="h-7 px-2">Salesperson</TableHead>
              <TableHead className="h-7 px-2 w-12"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((c) => (
              <TableRow
                key={c.id}
                className="cursor-pointer hover:bg-slate-50/80"
                onClick={() => openEdit(c)}
              >
                <TableCell className="px-2 py-1">
                  <a
                    href={`/settings/customers/${c.id}`}
                    className="text-blue-700 hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {c.company || '–'}
                  </a>
                </TableCell>
                <TableCell className="px-2 py-1 text-slate-600">{c.group_name || '—'}</TableCell>
                <TableCell className="px-2 py-1 text-slate-600">{c.city || '–'}</TableCell>
                <TableCell className="px-2 py-1 text-slate-600">{c.country || '–'}</TableCell>
                <TableCell className="px-2 py-1 text-slate-600">{c.phone || '–'}</TableCell>
                <TableCell className="px-2 py-1 text-slate-600">{c.priority || '–'}</TableCell>
                <TableCell className="px-2 py-1 text-slate-600">{c.salespersons?.name || '—'}</TableCell>
                <TableCell className="px-2 py-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={(e) => { e.stopPropagation(); openEdit(c); }}
                  >
                    <svg className="h-3.5 w-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="px-2 py-8 text-center text-slate-400 text-xs">
                  {customers ? 'No customers match your search or filters.' : 'Loading…'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* ───── Edit Customer Drawer ───── */}
      <Sheet open={editOpen} onOpenChange={setEditOpen} className="!w-full max-w-md">
        <SheetClose onClick={() => setEditOpen(false)} />
        <SheetHeader>
          <SheetTitle>Edit Customer</SheetTitle>
          {editRow && <p className="text-xs text-slate-500 mt-0.5">{editRow.customer_id}</p>}
        </SheetHeader>
        <SheetContent className="space-y-5 p-5 overflow-auto h-[calc(100%-80px)]">
          {/* Text fields */}
          <div className="space-y-3">
            <FieldRow label="Company" value={e_company} onChange={setECompany} />
            <FieldRow label="Stats Display" value={e_stats} onChange={setEStats} />
            <FieldRow label="Group" value={e_group} onChange={setEGroup} />
            <div>
              <label className="text-xs font-medium text-slate-700">Salesperson</label>
              <SearchSelect
                className="mt-1"
                items={(salespersons ?? []).map((sp) => ({ value: sp.name, label: sp.name }))}
                value={e_spName}
                onChange={(v) => setESPName(v)}
                placeholder="Select salesperson"
              />
            </div>
            <FieldRow label="Email" value={e_email} onChange={setEEmail} />
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="City" value={e_city} onChange={setECity} />
              <FieldRow label="Postal" value={e_postal} onChange={setEPostal} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Country" value={e_country} onChange={setECountry} />
              <FieldRow label="Currency" value={e_currency} onChange={setECurrency} />
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-slate-100" />

          {/* Toggle flags */}
          <div className="space-y-4">
            <ToggleRow
              label="Excluded"
              description="Skjuler kunden på statistikken"
              checked={e_excluded}
              onCheckedChange={setEExcluded}
            />
            <ToggleRow
              label="Nulled"
              description="Nuller kunden permanent"
              checked={e_nulled}
              onCheckedChange={setENulled}
            />
            <ToggleRow
              label="Permanently Closed"
              description="Sætter kunden som permanent lukket"
              checked={e_closed}
              onCheckedChange={setEClosed}
            />
          </div>

          {/* Divider */}
          <div className="border-t border-slate-100" />

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            <Button onClick={saveEdit} disabled={e_saving || !editRow} size="sm">
              {e_saving ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* ───── Bulk Update Modal (kept as-is) ───── */}
      <Modal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title="Bulk update customers (XLSX)"
        footer={(
          <div className="flex items-center gap-3 w-full justify-between">
            <div className="flex-1 mr-4">
              {running && <ProgressBar value={progress} max={Math.max(1, rows.length)} />}
              {!running && rows.length > 0 && <div className="text-xs text-gray-500 mt-1">{progress}/{rows.length}</div>}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setBulkOpen(false)} disabled={running}>Close</Button>
              <Button
                disabled={running || rows.length === 0 || !matchFileCol || !valueFileCol}
                size="sm"
                onClick={runBulkUpdate}
              >
                {running ? 'Updating…' : 'Start update'}
              </Button>
            </div>
          </div>
        )}
      >
        <div className="space-y-4">
          <div
            className={cn(
              'border-2 border-dashed rounded-lg p-6 text-center transition',
              dragOver ? 'bg-slate-50 border-slate-400' : 'border-slate-300'
            )}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(ev) => { ev.preventDefault(); setDragOver(false); const f = ev.dataTransfer.files?.[0]; if (f) parseFile(f); }}
          >
            <div className="text-sm text-gray-600">Drag & drop Excel here, or click to browse.</div>
            <div className="mt-3">
              <input
                className="w-full text-sm"
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) parseFile(f); }}
              />
            </div>
          </div>

          {headers.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <label className="text-sm">
                <div className="font-medium">Match column (file)</div>
                <select className="mt-1 w-full border rounded-md p-2 text-sm" value={matchFileCol} onChange={(e) => setMatchFileCol(e.target.value)}>
                  <option value="">—</option>
                  {headers.map((h) => (<option key={h} value={h}>{h}</option>))}
                </select>
              </label>
              <label className="text-sm">
                <div className="font-medium">Match against (DB)</div>
                <select className="mt-1 w-full border rounded-md p-2 text-sm" value={matchDbCol} onChange={(e) => setMatchDbCol(e.target.value)}>
                  {MATCHABLE_DB_COLS.map((c) => (<option key={c} value={c}>{c}</option>))}
                </select>
              </label>
              <label className="text-sm">
                <div className="font-medium">Value column (file)</div>
                <select className="mt-1 w-full border rounded-md p-2 text-sm" value={valueFileCol} onChange={(e) => setValueFileCol(e.target.value)}>
                  <option value="">—</option>
                  {headers.map((h) => (<option key={h} value={h}>{h}</option>))}
                </select>
              </label>
              <label className="text-sm">
                <div className="font-medium">Set column (DB)</div>
                <select className="mt-1 w-full border rounded-md p-2 text-sm" value={updateDbCol} onChange={(e) => setUpdateDbCol(e.target.value)}>
                  {UPDATEABLE_DB_COLS.map((c) => (<option key={c} value={c}>{c}</option>))}
                </select>
              </label>
            </div>
          )}

          {preview.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm text-gray-600">Preview (first 5 rows)</div>
              <div className="overflow-auto border rounded-md">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr>{headers.map((h) => (<th key={h} className="text-left p-2 border-b bg-gray-50">{h}</th>))}</tr>
                  </thead>
                  <tbody>
                    {preview.map((r, idx) => (
                      <tr key={idx}>{headers.map((h) => (<td key={h} className="p-2 border-b">{String(r[h] ?? '')}</td>))}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {resultMsg && <div className="text-sm">{resultMsg}</div>}
        </div>
      </Modal>
    </div>
  );
}

/* ───────── small helper components ───────── */

function FieldRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="text-xs font-medium text-slate-700">{label}</label>
      <Input className="mt-1 h-8 text-xs" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-0.5">
        <div className="text-sm font-medium text-slate-900">{label}</div>
        <div className="text-[11px] text-slate-500 leading-tight">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

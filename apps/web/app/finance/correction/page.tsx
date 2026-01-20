'use client';

import * as React from 'react';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Dropzone } from '../../../components/ui/dropzone';
import { Badge } from '../../../components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table';

type InputRow = {
  rowNo: number;
  transactionDate: string;
  customsRef: string;
  exportNo: string;
  type: string;
  delivery: string;
  eu: string;
  qty: number;
};

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
  dato: string;
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

type StyleMeta = {
  style_no: string;
  style_name: string | null;
  cost_price: number | null;
  cost_price_currency: string | null;
  customs_tariff_no: string | null;
  country_of_origin: string | null;
};

type Run = {
  id: string;
  created_at: string;
  file_name: string | null;
  style_no: string;
  style_name: string | null;
  row_count: number;
  toldref: string | null;
  first_date: string | null;
  last_date: string | null;
};

type Step = 'upload' | 'preview';

const OUTPUT_COLUMNS = [
  'Toldref',
  'Varenr',
  'Varenavn',
  'Pris',
  'Valuta (Original)',
  'Toldtariff',
  'Oprindelsesland',
  'Nyt toldlager',
  'Dato',
  'Day',
  'Month',
  'Year',
  'Reference',
  'Ind/Ud',
  'Eksport ref',
  'Eksport til',
  'Antal',
  'Værdi',
  'Valuta',
  'Kurs',
  'Total DKK Værdi',
  'Fraførselsref',
  'Non-EU',
];

// Format number in Danish format (comma as decimal separator, dot as thousands)
function formatDanishNumber(value: number | null | undefined, decimals = 2): string {
  if (value == null) return '';
  return value.toLocaleString('da-DK', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function rowToArray(r: OutputRow): (string | number | null)[] {
  return [
    r.toldref,
    r.varenr,
    r.varenavn,
    r.pris,
    r.valuta_original,
    r.toldtariff,
    r.oprindelsesland,
    r.ny_toldlager,
    r.dato,
    r.day,
    r.month,
    r.year,
    r.reference,
    r.ind_ud,
    r.eksport_ref,
    r.eksport_til,
    r.antal,
    r.vaerdi,
    r.valuta,
    r.kurs,
    r.total_dkk_vaerdi,
    r.frafoerselsref,
    r.non_eu,
  ];
}

function formatCell(cell: string | number | null, colIndex: number): string {
  if (cell == null) return '';
  // Columns with numbers that should be formatted in Danish: Pris(3), Antal(16), Værdi(17)
  if (typeof cell === 'number') {
    // Pris and Værdi get 2 decimals, Antal is integer
    if (colIndex === 3 || colIndex === 17) {
      return formatDanishNumber(cell, 2);
    } else if (colIndex === 16) {
      return formatDanishNumber(cell, 0);
    } else if (colIndex === 9 || colIndex === 10 || colIndex === 11) {
      // Day, Month, Year - integers
      return String(cell);
    }
    return formatDanishNumber(cell, 2);
  }
  return String(cell);
}

export default function CorrectionPage() {
  const [step, setStep] = React.useState<Step>('upload');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // File parsing state
  const [uploadedFile, setUploadedFile] = React.useState<File | null>(null);
  const [styleNo, setStyleNo] = React.useState<string>('');
  const [fileTariff, setFileTariff] = React.useState<string>('');
  const [inputRows, setInputRows] = React.useState<InputRow[]>([]);

  // API response state
  const [runId, setRunId] = React.useState<string | null>(null);
  const [styleMeta, setStyleMeta] = React.useState<StyleMeta | null>(null);
  const [outputRows, setOutputRows] = React.useState<OutputRow[]>([]);

  // Recent runs
  const [recentRuns, setRecentRuns] = React.useState<Run[]>([]);
  const [loadingRuns, setLoadingRuns] = React.useState(false);

  // Fetch recent runs on mount
  React.useEffect(() => {
    fetchRecentRuns();
  }, []);

  async function fetchRecentRuns() {
    try {
      setLoadingRuns(true);
      const res = await fetch('/api/finance/correction-runs?limit=10');
      if (res.ok) {
        const data = await res.json();
        setRecentRuns(data.runs ?? []);
      }
    } catch {
      // Ignore errors for recent runs
    } finally {
      setLoadingRuns(false);
    }
  }

  async function onFilesSelected(files: File[]) {
    setError(null);
    resetState();
    if (!files || files.length === 0) return;

    setBusy(true);
    try {
      const XLSX = await import('xlsx');
      const file = files[0]!;
      setUploadedFile(file);

      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheetName = wb.SheetNames?.[0];
      if (!sheetName) throw new Error('No sheet found in the Excel file');

      const sheet = wb.Sheets[sheetName];
      if (!sheet) throw new Error('Empty sheet');

      const data = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];
      if (data.length < 5) throw new Error('File must have at least 5 rows (header at row 4, data from row 5)');

      // Extract Style No from C1 (row index 0, col index 2)
      const extractedStyleNo = String(data[0]?.[2] ?? '').trim();
      if (!extractedStyleNo) {
        throw new Error('Style No not found in cell C1');
      }
      setStyleNo(extractedStyleNo);

      // Extract Customs Tariff from C2 (row index 1, col index 2)
      const extractedTariff = String(data[1]?.[2] ?? '').trim();
      setFileTariff(extractedTariff);

      // Header is at row 4 (index 3), data starts at row 5 (index 4)
      // Columns: A(0)=TransDate, B(1)=CustomsRef, C(2)=ComInv, D(3)=ExportNo, E(4)=ExportDate, 
      //          F(5)=Type, G(6)=Delivery, H(7)=Invoice, I(8)=Customer, J(9)=Country,
      //          K(10)=EU, L(11)=CustomsType, M(12)=QTY
      const parsed: InputRow[] = [];
      for (let i = 4; i < data.length; i++) {
        const row = data[i];
        if (!row || row.length === 0) continue;

        // Skip empty rows (check if at least transaction date or qty exists)
        const transDate = row[0];
        const qty = row[12];
        if (transDate == null && qty == null) continue;

        parsed.push({
          rowNo: i + 1, // 1-based row number (Excel row)
          transactionDate: transDate != null ? String(transDate) : '',
          customsRef: String(row[1] ?? ''),
          exportNo: String(row[3] ?? ''),
          type: String(row[5] ?? ''),
          delivery: String(row[6] ?? ''),
          eu: String(row[10] ?? ''),
          qty: Number(row[12]) || 0,
        });
      }

      if (parsed.length === 0) {
        throw new Error('No data rows found (data expected from row 5 onwards)');
      }

      setInputRows(parsed);

      // Now call the API to process and persist
      await processRows(file.name, extractedStyleNo, extractedTariff, parsed);
    } catch (e: any) {
      setError(e?.message || 'Failed to parse file');
      setStep('upload');
    } finally {
      setBusy(false);
    }
  }

  async function processRows(fileName: string, sNo: string, fTariff: string, rows: InputRow[]) {
    const res = await fetch('/api/finance/correction-runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName,
        styleNo: sNo,
        fileTariff: fTariff,
        rows,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to process file');
    }

    const data = await res.json();
    setRunId(data.runId);
    setStyleMeta(data.styleMeta);
    setOutputRows(data.outputRows ?? []);
    setStep('preview');

    // Refresh recent runs
    fetchRecentRuns();
  }

  function resetState() {
    setStep('upload');
    setUploadedFile(null);
    setStyleNo('');
    setFileTariff('');
    setInputRows([]);
    setRunId(null);
    setStyleMeta(null);
    setOutputRows([]);
  }

  async function downloadXlsx() {
    if (outputRows.length === 0) return;

    try {
      setBusy(true);
      const [XLSX, { default: saveAs }] = await Promise.all([
        import('xlsx'),
        import('file-saver'),
      ]);

      const wb = XLSX.utils.book_new();

      // Build data array with Danish number formatting
      const sheetData = [
        [...OUTPUT_COLUMNS],
        ...outputRows.map((r) => {
          const arr = rowToArray(r);
          return arr.map((cell, colIndex) => {
            // Keep numbers as numbers for Excel, but format strings for display columns
            if (cell == null) return '';
            return cell;
          });
        }),
      ];

      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      XLSX.utils.book_append_sheet(wb, ws, 'Correction');

      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      const fileName = uploadedFile
        ? `Correction_${styleNo}_${uploadedFile.name.replace(/\.xlsx?$/i, '')}.xlsx`
        : `Correction_${styleNo}.xlsx`;

      saveAs(blob, fileName);
    } catch (e: any) {
      alert(e?.message || 'Failed to export XLSX');
    } finally {
      setBusy(false);
    }
  }

  async function loadRun(run: Run) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/finance/correction-runs/${run.id}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to load run');
      }

      const data = await res.json();
      const runData = data.run;
      const rows = data.rows ?? [];
      // Use fresh styleMeta from API (re-looked up from styles table)
      const freshStyleMeta = data.styleMeta;

      setRunId(runData.id);
      setStyleNo(runData.style_no);
      setFileTariff(runData.file_customs_tariff || '');
      // Use fresh style data from the database lookup
      setStyleMeta(freshStyleMeta || {
        style_no: runData.style_no,
        style_name: runData.style_name,
        cost_price: runData.cost_price,
        cost_price_currency: runData.cost_price_currency,
        customs_tariff_no: runData.customs_tariff_no,
        country_of_origin: runData.country_of_origin,
      });
      setOutputRows(rows);
      setUploadedFile(null);
      setInputRows([]);
      setStep('preview');
    } catch (e: any) {
      setError(e?.message || 'Failed to load run');
    } finally {
      setBusy(false);
    }
  }

  async function deleteRun(run: Run) {
    if (!confirm(`Delete run "${run.toldref || run.style_name || run.style_no}"?\n\nThis will permanently delete the run and all its rows.`)) {
      return;
    }
    
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/finance/correction-runs/${run.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to delete run');
      }

      // Refresh the list
      await fetchRecentRuns();
      
      // If we were viewing this run, reset state
      if (runId === run.id) {
        resetState();
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to delete run');
    } finally {
      setBusy(false);
    }
  }

  const formatDateDK = (d: string | null) => {
    if (!d) return '';
    const date = new Date(d);
    return date.toLocaleDateString('da-DK', { day: '2-digit', month: '2-digit', year: '2-digit' });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-500 font-medium">Finance</p>
          <h1 className="text-2xl font-bold tracking-tight">CORRECTION</h1>
        </div>
        {step === 'preview' && (
          <Badge className="text-sm bg-slate-100 text-slate-700">
            {outputRows.length.toLocaleString('da-DK')} rækker
          </Badge>
        )}
      </div>

      {/* Error Alert */}
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-800">
          <div className="flex items-start gap-3">
            <svg className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
            </svg>
            <span>{error}</span>
          </div>
        </div>
      )}

      {/* Upload Section */}
      <Card className="border-slate-200 shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-base font-semibold">Upload Excel File</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-slate-600">
            Upload an Excel file with <span className="font-medium">Style No in C1</span>, optional Customs Tariff in C2, 
            header at row 4 (A–N), and data from row 5.
          </p>
          <Dropzone accept=".xlsx,.xls" multiple={false} onFiles={onFilesSelected} />
          {uploadedFile && (
            <div className="flex items-center justify-between bg-slate-50 rounded-lg px-4 py-3">
              <div className="flex items-center gap-3">
                <svg className="h-5 w-5 text-green-600" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
                </svg>
                <span className="text-sm font-medium text-slate-700">{uploadedFile.name}</span>
              </div>
              <Button size="sm" variant="outline" onClick={resetState} disabled={busy}>
                Reset
              </Button>
            </div>
          )}
          {styleNo && step === 'upload' && (
            <div className="flex flex-wrap gap-2">
              <Badge className="border-slate-300">Style: {styleNo}</Badge>
              {fileTariff && <Badge className="border-slate-300">Tariff: {fileTariff}</Badge>}
              {inputRows.length > 0 && (
                <Badge className="bg-slate-100 text-slate-700">{inputRows.length.toLocaleString('da-DK')} rows parsed</Badge>
              )}
            </div>
          )}
          {busy && step === 'upload' && (
            <div className="flex items-center gap-2 text-sm text-blue-600">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Processing...
            </div>
          )}
        </CardContent>
      </Card>

      {/* Preview Section */}
      {step === 'preview' && outputRows.length > 0 && (
        <>
          {/* Style Metadata Card */}
          {styleMeta && (
            <Card className="border-slate-200 shadow-sm bg-gradient-to-r from-slate-50 to-white">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">Style Information</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-6">
                  <div>
                    <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">Style No</p>
                    <p className="text-lg font-bold font-mono text-slate-900">{styleMeta.style_no}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">Style Name</p>
                    <p className="text-lg font-semibold text-slate-900">{styleMeta.style_name || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">Cost Price</p>
                    <p className="text-lg font-semibold text-slate-900">
                      {styleMeta.cost_price != null
                        ? `${formatDanishNumber(styleMeta.cost_price)} ${styleMeta.cost_price_currency || ''}`
                        : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">Customs Tariff</p>
                    <p className="text-lg font-mono text-slate-900">{styleMeta.customs_tariff_no || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">Origin</p>
                    <p className="text-lg font-semibold text-slate-900">{styleMeta.country_of_origin || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">Rows</p>
                    <p className="text-lg font-bold text-slate-900">{outputRows.length.toLocaleString('da-DK')}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Data Table */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-base font-semibold">
                Output Data
              </CardTitle>
              <Badge className="bg-slate-100 text-slate-700">{outputRows.length.toLocaleString('da-DK')} rows</Badge>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto max-h-[600px] overflow-y-auto border-t">
                <Table>
                  <TableHeader className="sticky top-0 bg-slate-50 z-10">
                    <TableRow>
                      {OUTPUT_COLUMNS.map((col, i) => (
                        <TableHead key={i} className="whitespace-nowrap bg-slate-50 border-b">
                          {col}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {outputRows.map((row, i) => {
                      const arr = rowToArray(row);
                      return (
                        <TableRow key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}>
                          {arr.map((cell, j) => (
                            <TableCell key={j} className="whitespace-nowrap font-mono text-xs">
                              {formatCell(cell, j)}
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* Download Section */}
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="pt-6">
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={downloadXlsx} disabled={busy} className="gap-2">
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
                    <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
                  </svg>
                  Download XLSX
                </Button>
                <Button variant="outline" onClick={resetState} disabled={busy}>
                  Upload New File
                </Button>
                {runId && (
                  <span className="text-xs text-slate-500 ml-auto">
                    Run: <code className="bg-slate-100 px-1.5 py-0.5 rounded">{runId.slice(0, 8)}...</code>
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Recent Runs */}
      <Card className="border-slate-200 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">Recent Runs</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loadingRuns ? (
            <div className="p-6 text-sm text-slate-500 flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Loading...
            </div>
          ) : recentRuns.length === 0 ? (
            <div className="p-6 text-sm text-slate-500">No recent runs found.</div>
          ) : (
            <div className="border-t">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Toldref</TableHead>
                    <TableHead>Varenavn</TableHead>
                    <TableHead>Date Range</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead className="w-[120px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentRuns.map((run, i) => {
                    const dateRange = run.first_date && run.last_date
                      ? run.first_date === run.last_date
                        ? formatDateDK(run.first_date)
                        : `${formatDateDK(run.first_date)} – ${formatDateDK(run.last_date)}`
                      : '—';
                    
                    return (
                      <TableRow key={run.id} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}>
                        <TableCell className="font-mono font-medium">{run.toldref || '—'}</TableCell>
                        <TableCell>{run.style_name || run.style_no || '—'}</TableCell>
                        <TableCell className="whitespace-nowrap text-slate-600">{dateRange}</TableCell>
                        <TableCell className="text-right font-mono">{run.row_count.toLocaleString('da-DK')}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => loadRun(run)}
                              disabled={busy}
                              className="h-7 px-2 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                            >
                              Load
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => deleteRun(run)}
                              disabled={busy}
                              className="h-7 px-2 text-red-600 hover:text-red-700 hover:bg-red-50"
                            >
                              Delete
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

'use client';

import * as React from 'react';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Dropzone } from '../../../components/ui/dropzone';

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
  'Ny toldlager',
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

      // Build data array
      const sheetData = [
        [...OUTPUT_COLUMNS],
        ...outputRows.map((r) => rowToArray(r)),
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

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Finance</div>
        <h1 className="text-xl font-semibold">CORRECTION</h1>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Upload Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Upload Excel File</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-gray-600">
            Upload an Excel file with Style No in cell C1, optional Customs Tariff in C2, 
            header row at row 4 (A–N), and data from row 5 onwards.
          </p>
          <Dropzone accept=".xlsx,.xls" multiple={false} onFiles={onFilesSelected} />
          {uploadedFile && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-700">
                Uploaded: <strong>{uploadedFile.name}</strong>
              </span>
              <Button size="sm" variant="outline" onClick={resetState} disabled={busy}>
                Reset
              </Button>
            </div>
          )}
          {styleNo && step === 'upload' && (
            <div className="text-xs text-gray-600">
              Style No: <span className="font-mono font-semibold">{styleNo}</span>
              {fileTariff && (
                <> | Customs Tariff (file): <span className="font-mono">{fileTariff}</span></>
              )}
              {inputRows.length > 0 && (
                <> | {inputRows.length.toLocaleString('da-DK')} row(s) parsed</>
              )}
            </div>
          )}
          {busy && step === 'upload' && (
            <div className="text-xs text-blue-600">Processing...</div>
          )}
        </CardContent>
      </Card>

      {/* Preview Section */}
      {step === 'preview' && outputRows.length > 0 && (
        <>
          {/* Style Metadata Card */}
          {styleMeta && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Style Information</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 text-sm">
                  <div>
                    <div className="text-xs text-gray-500">Style No</div>
                    <div className="font-mono font-semibold">{styleMeta.style_no}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">Style Name</div>
                    <div className="font-medium">{styleMeta.style_name || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">Cost Price</div>
                    <div className="font-medium">
                      {styleMeta.cost_price != null
                        ? `${styleMeta.cost_price.toFixed(2)} ${styleMeta.cost_price_currency || ''}`
                        : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">Customs Tariff</div>
                    <div className="font-mono">{styleMeta.customs_tariff_no || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">Country of Origin</div>
                    <div className="font-medium">{styleMeta.country_of_origin || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">Rows</div>
                    <div className="font-medium">{outputRows.length.toLocaleString('da-DK')}</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Data Preview */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">
                Output Data ({outputRows.length.toLocaleString('da-DK')} rows)
              </CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="min-w-max text-xs border-collapse">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-gray-50">
                    {OUTPUT_COLUMNS.map((col, i) => (
                      <th key={i} className="border px-2 py-1 text-left font-medium whitespace-nowrap bg-gray-50">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {outputRows.map((row, i) => {
                    const arr = rowToArray(row);
                    return (
                      <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                        {arr.map((cell, j) => (
                          <td key={j} className="border px-2 py-1 whitespace-nowrap">
                            {typeof cell === 'number'
                              ? cell.toLocaleString('da-DK', { maximumFractionDigits: 2 })
                              : String(cell ?? '')}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>

          {/* Download Section */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Download</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                <Button onClick={downloadXlsx} disabled={busy}>
                  Download XLSX
                </Button>
                <Button variant="outline" onClick={resetState} disabled={busy}>
                  Upload New File
                </Button>
              </div>
              {runId && (
                <p className="text-xs text-gray-500 mt-2">
                  Run ID: <span className="font-mono">{runId}</span>
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* Recent Runs */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Recent Runs</CardTitle>
        </CardHeader>
        <CardContent>
          {loadingRuns ? (
            <div className="text-xs text-gray-500">Loading...</div>
          ) : recentRuns.length === 0 ? (
            <div className="text-xs text-gray-500">No recent runs found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="border px-2 py-1 text-left font-medium">Toldref</th>
                    <th className="border px-2 py-1 text-left font-medium">Varenavn</th>
                    <th className="border px-2 py-1 text-left font-medium">Date Range</th>
                    <th className="border px-2 py-1 text-right font-medium">Rows</th>
                    <th className="border px-2 py-1 text-left font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRuns.map((run, i) => {
                    // Format date range
                    const formatDate = (d: string | null) => {
                      if (!d) return '';
                      const date = new Date(d);
                      return date.toLocaleDateString('da-DK', { day: '2-digit', month: '2-digit', year: '2-digit' });
                    };
                    const dateRange = run.first_date && run.last_date
                      ? run.first_date === run.last_date
                        ? formatDate(run.first_date)
                        : `${formatDate(run.first_date)} – ${formatDate(run.last_date)}`
                      : '—';
                    
                    return (
                      <tr key={run.id} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                        <td className="border px-2 py-1 font-mono">{run.toldref || '—'}</td>
                        <td className="border px-2 py-1">{run.style_name || run.style_no || '—'}</td>
                        <td className="border px-2 py-1 whitespace-nowrap">{dateRange}</td>
                        <td className="border px-2 py-1 text-right">{run.row_count.toLocaleString('da-DK')}</td>
                        <td className="border px-2 py-1">
                          <div className="flex items-center gap-2">
                            <button
                              className="text-blue-600 hover:underline"
                              onClick={() => loadRun(run)}
                              disabled={busy}
                            >
                              Load
                            </button>
                            <button
                              className="text-red-600 hover:underline"
                              onClick={() => deleteRun(run)}
                              disabled={busy}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

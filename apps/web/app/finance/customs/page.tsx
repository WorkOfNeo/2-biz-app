'use client';

import * as React from 'react';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Dropzone } from '../../../components/ui/dropzone';
import {
  detectSections,
  normalizeRows,
  detectCurrencyMonthCombos,
  buildDefaultRates,
  calculateValues,
  generateSummary,
  rowToProcessedArray,
  summaryRowToArray,
  PROCESSED_COLUMNS,
  SUMMARY_COLUMNS,
  PROCESSED_NUMERIC_COLS,
  SUMMARY_NUMERIC_COLS,
  type RawSection,
  type NormalizedRow,
  type CalculatedRow,
  type SummaryRow,
  type CurrencyMonthCombo,
} from '../../../lib/customs/customsProcessor';

type Step = 'upload' | 'rates' | 'preview';

export default function CustomsPage() {
  // ─────────────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────────────
  const [step, setStep] = React.useState<Step>('upload');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // File data
  const [uploadedFile, setUploadedFile] = React.useState<File | null>(null);
  const [uploadedBuffer, setUploadedBuffer] = React.useState<ArrayBuffer | null>(null);
  const [rawData, setRawData] = React.useState<any[][] | null>(null);

  // Parsing results
  const [sections, setSections] = React.useState<RawSection[]>([]);
  const [normalizedRows, setNormalizedRows] = React.useState<NormalizedRow[]>([]);
  const [currencyCombos, setCurrencyCombos] = React.useState<CurrencyMonthCombo[]>([]);

  // Currency rates
  const [rates, setRates] = React.useState<Record<string, number>>({});

  // Calculated data
  const [calculatedRows, setCalculatedRows] = React.useState<CalculatedRow[]>([]);
  const [summaryData, setSummaryData] = React.useState<SummaryRow[]>([]);

  // ─────────────────────────────────────────────────────────────────────────
  // File Upload & Parsing
  // ─────────────────────────────────────────────────────────────────────────
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
      setUploadedBuffer(buf);

      const wb = XLSX.read(buf, { type: 'array' });
      const sheetName = wb.SheetNames?.[0];
      if (!sheetName) throw new Error('No sheet found in the Excel file');

      const sheet = wb.Sheets[sheetName];
      if (!sheet) throw new Error('Empty sheet');

      const data = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];
      if (data.length === 0) throw new Error('Sheet contains no data');

      // Log first 100 rows for debugging
      console.log('First 100 rows of raw Excel data:');
      console.log(data.slice(0, 100));

      setRawData(data);

      // Detect sections
      const detectedSections = detectSections(data);
      if (detectedSections.length === 0) {
        throw new Error(
          'No sections detected. Looking for rows containing "Fortoldnings ref. nr." or "Fortoldningens ref. nr."'
        );
      }
      setSections(detectedSections);

      // Normalize rows
      const normalized = normalizeRows(data, detectedSections);
      if (normalized.length === 0) {
        throw new Error('No transaction rows found (rows with Antal value in column 13)');
      }
      setNormalizedRows(normalized);

      // Detect currency-month combinations
      const combos = detectCurrencyMonthCombos(normalized);
      setCurrencyCombos(combos);

      // Build default rates (DKK = 1.0, others = 0)
      const defaultRates = buildDefaultRates(combos);
      setRates(defaultRates);

      // Move to rates step
      setStep('rates');
    } catch (e: any) {
      setError(e?.message || 'Failed to parse file');
    } finally {
      setBusy(false);
    }
  }

  function resetState() {
    setStep('upload');
    setUploadedFile(null);
    setUploadedBuffer(null);
    setRawData(null);
    setSections([]);
    setNormalizedRows([]);
    setCurrencyCombos([]);
    setRates({});
    setCalculatedRows([]);
    setSummaryData([]);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Rate Entry
  // ─────────────────────────────────────────────────────────────────────────
  function handleRateChange(key: string, value: string) {
    const num = parseFloat(value.replace(',', '.'));
    setRates((prev) => ({
      ...prev,
      [key]: Number.isFinite(num) ? num : 0,
    }));
  }

  function validateRates(): boolean {
    for (const combo of currencyCombos) {
      if (combo.currency.toUpperCase() === 'DKK') continue;
      const rate = rates[combo.key];
      if (!rate || rate <= 0) {
        return false;
      }
    }
    return true;
  }

  function applyRates() {
    if (!validateRates()) {
      setError('Please enter valid exchange rates for all non-DKK currencies');
      return;
    }
    setError(null);

    // Calculate values
    const calculated = calculateValues(normalizedRows, rates);
    setCalculatedRows(calculated);

    // Generate summary
    const summary = generateSummary(calculated);
    setSummaryData(summary);

    // Move to preview step
    setStep('preview');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Export Functions
  // ─────────────────────────────────────────────────────────────────────────
  async function applyNumberFormatting(
    XLSX: any,
    ws: any,
    numericCols: number[],
    rowCount: number
  ) {
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    for (let R = 1; R <= rowCount; R++) {
      // Start from row 1 (skip header)
      for (const C of numericCols) {
        const cellAddr = XLSX.utils.encode_cell({ r: R, c: C });
        const cell = ws[cellAddr];
        if (cell && typeof cell.v === 'number') {
          cell.t = 'n';
          cell.z = '#,##0.0'; // Danish format uses comma for decimal
        }
      }
    }
  }

  async function createProcessedWorkbook(): Promise<ArrayBuffer> {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();

    // Processed Data sheet
    const processedData = [
      [...PROCESSED_COLUMNS],
      ...calculatedRows.map((r) => rowToProcessedArray(r)),
    ];
    const wsProcessed = XLSX.utils.aoa_to_sheet(processedData);
    await applyNumberFormatting(XLSX, wsProcessed, PROCESSED_NUMERIC_COLS, calculatedRows.length);
    XLSX.utils.book_append_sheet(wb, wsProcessed, 'Processed Data');

    // Summary sheet
    const summaryDataArr = [
      [...SUMMARY_COLUMNS],
      ...summaryData.map((r) => summaryRowToArray(r)),
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryDataArr);
    await applyNumberFormatting(XLSX, wsSummary, SUMMARY_NUMERIC_COLS, summaryData.length);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

    // All Transactions sheet (same as Processed Data)
    const wsAllTx = XLSX.utils.aoa_to_sheet(processedData);
    await applyNumberFormatting(XLSX, wsAllTx, PROCESSED_NUMERIC_COLS, calculatedRows.length);
    XLSX.utils.book_append_sheet(wb, wsAllTx, 'All Transactions');

    const bytes: Uint8Array = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async function createSingleSheetWorkbook(
    sheetName: string,
    data: any[][],
    numericCols: number[]
  ): Promise<ArrayBuffer> {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(data);
    await applyNumberFormatting(XLSX, ws, numericCols, data.length - 1);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const bytes: Uint8Array = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async function downloadZip() {
    try {
      setBusy(true);
      const [JSZip, { default: saveAs }] = await Promise.all([
        import('jszip'),
        import('file-saver'),
      ]);

      const zip = new JSZip.default();

      // Add original file
      if (uploadedBuffer) {
        zip.file('Original.xlsx', uploadedBuffer);
      }

      // Add processed workbook
      const processedBytes = await createProcessedWorkbook();
      zip.file('Processed.xlsx', processedBytes);

      // Generate and download
      const blob = await zip.generateAsync({ type: 'blob' });
      saveAs(blob, 'Export.zip');
    } catch (e: any) {
      alert(e?.message || 'Failed to create ZIP');
    } finally {
      setBusy(false);
    }
  }

  async function downloadProcessedData() {
    try {
      setBusy(true);
      const { default: saveAs } = await import('file-saver');

      const data = [
        [...PROCESSED_COLUMNS],
        ...calculatedRows.map((r) => rowToProcessedArray(r)),
      ];
      const bytes = await createSingleSheetWorkbook('Processed Data', data, PROCESSED_NUMERIC_COLS);
      const blob = new Blob([bytes], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      saveAs(blob, 'Processed_Data.xlsx');
    } catch (e: any) {
      alert(e?.message || 'Failed to export');
    } finally {
      setBusy(false);
    }
  }

  async function downloadSummary() {
    try {
      setBusy(true);
      const { default: saveAs } = await import('file-saver');

      const data = [...SUMMARY_COLUMNS].map((c) => c);
      const dataArr = [[...SUMMARY_COLUMNS], ...summaryData.map((r) => summaryRowToArray(r))];
      const bytes = await createSingleSheetWorkbook('Summary', dataArr, SUMMARY_NUMERIC_COLS);
      const blob = new Blob([bytes], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      saveAs(blob, 'Summary.xlsx');
    } catch (e: any) {
      alert(e?.message || 'Failed to export');
    } finally {
      setBusy(false);
    }
  }

  async function downloadAllTransactions() {
    try {
      setBusy(true);
      const { default: saveAs } = await import('file-saver');

      const data = [
        [...PROCESSED_COLUMNS],
        ...calculatedRows.map((r) => rowToProcessedArray(r)),
      ];
      const bytes = await createSingleSheetWorkbook(
        'All Transactions',
        data,
        PROCESSED_NUMERIC_COLS
      );
      const blob = new Blob([bytes], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      saveAs(blob, 'All_Transactions.xlsx');
    } catch (e: any) {
      alert(e?.message || 'Failed to export');
    } finally {
      setBusy(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Group combos by month for display
  // ─────────────────────────────────────────────────────────────────────────
  const combosByMonth = React.useMemo(() => {
    const grouped: Record<string, CurrencyMonthCombo[]> = {};
    for (const combo of currencyCombos) {
      if (!grouped[combo.yearMonth]) {
        grouped[combo.yearMonth] = [];
      }
      grouped[combo.yearMonth].push(combo);
    }
    return grouped;
  }, [currencyCombos]);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Finance</div>
        <h1 className="text-xl font-semibold">Customs</h1>
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
          {sections.length > 0 && (
            <div className="text-xs text-gray-600">
              Detected {sections.length} section(s):{' '}
              <span className="font-mono">{sections.map((s) => s.refNr).join(', ')}</span>
            </div>
          )}
          {normalizedRows.length > 0 && (
            <div className="text-xs text-gray-600">
              {normalizedRows.length.toLocaleString('da-DK')} transaction rows found
            </div>
          )}
        </CardContent>
      </Card>

      {/* Currency Rates Section */}
      {step === 'rates' && currencyCombos.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Currency Exchange Rates</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-gray-600">
              Enter exchange rates for each currency-month combination. DKK is locked at 1.0.
            </p>
            {Object.entries(combosByMonth)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([yearMonth, combos]) => (
                <div key={yearMonth}>
                  <h4 className="text-sm font-medium mb-2">{yearMonth}</h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {combos.map((combo) => {
                      const isDKK = combo.currency.toUpperCase() === 'DKK';
                      return (
                        <div key={combo.key}>
                          <label className="block text-xs text-gray-700 mb-1">
                            {combo.currency}
                          </label>
                          <Input
                            type="text"
                            value={isDKK ? '1.0' : rates[combo.key]?.toString() || ''}
                            onChange={(e) => handleRateChange(combo.key, e.target.value)}
                            disabled={isDKK}
                            className={isDKK ? 'bg-gray-100' : ''}
                            placeholder="e.g. 7.45"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            <Button onClick={applyRates} disabled={busy}>
              Apply Rates & Calculate
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Preview Section */}
      {step === 'preview' && calculatedRows.length > 0 && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">
                Data Preview (first 50 of {calculatedRows.length.toLocaleString('da-DK')} rows)
              </CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="min-w-max text-xs border-collapse">
                <thead>
                  <tr className="bg-gray-50">
                    {PROCESSED_COLUMNS.map((col, i) => (
                      <th key={i} className="border px-2 py-1 text-left font-medium whitespace-nowrap">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {calculatedRows.slice(0, 50).map((row, i) => {
                    const arr = rowToProcessedArray(row);
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

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Summary by Varenr</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="min-w-max text-xs border-collapse">
                <thead>
                  <tr className="bg-gray-50">
                    {SUMMARY_COLUMNS.map((col, i) => (
                      <th key={i} className="border px-2 py-1 text-left font-medium whitespace-nowrap">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {summaryData.map((row, i) => {
                    const arr = summaryRowToArray(row);
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

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Download Options</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                <Button onClick={downloadZip} disabled={busy}>
                  Download ZIP
                </Button>
                <Button variant="outline" onClick={downloadProcessedData} disabled={busy}>
                  Download Processed Data
                </Button>
                <Button variant="outline" onClick={downloadSummary} disabled={busy}>
                  Download Summary
                </Button>
                <Button variant="outline" onClick={downloadAllTransactions} disabled={busy}>
                  Download All Transactions
                </Button>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                ZIP contains Original.xlsx + Processed.xlsx (with 3 sheets: Processed Data, Summary, All Transactions)
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}


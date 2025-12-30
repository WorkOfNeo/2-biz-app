/**
 * Customs Excel Processor
 * Handles parsing, normalization, currency detection, calculations, and summary generation
 * for Danish customs/warehouse Excel files.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RawSection {
  refNr: string;
  startRow: number;
}

export interface NormalizedRow {
  // Section header (columns 0-7)
  Varenr: string;
  Varenavn: string;
  Pris: number;
  Valuta: string;
  Toldtariff: string;
  Oprindelsesland: string;
  GammelToldlager: string;
  NyToldlager: string;
  // Transaction data (columns 8-13)
  Dato: string;
  Reference: string;
  IndUd: string;
  EksportRef: string;
  EksportTil: string;
  Antal: number;
  // Added fields
  Toldref: string;
  Day: string;
  Month: string;
  Year: string;
}

export interface CalculatedRow extends NormalizedRow {
  Værdi: number;
  Kurs: number;
  TotalDKKVærdi: number;
  Fraførselsref: string;
  NonEUUdførsel: string;
}

export interface SummaryRow {
  Varenr: string;
  IndAntal: number;
  IndVærdi: number;
  UdAntal: number;
  UdVærdi: number;
}

export interface CurrencyMonthCombo {
  currency: string;
  yearMonth: string;
  key: string; // `${currency}_${yearMonth}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Section Detection
// ─────────────────────────────────────────────────────────────────────────────

const SECTION_MARKER_PATTERNS = [
  /Fortoldnings\s*ref\.?\s*nr\.?/i,
  /Fortoldningens\s*ref\.?\s*nr\.?/i,
];

export function isSectionMarker(cellValue: any): boolean {
  const str = String(cellValue ?? '').trim();
  return SECTION_MARKER_PATTERNS.some((p) => p.test(str));
}

export function extractRefNr(cellValue: any): string {
  let str = String(cellValue ?? '').trim();
  // Remove the prefix patterns
  str = str.replace(/Fortoldnings\s*ref\.?\s*nr\.?/i, '');
  str = str.replace(/Fortoldningens\s*ref\.?\s*nr\.?/i, '');
  return str.trim();
}

export function detectSections(data: any[][]): RawSection[] {
  const sections: RawSection[] = [];
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length === 0) continue;
    if (isSectionMarker(row[0])) {
      sections.push({
        refNr: extractRefNr(row[0]),
        startRow: i,
      });
    }
  }
  console.log(
    `Detected ${sections.length} sections with references: [${sections.map((s) => s.refNr).join(', ')}]`
  );
  return sections;
}

// ─────────────────────────────────────────────────────────────────────────────
// Date Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts Excel serial date to YYYY-MM-DD string.
 * Excel serial dates count days since 1899-12-30 (with the 1900 leap year bug).
 */
function excelSerialToDate(serial: number): string {
  // Excel epoch: 1899-12-30 (accounting for the 1900 leap year bug)
  const epoch = new Date(Date.UTC(1899, 11, 30));
  const ms = epoch.getTime() + serial * 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function parseDate(val: any): { date: string; day: string; month: string; year: string } {
  let dateStr = '';

  if (val == null || val === '') {
    return { date: '', day: '', month: '', year: '' };
  }

  if (typeof val === 'number') {
    // Excel serial number
    dateStr = excelSerialToDate(val);
  } else if (val instanceof Date) {
    const yyyy = val.getFullYear();
    const mm = String(val.getMonth() + 1).padStart(2, '0');
    const dd = String(val.getDate()).padStart(2, '0');
    dateStr = `${yyyy}-${mm}-${dd}`;
  } else {
    const str = String(val).trim();
    // Try YYYY-MM-DD format
    const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch && isoMatch[1] && isoMatch[2] && isoMatch[3]) {
      dateStr = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    } else {
      // Try DD-MM-YYYY or DD/MM/YYYY
      const euMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
      if (euMatch && euMatch[1] && euMatch[2] && euMatch[3]) {
        dateStr = `${euMatch[3]}-${euMatch[2].padStart(2, '0')}-${euMatch[1].padStart(2, '0')}`;
      } else {
        // Fallback: try parsing as number (Excel serial)
        const num = Number(str);
        if (!isNaN(num) && num > 1000 && num < 100000) {
          dateStr = excelSerialToDate(num);
        }
      }
    }
  }

  if (!dateStr) {
    return { date: String(val), day: '', month: '', year: '' };
  }

  const parts = dateStr.split('-');
  return {
    date: dateStr,
    year: parts[0] || '',
    month: parts[1] || '',
    day: parts[2] || '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────────────────────────────────────

function toNumber(val: any): number {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  const str = String(val ?? '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const n = parseFloat(str);
  return Number.isFinite(n) ? n : 0;
}

function toString(val: any): string {
  return String(val ?? '').trim();
}

export function normalizeRows(data: any[][], sections: RawSection[]): NormalizedRow[] {
  const rows: NormalizedRow[] = [];
  let currentSection: RawSection | null = null;
  let sectionIdx = 0;
  let headerTemplate: any[] | null = null;

  // Build a map of section start rows for quick lookup
  const sectionStartRows = new Set(sections.map((s) => s.startRow));

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row) continue;

    // Check if this is a section marker row
    if (sectionStartRows.has(i)) {
      currentSection = sections[sectionIdx] ?? null;
      sectionIdx++;
      headerTemplate = null;
      continue;
    }

    // Skip if we haven't entered a section yet
    if (!currentSection) continue;

    // Skip the column header row (first row after section marker typically contains headers)
    // We detect this by checking if column 0 or column 13 looks like a header
    const col0 = toString(row[0]).toLowerCase();
    const col13 = toString(row[13]).toLowerCase();
    
    // List of header keywords to skip
    const headerKeywords = [
      'varenr', 'varenummer', 'item number', 'item', 'varenavn', 
      'pris', 'valuta', 'toldtariff', 'oprindelsesland',
      'antal', 'quantity', 'dato', 'date', 'reference', 'ind/ud',
      'gammel', 'ny', 'eksport'
    ];
    
    const isHeaderRow = headerKeywords.some(keyword => 
      col0.includes(keyword) || col13.includes(keyword)
    );
    
    if (isHeaderRow) {
      continue;
    }

    // Check if this is a transaction row (has Antal in column 13)
    const antalRaw = row[13];
    if (antalRaw == null || antalRaw === '') continue;
    
    // Skip if Antal is not a valid number (could be text)
    const antalStr = toString(antalRaw);
    const antal = toNumber(antalRaw);
    if (!Number.isFinite(antal) || (antal === 0 && !/^[0-9\s.,\-]+$/.test(antalStr))) {
      continue;
    }

    // Determine if this is the first data row of the section (has columns 0-7 populated)
    const hasHeader = row[0] != null && toString(row[0]) !== '';

    if (hasHeader) {
      // Store header template
      headerTemplate = row.slice(0, 8);
    }

    if (!headerTemplate) {
      // Skip rows without a header template
      continue;
    }

    // Parse the date
    const dateInfo = parseDate(row[8]);

    const normalized: NormalizedRow = {
      Varenr: toString(headerTemplate[0]),
      Varenavn: toString(headerTemplate[1]),
      Pris: toNumber(headerTemplate[2]),
      Valuta: toString(headerTemplate[3]),
      Toldtariff: toString(headerTemplate[4]),
      Oprindelsesland: toString(headerTemplate[5]),
      GammelToldlager: toString(headerTemplate[6]),
      NyToldlager: toString(headerTemplate[7]),
      Dato: dateInfo.date,
      Reference: toString(row[9]),
      IndUd: toString(row[10]),
      EksportRef: toString(row[11]),
      EksportTil: toString(row[12]),
      Antal: antal,
      Toldref: currentSection.refNr,
      Day: dateInfo.day,
      Month: dateInfo.month,
      Year: dateInfo.year,
    };

    rows.push(normalized);
  }

  console.log(`Processed ${rows.length} total transaction rows`);
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Currency-Month Detection
// ─────────────────────────────────────────────────────────────────────────────

export function detectCurrencyMonthCombos(rows: NormalizedRow[]): CurrencyMonthCombo[] {
  const combos = new Map<string, CurrencyMonthCombo>();

  for (const row of rows) {
    if (!row.Valuta || !row.Year || !row.Month) continue;
    const yearMonth = `${row.Year}-${row.Month}`;
    const key = `${row.Valuta}_${yearMonth}`;
    if (!combos.has(key)) {
      combos.set(key, {
        currency: row.Valuta,
        yearMonth,
        key,
      });
    }
  }

  const result = Array.from(combos.values()).sort((a, b) => {
    // Sort by yearMonth first, then by currency
    const cmp = a.yearMonth.localeCompare(b.yearMonth);
    if (cmp !== 0) return cmp;
    return a.currency.localeCompare(b.currency);
  });

  console.log(`Found ${result.length} unique currency-month combinations`);
  return result;
}

export function buildDefaultRates(combos: CurrencyMonthCombo[]): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const combo of combos) {
    if (combo.currency.toUpperCase() === 'DKK') {
      rates[combo.key] = 1.0;
    } else {
      rates[combo.key] = 0; // Needs to be filled in by user
    }
  }
  return rates;
}

// ─────────────────────────────────────────────────────────────────────────────
// Calculations
// ─────────────────────────────────────────────────────────────────────────────

export function calculateValues(
  rows: NormalizedRow[],
  rates: Record<string, number>
): CalculatedRow[] {
  return rows.map((row) => {
    const key = `${row.Valuta}_${row.Year}-${row.Month}`;
    const kurs = rates[key] ?? 1;
    const værdi = row.Antal * row.Pris;
    const totalDKK = værdi * kurs;

    return {
      ...row,
      Værdi: værdi,
      Kurs: kurs,
      TotalDKKVærdi: totalDKK,
      Fraførselsref: '',
      NonEUUdførsel: '',
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary Generation
// ─────────────────────────────────────────────────────────────────────────────

export function generateSummary(rows: CalculatedRow[]): SummaryRow[] {
  const grouped = new Map<string, SummaryRow>();

  for (const row of rows) {
    const key = row.Varenr;
    let summary = grouped.get(key);
    if (!summary) {
      summary = {
        Varenr: key,
        IndAntal: 0,
        IndVærdi: 0,
        UdAntal: 0,
        UdVærdi: 0,
      };
      grouped.set(key, summary);
    }

    const direction = row.IndUd.toLowerCase();
    if (direction === 'ind') {
      summary.IndAntal += row.Antal;
      summary.IndVærdi += row.TotalDKKVærdi;
    } else if (direction === 'ud') {
      summary.UdAntal += row.Antal;
      summary.UdVærdi += row.TotalDKKVærdi;
    }
  }

  return Array.from(grouped.values()).sort((a, b) => a.Varenr.localeCompare(b.Varenr));
}

// ─────────────────────────────────────────────────────────────────────────────
// Export Helpers
// ─────────────────────────────────────────────────────────────────────────────

export const PROCESSED_COLUMNS = [
  'Varenr',
  'Varenavn',
  'Pris',
  'Valuta',
  'Toldtariff',
  'Oprindelsesland',
  'Gammel toldlager',
  'Ny toldlager',
  'Dato',
  'Reference',
  'Ind/Ud',
  'Eksport ref',
  'Eksport til',
  'Antal',
  'Toldref',
  'Day',
  'Month',
  'Year',
  'Værdi',
  'Valuta',
  'Kurs',
  'Total DKK værdi',
  'Fraførselsref',
  'Non-EU (udførsel)',
] as const;

export const SUMMARY_COLUMNS = [
  'Varenr',
  'Ind Antal',
  'Ind Værdi',
  'Ud Antal',
  'Ud Værdi',
] as const;

export function rowToProcessedArray(row: CalculatedRow): any[] {
  return [
    row.Varenr,
    row.Varenavn,
    row.Pris,
    row.Valuta,
    row.Toldtariff,
    row.Oprindelsesland,
    row.GammelToldlager,
    row.NyToldlager,
    row.Dato,
    row.Reference,
    row.IndUd,
    row.EksportRef,
    row.EksportTil,
    row.Antal,
    row.Toldref,
    row.Day,
    row.Month,
    row.Year,
    row.Værdi,
    row.Valuta, // Valuta appears twice per spec
    row.Kurs,
    row.TotalDKKVærdi,
    row.Fraførselsref,
    row.NonEUUdførsel,
  ];
}

export function summaryRowToArray(row: SummaryRow): any[] {
  return [row.Varenr, row.IndAntal, row.IndVærdi, row.UdAntal, row.UdVærdi];
}

// Column indices that need Danish number formatting (#.##0,0)
// These are: Antal (13), Værdi (18), Total DKK værdi (21)
// Also in Summary: Ind Antal (1), Ind Værdi (2), Ud Antal (3), Ud Værdi (4)
export const PROCESSED_NUMERIC_COLS = [13, 18, 21];
export const SUMMARY_NUMERIC_COLS = [1, 2, 3, 4];


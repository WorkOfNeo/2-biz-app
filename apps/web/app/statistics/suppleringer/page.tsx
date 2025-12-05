'use client';
import { useMemo, useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { Loader2, Save, Download, History } from 'lucide-react';
import { supabase } from '../../../lib/supabaseClient';
import Link from 'next/link';

type ParsedRow = {
  orderType: string;
  channel: string; // Channel from column C: "Telefon" or "B2B Shop"
  customerName: string;
  accountNo: string;
  salesPerson: string;
  qtyOrdered: number;
  qtyDelivered: number;
  price: number; // in cents
  date: string | null; // Date from BO column
};

type SalespersonSummary = {
  salesPerson: string;
  totalOrderedQty: number;
  totalDeliveredQty: number;
  totalPrice: number;
  credittedQty: number;
  credittedPrice: number;
  rows: ParsedRow[];
  // Split by channel
  byChannel: {
    telefon: { stk: number; beløb: number };
    b2bShop: { stk: number; beløb: number };
    credittedStk: number;
    credittedBeløb: number;
    samletStk: number;
    samletBeløb: number;
  };
  previousYear?: {
    totalDeliveredQty: number;
    byChannel: {
      telefon: { stk: number; beløb: number };
      b2bShop: { stk: number; beløb: number };
      credittedStk: number;
      credittedBeløb: number;
      samletStk: number;
      samletBeløb: number;
    };
  } | null;
  development?: {
    totalDeliveredQty: number;
    byChannel: {
      telefon: { stk: number; beløb: number };
      b2bShop: { stk: number; beløb: number };
      credittedStk: number;
      credittedBeløb: number;
      samletStk: number;
      samletBeløb: number;
    };
  } | null;
};

type CustomerGroup = {
  customerName: string;
  accountNo: string;
  rows: ParsedRow[];
};

type SavedStatistic = {
  id: string;
  year_month: string;
  salesperson_name: string;
  total_leveret: number;
  telefon_stk: number;
  telefon_beløb: number;
  b2b_stk: number;
  b2b_beløb: number;
  krediteret_stk: number;
  krediteret_beløb: number;
  samlet_stk: number;
  samlet_beløb: number;
};

export default function SuppliersPage() {
  const [file, setFile] = useState<File | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [selectedSalesperson, setSelectedSalesperson] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<{ step: string; current: number; total: number } | null>(null);
  const [savedMonths, setSavedMonths] = useState<string[]>([]);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savedData, setSavedData] = useState<SavedStatistic[] | null>(null);
  const [savedRows, setSavedRows] = useState<ParsedRow[] | null>(null);
  const [previousYearData, setPreviousYearData] = useState<SavedStatistic[] | null>(null);
  const [previousYearRows, setPreviousYearRows] = useState<ParsedRow[] | null>(null);
  const [viewMode, setViewMode] = useState<'upload' | 'saved'>('upload');

  // Convert Excel column letter to 0-based array index
  // E.g., 'A' -> 0, 'B' -> 1, 'Z' -> 25, 'AA' -> 26, 'AN' -> 39
  function excelColToIndex(col: string): number {
    if (!col || col.length === 0) return 0;
    let result = 0;
    for (let i = 0; i < col.length; i++) {
      const char = col[i];
      if (char === undefined) continue;
      const upperChar = char.toUpperCase();
      const code = upperChar.charCodeAt(0);
      if (isNaN(code)) continue;
      result = result * 26 + (code - 'A'.charCodeAt(0) + 1);
    }
    return result - 1; // Convert to 0-based index
  }

  // Parse account_no from column G - handles both number and ="1237689" format
  function parseAccountNo(value: any): string {
    if (value === null || value === undefined) return '';
    const str = String(value).trim();
    // Handle ="1237689" format
    if (str.startsWith('="') && str.endsWith('"')) {
      return str.slice(2, -1);
    }
    // Handle regular number or string
    return str;
  }

  // Parse price from column AW (in cents, so 50730 = 507.30)
  function parsePrice(value: any): number {
    if (value === null || value === undefined) return 0;
    const num = Number(value);
    return isNaN(num) ? 0 : Math.round(num);
  }

  // Parse quantity
  function parseQty(value: any): number {
    if (value === null || value === undefined) return 0;
    const num = Number(value);
    return isNaN(num) ? 0 : Math.round(num);
  }

  // Parse date from column BO - handles both ="2025-11-04" format and regular date
  function parseDate(value: any): string | null {
    if (value === null || value === undefined) return null;
    let str = String(value).trim();
    
    // Handle ="2025-11-04" format
    if (str.startsWith('="') && str.endsWith('"')) {
      str = str.slice(2, -1);
    }
    
    // Try to parse as date - Excel might store as number (serial date) or string
    if (!str) return null;
    
    // If it's a number, it might be an Excel date serial number
    const num = Number(str);
    if (!isNaN(num) && num > 0) {
      // Excel date serial: days since 1900-01-01
      const excelEpoch = new Date(1899, 11, 30); // Dec 30, 1899
      const date = new Date(excelEpoch.getTime() + num * 86400000);
      if (!isNaN(date.getTime())) {
        const isoStr = date.toISOString();
        const datePart = isoStr.split('T')[0];
        if (datePart !== undefined && datePart !== null) {
          return datePart; // Return YYYY-MM-DD format
        }
      }
    }
    
    // Try to parse as ISO date string
    const date = new Date(str);
    if (!isNaN(date.getTime())) {
      const isoStr = date.toISOString();
      const datePart = isoStr.split('T')[0];
      if (datePart !== undefined && datePart !== null) {
        return datePart; // Return YYYY-MM-DD format
      }
    }
    
    // Return as-is if it looks like YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      return str;
    }
    
    return null;
  }

  async function parseFile(selectedFile: File) {
    try {
      setProcessing(true);
      setProgress({ step: 'Reading file...', current: 0, total: 100 });
      
      // Small delay to show progress
      await new Promise(resolve => setTimeout(resolve, 50));
      
      setProgress({ step: 'Loading Excel data...', current: 10, total: 100 });
      const buf = await selectedFile.arrayBuffer();
      
      setProgress({ step: 'Parsing spreadsheet...', current: 20, total: 100 });
      const wb = XLSX.read(buf, { type: 'array' });
      const sheetName = wb.SheetNames?.[0];
      if (!sheetName) throw new Error('No sheet found');
      const sheet = wb.Sheets[sheetName];
      if (!sheet) throw new Error('Empty sheet');

      setProgress({ step: 'Extracting data rows...', current: 30, total: 100 });
      // Read as array of arrays to access by column index
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as any[][];
      if (data.length === 0) throw new Error('Empty sheet');

      const rows: ParsedRow[] = [];
      const totalRows = data.length - 1; // Exclude header
      
      // Calculate column indices using Excel column letters
      const colB = excelColToIndex('B'); // Order type
      const colC = excelColToIndex('C'); // Channel
      const colE = excelColToIndex('E'); // Customer Name
      const colG = excelColToIndex('G'); // account_no
      const colU = excelColToIndex('U'); // Sales Person
      const colAN = excelColToIndex('AN'); // Size Quantity Ordered
      const colAO = excelColToIndex('AO'); // Size Quantity Delivered
      const colAW = excelColToIndex('AW'); // Sales Price Base Exchange Total
      const colBO = excelColToIndex('BO'); // Date

      setProgress({ step: 'Processing rows...', current: 40, total: 100 });

      // Skip header row (index 0), start from row 1
      for (let i = 1; i < data.length; i++) {
        // Update progress every 50 rows or at key milestones
        if (i % 50 === 0 || i === 1 || i === Math.floor(totalRows / 4) || i === Math.floor(totalRows / 2) || i === Math.floor(totalRows * 3 / 4)) {
          const progressPct = 40 + Math.round((i / totalRows) * 50); // 40-90%
          setProgress({ 
            step: `Processing row ${i} of ${totalRows}...`, 
            current: progressPct, 
            total: 100 
          });
          // Small delay to allow UI update
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        const row = data[i] || [];
        
        const orderType = String(row[colB] || '').trim(); // Column B
        let channel = String(row[colC] || '').trim(); // Column C
        // Translate "Sales Staff" to "Telefon"
        if (channel.toUpperCase() === 'SALES STAFF') {
          channel = 'Telefon';
        }
        const customerName = String(row[colE] || '').trim(); // Column E
        const accountNo = parseAccountNo(row[colG]); // Column G
        const salesPerson = String(row[colU] || '').trim(); // Column U
        const qtyOrdered = parseQty(row[colAN]); // Column AN
        const qtyDelivered = parseQty(row[colAO]); // Column AO
        const price = parsePrice(row[colAW]); // Column AW
        const date = parseDate(row[colBO]); // Column BO

        // Only include Stock orders
        if (orderType.toUpperCase() !== 'STOCK') continue;
        
        // Skip rows with missing essential data
        if (!customerName || !salesPerson || !accountNo) continue;

        rows.push({
          orderType,
          channel: channel || 'B2B Shop', // Default to B2B Shop if empty
          customerName,
          accountNo,
          salesPerson,
          qtyOrdered,
          qtyDelivered,
          price,
          date,
        });
      }

      setProgress({ step: 'Calculating totals...', current: 90, total: 100 });
      await new Promise(resolve => setTimeout(resolve, 50));

      setProgress({ step: 'Aggregating sales data...', current: 95, total: 100 });
      await new Promise(resolve => setTimeout(resolve, 50));
      
      setParsedRows(rows);
      setFile(selectedFile);
      setSelectedSalesperson(null);
      
      // Allow time for aggregation to complete
      await new Promise(resolve => setTimeout(resolve, 100));
      
      setProgress({ step: 'Complete!', current: 100, total: 100 });
      
      // Clear progress after a moment
      setTimeout(() => {
        setProgress(null);
        setProcessing(false);
      }, 500);
    } catch (err: any) {
      setProcessing(false);
      setProgress(null);
      alert(`Error parsing file: ${err.message}`);
      console.error('Parse error:', err);
    }
  }

  // Group by salesperson and calculate totals
  const salespersonSummaries = useMemo(() => {
    const bySalesperson = new Map<string, ParsedRow[]>();
    
    for (const row of parsedRows) {
      const key = row.salesPerson;
      if (!bySalesperson.has(key)) {
        bySalesperson.set(key, []);
      }
      bySalesperson.get(key)!.push(row);
    }

    const summaries: SalespersonSummary[] = [];
    
    for (const [salesPerson, rows] of bySalesperson.entries()) {
      let totalOrderedQty = 0;
      let totalDeliveredQty = 0;
      let totalPrice = 0;
      let credittedQty = 0;
      let credittedPrice = 0;

      // Split by channel - calculate all values
      const telefon = { stk: 0, beløb: 0 }; // Only positive values
      const b2bShop = { stk: 0, beløb: 0 }; // Only positive values
      let credittedStk = 0; // Negative quantities as positive
      let credittedBeløb = 0; // Negative prices as positive
      let samletStk = 0; // All quantities (positive - negative)
      let samletBeløb = 0; // All prices (positive - negative)

      for (const row of rows) {
        const isTelefon = row.channel === 'Telefon';
        const channelData = isTelefon ? telefon : b2bShop;
        
        // Add to total delivered (only positive)
        if (row.qtyDelivered > 0) {
          totalDeliveredQty += row.qtyDelivered;
        }
        
        // Telefon/B2B: only positive values
        if (row.qtyOrdered > 0) {
          channelData.stk += row.qtyOrdered;
          samletStk += row.qtyOrdered;
        }
        if (row.price > 0) {
          channelData.beløb += row.price;
          samletBeløb += row.price;
        }
        
        // Creditted: negative values as positive
        if (row.qtyOrdered < 0) {
          const absQty = Math.abs(row.qtyOrdered);
          credittedStk += absQty;
          samletStk -= absQty; // Subtract from samlet
        }
        if (row.price < 0) {
          const absPrice = Math.abs(row.price);
          credittedBeløb += absPrice;
          samletBeløb -= absPrice; // Subtract from samlet
        }
      }

      summaries.push({
        salesPerson,
        totalOrderedQty,
        totalDeliveredQty,
        totalPrice,
        credittedQty: credittedStk,
        credittedPrice: credittedBeløb,
        rows,
        byChannel: {
          telefon,
          b2bShop,
          credittedStk,
          credittedBeløb,
          samletStk,
          samletBeløb,
        },
      });
    }

    // Sort by salesperson name
    summaries.sort((a, b) => a.salesPerson.localeCompare(b.salesPerson));

    return summaries;
  }, [parsedRows]);

  // Get customer groups for selected salesperson (works for both upload and saved views)
  const customerGroups = useMemo(() => {
    if (!selectedSalesperson) return [];
    
    // Use saved rows if in saved view, otherwise use parsed rows
    const rowsToUse = viewMode === 'saved' && savedRows 
      ? savedRows.filter(row => row.salesPerson === selectedSalesperson)
      : (() => {
          const summary = salespersonSummaries.find(s => s.salesPerson === selectedSalesperson);
          return summary?.rows || [];
        })();

    if (rowsToUse.length === 0) return [];

    const byCustomer = new Map<string, ParsedRow[]>();
    
    for (const row of rowsToUse) {
      const key = `${row.customerName}|${row.accountNo}`;
      if (!byCustomer.has(key)) {
        byCustomer.set(key, []);
      }
      byCustomer.get(key)!.push(row);
    }

    const groups: CustomerGroup[] = [];
    
    for (const [key, rows] of byCustomer.entries()) {
      const parts = key.split('|');
      const customerName: string = parts[0] ?? '';
      const accountNo: string = parts[1] ?? '';
      if (!customerName || !accountNo) continue; // Skip invalid entries
      groups.push({
        customerName,
        accountNo,
        rows,
      });
    }

    // Sort by customer name
    groups.sort((a, b) => a.customerName.localeCompare(b.customerName));

    return groups;
  }, [selectedSalesperson, salespersonSummaries, viewMode, savedRows]);

  // Format price from cents to currency (e.g., 50730 -> 507.30)
  function formatPrice(cents: number): string {
    return (cents / 100).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Format year-month to Danish month name + year (e.g., "2025-01" -> "Januar 2025")
  function formatMonthName(yearMonth: string): string {
    const [year, month] = yearMonth.split('-');
    if (!year || !month) return yearMonth;
    const monthNum = parseInt(month, 10);
    const monthNames = [
      'Januar', 'Februar', 'Marts', 'April', 'Maj', 'Juni',
      'Juli', 'August', 'September', 'Oktober', 'November', 'December'
    ];
    const monthName = monthNames[monthNum - 1] || month;
    return `${monthName} ${year}`;
  }

  // Extract year-month from date string (YYYY-MM-DD -> YYYY-MM)
  function extractYearMonth(dateStr: string | null): string | null {
    if (!dateStr) return null;
    const match = dateStr.match(/^(\d{4}-\d{2})/);
    if (!match || !match[1]) return null;
    return match[1];
  }

  // Get the most common month from parsed rows, or use current month as fallback
  function getMonthFromRows(): string {
    const monthCounts = new Map<string, number>();
    for (const row of parsedRows) {
      const month = extractYearMonth(row.date);
      if (month) {
        monthCounts.set(month, (monthCounts.get(month) || 0) + 1);
      }
    }
    if (monthCounts.size === 0) {
      // Fallback to current month
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    // Get the month with the most entries
    let maxCount = 0;
    let mostCommonMonth = '';
    for (const [month, count] of monthCounts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        mostCommonMonth = month;
      }
    }
    return mostCommonMonth;
  }

  // Fetch available saved months
  useEffect(() => {
    async function fetchSavedMonths() {
      try {
        const { data, error } = await supabase
          .from('supp_statistic')
          .select('year_month')
          .order('year_month', { ascending: false });
        
        if (error) throw error;
        
        const uniqueMonths = Array.from(new Set((data || []).map((r: any) => r.year_month))).sort().reverse();
        setSavedMonths(uniqueMonths as string[]);
      } catch (err) {
        console.error('Error fetching saved months:', err);
      }
    }
    fetchSavedMonths();
  }, []);

  // Aggregate data per month and save to Supabase
  async function saveToSupabase() {
    if (parsedRows.length === 0) {
      alert('Ingen data at gemme. Upload en fil først.');
      return;
    }

    setSaving(true);
    try {
      const yearMonth = getMonthFromRows();
      
      // Aggregate data per salesperson for this month
      const monthRows = parsedRows.filter(row => extractYearMonth(row.date) === yearMonth);
      
      if (monthRows.length === 0) {
        alert(`Ingen data fundet for måned ${yearMonth}. Tjek datoerne i filen.`);
        setSaving(false);
        return;
      }

      const bySalesperson = new Map<string, ParsedRow[]>();
      for (const row of monthRows) {
        const key = row.salesPerson;
        if (!bySalesperson.has(key)) {
          bySalesperson.set(key, []);
        }
        bySalesperson.get(key)!.push(row);
      }

      const recordsToSave: any[] = [];

      for (const [salesPerson, rows] of bySalesperson.entries()) {
        // Calculate aggregated values (same logic as salespersonSummaries)
        const telefon = { stk: 0, beløb: 0 };
        const b2bShop = { stk: 0, beløb: 0 };
        let credittedStk = 0;
        let credittedBeløb = 0;
        let samletStk = 0;
        let samletBeløb = 0;
        let totalLeveret = 0;

        for (const row of rows) {
          const isTelefon = row.channel === 'Telefon';
          const channelData = isTelefon ? telefon : b2bShop;
          
          if (row.qtyDelivered > 0) {
            totalLeveret += row.qtyDelivered;
          }
          
          if (row.qtyOrdered > 0) {
            channelData.stk += row.qtyOrdered;
            samletStk += row.qtyOrdered;
          }
          if (row.price > 0) {
            channelData.beløb += row.price;
            samletBeløb += row.price;
          }
          
          if (row.qtyOrdered < 0) {
            const absQty = Math.abs(row.qtyOrdered);
            credittedStk += absQty;
            samletStk -= absQty;
          }
          if (row.price < 0) {
            const absPrice = Math.abs(row.price);
            credittedBeløb += absPrice;
            samletBeløb -= absPrice;
          }
        }

        recordsToSave.push({
          year_month: yearMonth,
          salesperson_name: salesPerson,
          total_leveret: totalLeveret,
          telefon_stk: telefon.stk,
          telefon_beløb: telefon.beløb,
          b2b_stk: b2bShop.stk,
          b2b_beløb: b2bShop.beløb,
          krediteret_stk: credittedStk,
          krediteret_beløb: credittedBeløb,
          samlet_stk: samletStk,
          samlet_beløb: samletBeløb,
        });
      }

      // Delete existing rows for this month first (to replace with new data)
      const { error: deleteError } = await supabase
        .from('supp_statistic_rows')
        .delete()
        .eq('year_month', yearMonth);

      if (deleteError) console.warn('Warning: Could not delete existing rows:', deleteError);

      // Save individual rows
      const rowsToSave = monthRows.map((row) => ({
        year_month: yearMonth,
        order_type: row.orderType,
        channel: row.channel,
        customer_name: row.customerName,
        account_no: row.accountNo,
        salesperson_name: row.salesPerson,
        qty_ordered: row.qtyOrdered,
        qty_delivered: row.qtyDelivered,
        price: row.price,
        date: row.date || null,
      }));

      // Insert rows in batches
      const batchSize = 500;
      for (let i = 0; i < rowsToSave.length; i += batchSize) {
        const batch = rowsToSave.slice(i, i + batchSize);
        const { error: rowsError } = await supabase
          .from('supp_statistic_rows')
          .insert(batch);
        
        if (rowsError) {
          console.error('Error saving rows batch:', rowsError);
          throw new Error(`Fejl ved gemning af rækker: ${rowsError.message}`);
        }
      }

      // Upsert aggregated records (update if exists, insert if not)
      const { error } = await supabase
        .from('supp_statistic')
        .upsert(recordsToSave, {
          onConflict: 'year_month,salesperson_name',
        });

      if (error) throw error;

      alert(`Data gemt for ${formatMonthName(yearMonth)} (${recordsToSave.length} sælgere, ${monthRows.length} rækker)`);
      
      // Refresh saved months list
      const { data: monthsData } = await supabase
        .from('supp_statistic')
        .select('year_month')
        .order('year_month', { ascending: false });
      
      const uniqueMonths = Array.from(new Set((monthsData || []).map((r: any) => r.year_month))).sort().reverse();
      setSavedMonths(uniqueMonths as string[]);
      
    } catch (err: any) {
      alert(`Fejl ved gemning: ${err.message}`);
      console.error('Save error:', err);
    } finally {
      setSaving(false);
    }
  }

  // Load saved data for a specific month and previous year
  async function loadFromSupabase(month: string) {
    setLoading(true);
    setSelectedMonth(month);
    try {
      // Load current month data
      const { data, error } = await supabase
        .from('supp_statistic')
        .select('*')
        .eq('year_month', month)
        .order('salesperson_name');

      if (error) throw error;

      if (!data || data.length === 0) {
        alert(`Ingen data fundet for ${month}`);
        setLoading(false);
        return;
      }

      setSavedData(data as SavedStatistic[]);
      setViewMode('saved');

      // Load individual rows for current month
      const { data: rowsData, error: rowsError } = await supabase
        .from('supp_statistic_rows')
        .select('*')
        .eq('year_month', month)
        .order('salesperson_name, customer_name');

      if (!rowsError && rowsData) {
        // Convert saved rows to ParsedRow format
        const convertedRows: ParsedRow[] = rowsData.map((row: any) => ({
          orderType: row.order_type,
          channel: row.channel,
          customerName: row.customer_name,
          accountNo: row.account_no,
          salesPerson: row.salesperson_name,
          qtyOrdered: Number(row.qty_ordered || 0),
          qtyDelivered: Number(row.qty_delivered || 0),
          price: Number(row.price || 0),
          date: row.date || null,
        }));
        setSavedRows(convertedRows);
      } else {
        setSavedRows(null);
      }

      // Load previous year's same month
      const parts = month.split('-');
      const year = parts[0];
      const monthNum = parts[1];
      if (!year || !monthNum) {
        setLoading(false);
        return;
      }
      const prevYear = String(parseInt(year, 10) - 1);
      const prevYearMonth = `${prevYear}-${monthNum}`;
      
      const { data: prevData, error: prevError } = await supabase
        .from('supp_statistic')
        .select('*')
        .eq('year_month', prevYearMonth)
        .order('salesperson_name');

      if (!prevError && prevData) {
        setPreviousYearData(prevData as SavedStatistic[]);
      } else {
        setPreviousYearData(null);
      }

      // Load individual rows for previous year
      const { data: prevRowsData, error: prevRowsError } = await supabase
        .from('supp_statistic_rows')
        .select('*')
        .eq('year_month', prevYearMonth)
        .order('salesperson_name, customer_name');

      if (!prevRowsError && prevRowsData) {
        const convertedPrevRows: ParsedRow[] = prevRowsData.map((row: any) => ({
          orderType: row.order_type,
          channel: row.channel,
          customerName: row.customer_name,
          accountNo: row.account_no,
          salesPerson: row.salesperson_name,
          qtyOrdered: Number(row.qty_ordered || 0),
          qtyDelivered: Number(row.qty_delivered || 0),
          price: Number(row.price || 0),
          date: row.date || null,
        }));
        setPreviousYearRows(convertedPrevRows);
      } else {
        setPreviousYearRows(null);
      }
      
    } catch (err: any) {
      alert(`Fejl ved indlæsning: ${err.message}`);
      console.error('Load error:', err);
    } finally {
      setLoading(false);
    }
  }

  // Convert saved statistics to display format with previous year and development
  const savedSummaries = useMemo(() => {
    if (!savedData) return [];
    
    const prevYearMap = new Map<string, SavedStatistic>();
    if (previousYearData) {
      for (const prev of previousYearData) {
        prevYearMap.set(prev.salesperson_name, prev);
      }
    }
    
    return savedData.map((stat) => {
      const prev = prevYearMap.get(stat.salesperson_name);
      return {
        salesPerson: stat.salesperson_name,
        totalDeliveredQty: stat.total_leveret,
        byChannel: {
          telefon: { stk: stat.telefon_stk, beløb: stat.telefon_beløb },
          b2bShop: { stk: stat.b2b_stk, beløb: stat.b2b_beløb },
          credittedStk: stat.krediteret_stk,
          credittedBeløb: stat.krediteret_beløb,
          samletStk: stat.samlet_stk,
          samletBeløb: stat.samlet_beløb,
        },
        previousYear: prev ? {
          totalDeliveredQty: prev.total_leveret,
          byChannel: {
            telefon: { stk: prev.telefon_stk, beløb: prev.telefon_beløb },
            b2bShop: { stk: prev.b2b_stk, beløb: prev.b2b_beløb },
            credittedStk: prev.krediteret_stk,
            credittedBeløb: prev.krediteret_beløb,
            samletStk: prev.samlet_stk,
            samletBeløb: prev.samlet_beløb,
          },
        } : null,
        development: prev ? {
          totalDeliveredQty: stat.total_leveret - prev.total_leveret,
          byChannel: {
            telefon: { stk: stat.telefon_stk - prev.telefon_stk, beløb: stat.telefon_beløb - prev.telefon_beløb },
            b2bShop: { stk: stat.b2b_stk - prev.b2b_stk, beløb: stat.b2b_beløb - prev.b2b_beløb },
            credittedStk: stat.krediteret_stk - prev.krediteret_stk,
            credittedBeløb: stat.krediteret_beløb - prev.krediteret_beløb,
            samletStk: stat.samlet_stk - prev.samlet_stk,
            samletBeløb: stat.samlet_beløb - prev.samlet_beløb,
          },
        } : null,
      };
    });
  }, [savedData, previousYearData]);

  return (
    <div className="space-y-4">
      <div className="text-xs text-gray-500">Statistics</div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Suppleringer</h1>
        <div className="flex items-center gap-3">
          {/* Historical Data Button */}
          <Link
            href="/statistics/suppleringer/historical"
            className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 text-sm"
          >
            <History className="h-4 w-4" />
            Historisk Data
          </Link>
          {/* Save Button */}
          {parsedRows.length > 0 && viewMode === 'upload' && (
            <button
              onClick={saveToSupabase}
              disabled={saving || processing}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              <Save className="h-4 w-4" />
              {saving ? 'Gemmer...' : `Gem (${formatMonthName(getMonthFromRows())})`}
            </button>
          )}
        </div>
      </div>

      {/* File Upload with Drag and Drop */}
      <div
        className={`rounded-md border-2 border-dashed p-6 text-center transition ${
          dragOver ? 'bg-slate-50 border-slate-400' : 'border-slate-300'
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const droppedFile = e.dataTransfer.files?.[0];
          if (droppedFile) parseFile(droppedFile);
        }}
      >
        <div className="text-sm text-gray-600 mb-3">
          Drag & drop CSV/XLSX file here, or click to browse
        </div>
        <input
          type="file"
          accept=".csv,.xlsx,.xls"
          className="text-sm"
          onChange={(e) => {
            const selectedFile = e.target.files?.[0];
            if (selectedFile) parseFile(selectedFile);
          }}
        />
        {file && (
          <div className="mt-2 text-sm text-gray-600">
            Loaded: {file.name} ({parsedRows.length} Stock order rows)
          </div>
        )}
      </div>

      {/* Progress Indicator */}
      {processing && progress && (
        <div className="rounded-md border p-4 bg-blue-50 border-blue-200 animate-in fade-in slide-in-from-top-2 duration-300">
          <div className="flex items-center gap-3 mb-3">
            <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
            <div className="flex-1">
              <div className="text-sm font-medium text-blue-900">{progress.step}</div>
              {progress.total > 0 && (
                <div className="text-xs text-blue-700 mt-0.5">
                  {Math.round((progress.current / progress.total) * 100)}% complete
                </div>
              )}
            </div>
          </div>
          {progress.total > 0 && (
            <div className="w-full bg-blue-200 rounded-full h-2.5 overflow-hidden">
              <div 
                className="bg-blue-600 h-full transition-all duration-500 ease-out rounded-full shadow-sm"
                style={{ width: `${Math.min(100, Math.max(0, (progress.current / progress.total) * 100))}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Month Tabs */}
      {savedMonths.length > 0 && (
        <div className="border-b">
          <div className="flex gap-1 overflow-x-auto">
            {savedMonths.map((month) => (
              <button
                key={month}
                onClick={() => loadFromSupabase(month)}
                disabled={loading}
                className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition ${
                  selectedMonth === month
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                } ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                {formatMonthName(month)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Salesperson Summaries */}
      {((viewMode === 'upload' && salespersonSummaries.length > 0) || (viewMode === 'saved' && savedSummaries.length > 0)) && (
        <div className="space-y-4">
          {viewMode === 'saved' && selectedMonth && (
            <div className="text-sm text-gray-600 mb-2">
              Viser gemt data for <strong>{formatMonthName(selectedMonth)}</strong>
            </div>
          )}
          {(viewMode === 'upload' ? salespersonSummaries : savedSummaries).map((summary) => (
            <div key={summary.salesPerson} className="rounded-md border overflow-hidden">
              <div
                className="bg-gray-50 p-3 cursor-pointer hover:bg-gray-100"
                onClick={() => {
                  setSelectedSalesperson(
                    selectedSalesperson === summary.salesPerson ? null : summary.salesPerson
                  );
                }}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-lg">{summary.salesPerson}</h3>
                  <span className="text-sm text-gray-500">
                    {selectedSalesperson === summary.salesPerson ? '▼' : '▶'}
                  </span>
                </div>
              </div>
              
              <div className="space-y-4 p-4">
                {/* Previous Year Section */}
                {viewMode === 'saved' && summary.previousYear && selectedMonth && (
                  <div>
                    <h4 className="text-sm font-semibold text-gray-700 mb-2">
                      {(() => {
                        if (!selectedMonth) return '';
                        const parts = selectedMonth.split('-');
                        const year = parts[0];
                        if (!year) return '';
                        return `${parseInt(year, 10) - 1} (Sidste år)`;
                      })()}
                    </h4>
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 border-b">
                          <tr>
                            <th className="px-4 py-2 text-left">Total leveret</th>
                            <th className="px-4 py-2 text-left">Telefon stk</th>
                            <th className="px-4 py-2 text-right">Telefon beløb</th>
                            <th className="px-4 py-2 text-left">B2B stk</th>
                            <th className="px-4 py-2 text-right">B2B beløb</th>
                            <th className="px-4 py-2 text-left">Krediteret stk</th>
                            <th className="px-4 py-2 text-right">Krediteret beløb</th>
                            <th className="px-4 py-2 text-left">Samlet stk</th>
                            <th className="px-4 py-2 text-right">Samlet beløb</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="border-b">
                            <td className="px-4 py-2">{summary.previousYear.totalDeliveredQty.toLocaleString('da-DK')}</td>
                            <td className="px-4 py-2">{summary.previousYear.byChannel.telefon.stk.toLocaleString('da-DK')}</td>
                            <td className="px-4 py-2 text-right">{formatPrice(summary.previousYear.byChannel.telefon.beløb)}</td>
                            <td className="px-4 py-2">{summary.previousYear.byChannel.b2bShop.stk.toLocaleString('da-DK')}</td>
                            <td className="px-4 py-2 text-right">{formatPrice(summary.previousYear.byChannel.b2bShop.beløb)}</td>
                            <td className="px-4 py-2">{summary.previousYear.byChannel.credittedStk.toLocaleString('da-DK')}</td>
                            <td className="px-4 py-2 text-right">{formatPrice(summary.previousYear.byChannel.credittedBeløb)}</td>
                            <td className="px-4 py-2">{summary.previousYear.byChannel.samletStk.toLocaleString('da-DK')}</td>
                            <td className="px-4 py-2 text-right">{formatPrice(summary.previousYear.byChannel.samletBeløb)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Current Month Section */}
                <div>
                  <h4 className="text-sm font-semibold text-gray-700 mb-2">
                    {viewMode === 'saved' && selectedMonth ? formatMonthName(selectedMonth) : 'Nuværende måned'}
                  </h4>
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead className="bg-gray-50 border-b">
                        <tr>
                          <th className="px-4 py-2 text-left">Total leveret</th>
                          <th className="px-4 py-2 text-left">Telefon stk</th>
                          <th className="px-4 py-2 text-right">Telefon beløb</th>
                          <th className="px-4 py-2 text-left">B2B stk</th>
                          <th className="px-4 py-2 text-right">B2B beløb</th>
                          <th className="px-4 py-2 text-left">Krediteret stk</th>
                          <th className="px-4 py-2 text-right">Krediteret beløb</th>
                          <th className="px-4 py-2 text-left">Samlet stk</th>
                          <th className="px-4 py-2 text-right">Samlet beløb</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-b">
                          <td className="px-4 py-2 font-medium">{summary.totalDeliveredQty.toLocaleString('da-DK')}</td>
                          <td className="px-4 py-2">{summary.byChannel.telefon.stk.toLocaleString('da-DK')}</td>
                          <td className="px-4 py-2 text-right">{formatPrice(summary.byChannel.telefon.beløb)}</td>
                          <td className="px-4 py-2">{summary.byChannel.b2bShop.stk.toLocaleString('da-DK')}</td>
                          <td className="px-4 py-2 text-right">{formatPrice(summary.byChannel.b2bShop.beløb)}</td>
                          <td className="px-4 py-2">{summary.byChannel.credittedStk.toLocaleString('da-DK')}</td>
                          <td className="px-4 py-2 text-right">{formatPrice(summary.byChannel.credittedBeløb)}</td>
                          <td className="px-4 py-2 font-medium">{summary.byChannel.samletStk.toLocaleString('da-DK')}</td>
                          <td className="px-4 py-2 text-right font-medium">{formatPrice(summary.byChannel.samletBeløb)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Development Section */}
                {viewMode === 'saved' && summary.development && (
                  <div>
                    <h4 className="text-sm font-semibold text-gray-700 mb-2">Udvikling</h4>
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 border-b">
                          <tr>
                            <th className="px-4 py-2 text-left">Total leveret</th>
                            <th className="px-4 py-2 text-left">Telefon stk</th>
                            <th className="px-4 py-2 text-right">Telefon beløb</th>
                            <th className="px-4 py-2 text-left">B2B stk</th>
                            <th className="px-4 py-2 text-right">B2B beløb</th>
                            <th className="px-4 py-2 text-left">Krediteret stk</th>
                            <th className="px-4 py-2 text-right">Krediteret beløb</th>
                            <th className="px-4 py-2 text-left">Samlet stk</th>
                            <th className="px-4 py-2 text-right">Samlet beløb</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="border-b">
                            <td className={`px-4 py-2 font-medium ${summary.development.totalDeliveredQty >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {summary.development.totalDeliveredQty >= 0 ? '+' : ''}{summary.development.totalDeliveredQty.toLocaleString('da-DK')}
                            </td>
                            <td className={`px-4 py-2 ${summary.development.byChannel.telefon.stk >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {summary.development.byChannel.telefon.stk >= 0 ? '+' : ''}{summary.development.byChannel.telefon.stk.toLocaleString('da-DK')}
                            </td>
                            <td className={`px-4 py-2 text-right ${summary.development.byChannel.telefon.beløb >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {summary.development.byChannel.telefon.beløb >= 0 ? '+' : ''}{formatPrice(summary.development.byChannel.telefon.beløb)}
                            </td>
                            <td className={`px-4 py-2 ${summary.development.byChannel.b2bShop.stk >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {summary.development.byChannel.b2bShop.stk >= 0 ? '+' : ''}{summary.development.byChannel.b2bShop.stk.toLocaleString('da-DK')}
                            </td>
                            <td className={`px-4 py-2 text-right ${summary.development.byChannel.b2bShop.beløb >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {summary.development.byChannel.b2bShop.beløb >= 0 ? '+' : ''}{formatPrice(summary.development.byChannel.b2bShop.beløb)}
                            </td>
                            <td className={`px-4 py-2 ${summary.development.byChannel.credittedStk >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {summary.development.byChannel.credittedStk >= 0 ? '+' : ''}{summary.development.byChannel.credittedStk.toLocaleString('da-DK')}
                            </td>
                            <td className={`px-4 py-2 text-right ${summary.development.byChannel.credittedBeløb >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {summary.development.byChannel.credittedBeløb >= 0 ? '+' : ''}{formatPrice(summary.development.byChannel.credittedBeløb)}
                            </td>
                            <td className={`px-4 py-2 font-medium ${summary.development.byChannel.samletStk >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {summary.development.byChannel.samletStk >= 0 ? '+' : ''}{summary.development.byChannel.samletStk.toLocaleString('da-DK')}
                            </td>
                            <td className={`px-4 py-2 text-right font-medium ${summary.development.byChannel.samletBeløb >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {summary.development.byChannel.samletBeløb >= 0 ? '+' : ''}{formatPrice(summary.development.byChannel.samletBeløb)}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>

              {/* Customer Details - Aggregated per customer */}
              {selectedSalesperson === summary.salesPerson && customerGroups.length > 0 && (
                <div className="border-t bg-white">
                  <div className="p-3">
                    <h4 className="font-semibold text-sm mb-3 text-gray-700">Kunder:</h4>
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 border-b">
                          <tr>
                            <th className="px-3 py-2 text-left">Kunde</th>
                            <th className="px-3 py-2 text-left">Total leveret</th>
                            <th className="px-3 py-2 text-left">Telefon stk</th>
                            <th className="px-3 py-2 text-right">Telefon beløb</th>
                            <th className="px-3 py-2 text-left">B2B stk</th>
                            <th className="px-3 py-2 text-right">B2B beløb</th>
                            <th className="px-3 py-2 text-left">Krediteret stk</th>
                            <th className="px-3 py-2 text-right">Krediteret beløb</th>
                            <th className="px-3 py-2 text-left">Samlet stk</th>
                            <th className="px-3 py-2 text-right">Samlet beløb</th>
                          </tr>
                        </thead>
                        <tbody>
                          {customerGroups.map((group, idx) => {
                            // Aggregate customer rows with same logic as salesperson
                            const telefon = { stk: 0, beløb: 0 };
                            const b2bShop = { stk: 0, beløb: 0 };
                            let credittedStk = 0;
                            let credittedBeløb = 0;
                            let samletStk = 0;
                            let samletBeløb = 0;
                            let totalLeveret = 0;
                            const dates = group.rows.map(r => r.date).filter(Boolean) as string[];
                            const dateRange = dates.length > 0 
                              ? `${dates[0]} - ${dates[dates.length - 1]}`
                              : null;

                            for (const row of group.rows) {
                              const isTelefon = row.channel === 'Telefon';
                              const channelData = isTelefon ? telefon : b2bShop;
                              
                              if (row.qtyDelivered > 0) {
                                totalLeveret += row.qtyDelivered;
                              }
                              
                              if (row.qtyOrdered > 0) {
                                channelData.stk += row.qtyOrdered;
                                samletStk += row.qtyOrdered;
                              }
                              if (row.price > 0) {
                                channelData.beløb += row.price;
                                samletBeløb += row.price;
                              }
                              
                              if (row.qtyOrdered < 0) {
                                const absQty = Math.abs(row.qtyOrdered);
                                credittedStk += absQty;
                                samletStk -= absQty;
                              }
                              if (row.price < 0) {
                                const absPrice = Math.abs(row.price);
                                credittedBeløb += absPrice;
                                samletBeløb -= absPrice;
                              }
                            }

                            return (
                              <tr key={idx} className="border-b hover:bg-gray-50">
                                <td className="px-3 py-2">
                                  <div>
                                    <div className="font-medium">{group.customerName}</div>
                                    <div className="text-xs text-gray-500">({group.accountNo})</div>
                                    {dateRange && <div className="text-xs text-gray-400">{dateRange}</div>}
                                  </div>
                                </td>
                                <td className="px-3 py-2">{totalLeveret.toLocaleString('da-DK')}</td>
                                <td className="px-3 py-2">{telefon.stk.toLocaleString('da-DK')}</td>
                                <td className="px-3 py-2 text-right">{formatPrice(telefon.beløb)}</td>
                                <td className="px-3 py-2">{b2bShop.stk.toLocaleString('da-DK')}</td>
                                <td className="px-3 py-2 text-right">{formatPrice(b2bShop.beløb)}</td>
                                <td className="px-3 py-2">{credittedStk.toLocaleString('da-DK')}</td>
                                <td className="px-3 py-2 text-right">{formatPrice(credittedBeløb)}</td>
                                <td className="px-3 py-2 font-medium">{samletStk.toLocaleString('da-DK')}</td>
                                <td className="px-3 py-2 text-right font-medium">{formatPrice(samletBeløb)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {parsedRows.length === 0 && file && (
        <div className="text-sm text-gray-600">No Stock orders found in the file.</div>
      )}
    </div>
  );
}

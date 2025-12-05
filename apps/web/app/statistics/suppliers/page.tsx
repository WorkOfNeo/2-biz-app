'use client';
import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';

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
    telefon: { orderedQty: number; deliveredQty: number; price: number; credittedQty: number; credittedPrice: number };
    b2bShop: { orderedQty: number; deliveredQty: number; price: number; credittedQty: number; credittedPrice: number };
  };
};

type CustomerGroup = {
  customerName: string;
  accountNo: string;
  rows: ParsedRow[];
};

export default function SuppliersPage() {
  const [file, setFile] = useState<File | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [selectedSalesperson, setSelectedSalesperson] = useState<string | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

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
      const buf = await selectedFile.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheetName = wb.SheetNames?.[0];
      if (!sheetName) throw new Error('No sheet found');
      const sheet = wb.Sheets[sheetName];
      if (!sheet) throw new Error('Empty sheet');

      // Read as array of arrays to access by column index
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as any[][];
      if (data.length === 0) throw new Error('Empty sheet');

      const rows: ParsedRow[] = [];
      
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

      // Skip header row (index 0), start from row 1
      for (let i = 1; i < data.length; i++) {
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

      setParsedRows(rows);
      setFile(selectedFile);
      setSelectedSalesperson(null);
      setSelectedCustomer(null);
    } catch (err: any) {
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

      // Split by channel
      const telefon = { orderedQty: 0, deliveredQty: 0, price: 0, credittedQty: 0, credittedPrice: 0 };
      const b2bShop = { orderedQty: 0, deliveredQty: 0, price: 0, credittedQty: 0, credittedPrice: 0 };

      for (const row of rows) {
        const isTelefon = row.channel === 'Telefon';
        const channelData = isTelefon ? telefon : b2bShop;
        
        // Main totals: sum only positive values
        if (row.qtyOrdered > 0) {
          totalOrderedQty += row.qtyOrdered;
          channelData.orderedQty += row.qtyOrdered;
        }
        if (row.qtyDelivered > 0) {
          totalDeliveredQty += row.qtyDelivered;
          channelData.deliveredQty += row.qtyDelivered;
        }
        if (row.price > 0) {
          totalPrice += row.price;
          channelData.price += row.price;
        }
        
        // Creditted: sum absolute values of negative numbers
        if (row.qtyOrdered < 0) {
          credittedQty += Math.abs(row.qtyOrdered);
          channelData.credittedQty += Math.abs(row.qtyOrdered);
        }
        if (row.price < 0) {
          credittedPrice += Math.abs(row.price);
          channelData.credittedPrice += Math.abs(row.price);
        }
      }

      summaries.push({
        salesPerson,
        totalOrderedQty,
        totalDeliveredQty,
        totalPrice,
        credittedQty,
        credittedPrice,
        rows,
        byChannel: {
          telefon,
          b2bShop,
        },
      });
    }

    // Sort by salesperson name
    summaries.sort((a, b) => a.salesPerson.localeCompare(b.salesPerson));

    return summaries;
  }, [parsedRows]);

  // Get customer groups for selected salesperson
  const customerGroups = useMemo(() => {
    if (!selectedSalesperson) return [];
    
    const summary = salespersonSummaries.find(s => s.salesPerson === selectedSalesperson);
    if (!summary) return [];

    const byCustomer = new Map<string, ParsedRow[]>();
    
    for (const row of summary.rows) {
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
  }, [selectedSalesperson, salespersonSummaries]);

  // Format price from cents to currency (e.g., 50730 -> 507.30)
  function formatPrice(cents: number): string {
    return (cents / 100).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  return (
    <div className="space-y-4">
      <div className="text-xs text-gray-500">Statistics</div>
      <h1 className="text-xl font-semibold">Suppleringer</h1>

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

      {/* Salesperson Summaries */}
      {salespersonSummaries.length > 0 && (
        <div className="space-y-4">
          {salespersonSummaries.map((summary) => (
            <div key={summary.salesPerson} className="rounded-md border overflow-hidden">
              <div
                className="bg-gray-50 p-3 cursor-pointer hover:bg-gray-100"
                onClick={() => setSelectedSalesperson(
                  selectedSalesperson === summary.salesPerson ? null : summary.salesPerson
                )}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-lg">{summary.salesPerson}</h3>
                  <span className="text-sm text-gray-500">
                    {selectedSalesperson === summary.salesPerson ? '▼' : '▶'}
                  </span>
                </div>
              </div>
              
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-4 py-2 text-left" colSpan={3}>Total</th>
                      <th className="px-4 py-2 text-left" colSpan={3}>Telefon</th>
                      <th className="px-4 py-2 text-left" colSpan={3}>B2B Shop</th>
                      <th className="px-4 py-2 text-left" colSpan={2}>Krediteret</th>
                    </tr>
                    <tr className="bg-gray-50 border-b">
                      <th className="px-4 py-2 text-left">Bestilt stk</th>
                      <th className="px-4 py-2 text-left">Leveret stk</th>
                      <th className="px-4 py-2 text-right">Pris</th>
                      <th className="px-4 py-2 text-left">Bestilt stk</th>
                      <th className="px-4 py-2 text-left">Leveret stk</th>
                      <th className="px-4 py-2 text-right">Pris</th>
                      <th className="px-4 py-2 text-left">Bestilt stk</th>
                      <th className="px-4 py-2 text-left">Leveret stk</th>
                      <th className="px-4 py-2 text-right">Pris</th>
                      <th className="px-4 py-2 text-left">stk</th>
                      <th className="px-4 py-2 text-right">Pris</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b">
                      <td className="px-4 py-2 font-medium">{summary.totalOrderedQty.toLocaleString('da-DK')}</td>
                      <td className="px-4 py-2">{summary.totalDeliveredQty.toLocaleString('da-DK')}</td>
                      <td className="px-4 py-2 text-right font-medium">{formatPrice(summary.totalPrice)}</td>
                      <td className="px-4 py-2">{summary.byChannel.telefon.orderedQty.toLocaleString('da-DK')}</td>
                      <td className="px-4 py-2">{summary.byChannel.telefon.deliveredQty.toLocaleString('da-DK')}</td>
                      <td className="px-4 py-2 text-right">{formatPrice(summary.byChannel.telefon.price)}</td>
                      <td className="px-4 py-2">{summary.byChannel.b2bShop.orderedQty.toLocaleString('da-DK')}</td>
                      <td className="px-4 py-2">{summary.byChannel.b2bShop.deliveredQty.toLocaleString('da-DK')}</td>
                      <td className="px-4 py-2 text-right">{formatPrice(summary.byChannel.b2bShop.price)}</td>
                      <td className="px-4 py-2">{summary.credittedQty.toLocaleString('da-DK')}</td>
                      <td className="px-4 py-2 text-right">{formatPrice(summary.credittedPrice)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Customer Details */}
              {selectedSalesperson === summary.salesPerson && customerGroups.length > 0 && (
                <div className="border-t bg-white">
                  <div className="p-2 space-y-1.5">
                    <h4 className="font-semibold text-xs mb-1 text-gray-700">Kunder:</h4>
                    {customerGroups.map((group, idx) => (
                      <div
                        key={`${group.customerName}-${group.accountNo}-${idx}`}
                        className="border rounded p-1.5 cursor-pointer hover:bg-gray-50"
                        onClick={() => setSelectedCustomer(
                          selectedCustomer === `${group.customerName}|${group.accountNo}` 
                            ? null 
                            : `${group.customerName}|${group.accountNo}`
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <div className="text-xs">
                            <span className="font-medium">{group.customerName}</span>
                            <span className="text-gray-500 ml-1.5">({group.accountNo})</span>
                          </div>
                          <span className="text-[10px] text-gray-500">
                            {selectedCustomer === `${group.customerName}|${group.accountNo}` ? '▼' : '▶'} {group.rows.length}
                          </span>
                        </div>
                        
                        {selectedCustomer === `${group.customerName}|${group.accountNo}` && (
                          <div className="mt-2 overflow-x-auto">
                            {(() => {
                              // Group rows by date range (from - to)
                              const sortedRows = [...group.rows].sort((a, b) => {
                                const dateA = a.date || '';
                                const dateB = b.date || '';
                                return dateA.localeCompare(dateB);
                              });
                              
                              const dates = sortedRows.map(r => r.date).filter(Boolean) as string[];
                              const dateRange = dates.length > 0 
                                ? `${dates[0]} - ${dates[dates.length - 1]}`
                                : '—';
                              
                              return (
                                <div className="border rounded bg-white">
                                  <div className="bg-gray-50 px-2 py-0.5 text-[10px] font-medium border-b text-gray-700">
                                    {dateRange}
                                  </div>
                                  <table className="min-w-full text-[10px]">
                                    <thead className="bg-gray-50 border-b">
                                      <tr>
                                        <th className="px-1.5 py-0.5 text-left border-r font-medium">Bestilt stk</th>
                                        <th className="px-1.5 py-0.5 text-left border-r font-medium">Leveret stk</th>
                                        <th className="px-1.5 py-0.5 text-right font-medium">Pris</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {sortedRows.map((row, rowIdx) => (
                                        <tr key={rowIdx} className="border-b hover:bg-gray-50">
                                          <td className="px-1.5 py-0.5 border-r">{row.qtyOrdered.toLocaleString('da-DK')}</td>
                                          <td className="px-1.5 py-0.5 border-r">{row.qtyDelivered.toLocaleString('da-DK')}</td>
                                          <td className="px-1.5 py-0.5 text-right font-mono">{formatPrice(row.price)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    ))}
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

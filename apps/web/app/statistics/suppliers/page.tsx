'use client';
import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';

type ParsedRow = {
  orderType: string;
  customerName: string;
  accountNo: string;
  salesPerson: string;
  qtyOrdered: number;
  qtyDelivered: number;
  price: number; // in cents
};

type SalespersonSummary = {
  salesPerson: string;
  totalOrderedQty: number;
  totalDeliveredQty: number;
  totalPrice: number;
  credittedQty: number;
  credittedPrice: number;
  rows: ParsedRow[];
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
      const colE = excelColToIndex('E'); // Customer Name
      const colG = excelColToIndex('G'); // account_no
      const colU = excelColToIndex('U'); // Sales Person
      const colAN = excelColToIndex('AN'); // Size Quantity Ordered
      const colAO = excelColToIndex('AO'); // Size Quantity Delivered
      const colAW = excelColToIndex('AW'); // Sales Price Base Exchange Total

      // Skip header row (index 0), start from row 1
      for (let i = 1; i < data.length; i++) {
        const row = data[i] || [];
        
        const orderType = String(row[colB] || '').trim(); // Column B
        const customerName = String(row[colE] || '').trim(); // Column E
        const accountNo = parseAccountNo(row[colG]); // Column G
        const salesPerson = String(row[colU] || '').trim(); // Column U
        const qtyOrdered = parseQty(row[colAN]); // Column AN
        const qtyDelivered = parseQty(row[colAO]); // Column AO
        const price = parsePrice(row[colAW]); // Column AW

        // Only include Stock orders
        if (orderType.toUpperCase() !== 'STOCK') continue;
        
        // Skip rows with missing essential data
        if (!customerName || !salesPerson || !accountNo) continue;

        rows.push({
          orderType,
          customerName,
          accountNo,
          salesPerson,
          qtyOrdered,
          qtyDelivered,
          price,
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

      for (const row of rows) {
        // Main totals: sum only positive values
        if (row.qtyOrdered > 0) {
          totalOrderedQty += row.qtyOrdered;
        }
        if (row.qtyDelivered > 0) {
          totalDeliveredQty += row.qtyDelivered;
        }
        if (row.price > 0) {
          totalPrice += row.price;
        }
        
        // Creditted: sum absolute values of negative numbers
        if (row.qtyOrdered < 0) {
          credittedQty += Math.abs(row.qtyOrdered);
        }
        if (row.price < 0) {
          credittedPrice += Math.abs(row.price);
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

      {/* File Upload */}
      <div className="rounded-md border p-4">
        <label className="block text-sm font-medium mb-2">Upload CSV/XLSX File</label>
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
                      <th className="px-4 py-2 text-left">Total Bestilt stk</th>
                      <th className="px-4 py-2 text-left">Total Leveret stk</th>
                      <th className="px-4 py-2 text-right">Total Pris</th>
                      <th className="px-4 py-2 text-left">Krediteret stk</th>
                      <th className="px-4 py-2 text-right">Krediteret Pris</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b">
                      <td className="px-4 py-2 font-medium">{summary.totalOrderedQty.toLocaleString('da-DK')}</td>
                      <td className="px-4 py-2">{summary.totalDeliveredQty.toLocaleString('da-DK')}</td>
                      <td className="px-4 py-2 text-right font-medium">{formatPrice(summary.totalPrice)}</td>
                      <td className="px-4 py-2">{summary.credittedQty.toLocaleString('da-DK')}</td>
                      <td className="px-4 py-2 text-right">{formatPrice(summary.credittedPrice)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Customer Details */}
              {selectedSalesperson === summary.salesPerson && customerGroups.length > 0 && (
                <div className="border-t bg-white">
                  <div className="p-4 space-y-3">
                    <h4 className="font-semibold text-sm mb-2">Kunder:</h4>
                    {customerGroups.map((group, idx) => (
                      <div
                        key={`${group.customerName}-${group.accountNo}-${idx}`}
                        className="border rounded p-3 cursor-pointer hover:bg-gray-50"
                        onClick={() => setSelectedCustomer(
                          selectedCustomer === `${group.customerName}|${group.accountNo}` 
                            ? null 
                            : `${group.customerName}|${group.accountNo}`
                        )}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <div>
                            <span className="font-medium">{group.customerName}</span>
                            <span className="text-gray-500 text-sm ml-2">({group.accountNo})</span>
                          </div>
                          <span className="text-xs text-gray-500">
                            {selectedCustomer === `${group.customerName}|${group.accountNo}` ? '▼' : '▶'} {group.rows.length} rækker
                          </span>
                        </div>
                        
                        {selectedCustomer === `${group.customerName}|${group.accountNo}` && (
                          <div className="mt-3 overflow-x-auto">
                            <table className="min-w-full text-xs">
                              <thead className="bg-gray-50">
                                <tr>
                                  <th className="px-2 py-1 text-left">Bestilt stk</th>
                                  <th className="px-2 py-1 text-left">Leveret stk</th>
                                  <th className="px-2 py-1 text-right">Pris</th>
                                </tr>
                              </thead>
                              <tbody>
                                {group.rows.map((row, rowIdx) => (
                                  <tr key={rowIdx} className="border-t">
                                    <td className="px-2 py-1">{row.qtyOrdered.toLocaleString('da-DK')}</td>
                                    <td className="px-2 py-1">{row.qtyDelivered.toLocaleString('da-DK')}</td>
                                    <td className="px-2 py-1 text-right">{formatPrice(row.price)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
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

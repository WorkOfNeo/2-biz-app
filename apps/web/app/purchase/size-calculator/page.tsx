'use client';

import { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';

type SizeSetType = '34-46' | 'S-XXL';

const SIZE_SETS = {
  '34-46': ['34', '36', '38', '40', '42', '44', '46'],
  'S-XXL': ['S', 'M', 'L', 'XL', 'XXL'],
};

export default function SizeCalculatorPage() {
  const [sizeSet, setSizeSet] = useState<SizeSetType>('34-46');
  const [netNeedInput, setNetNeedInput] = useState('');
  const [historicalSalesInput, setHistoricalSalesInput] = useState('');
  const [targetQuantity, setTargetQuantity] = useState('');

  const sizes = SIZE_SETS[sizeSet];

  // Parse input strings into arrays of numbers
  const parseValues = (input: string): number[] => {
    if (!input.trim()) return [];
    return input.trim().split(/\s+/).map(v => parseFloat(v) || 0);
  };

  const netNeedValues = useMemo(() => parseValues(netNeedInput), [netNeedInput]);
  const historicalSalesValues = useMemo(() => parseValues(historicalSalesInput), [historicalSalesInput]);

  // Calculate totals and percentages
  const netNeedTotal = useMemo(() => 
    netNeedValues.reduce((sum, val) => sum + val, 0), 
    [netNeedValues]
  );

  const historicalSalesTotal = useMemo(() => 
    historicalSalesValues.reduce((sum, val) => sum + val, 0), 
    [historicalSalesValues]
  );

  const netNeedPercentages = useMemo(() => {
    if (netNeedTotal === 0) return netNeedValues.map(() => 0);
    return netNeedValues.map(val => (val / netNeedTotal) * 100);
  }, [netNeedValues, netNeedTotal]);

  const historicalSalesPercentages = useMemo(() => {
    if (historicalSalesTotal === 0) return historicalSalesValues.map(() => 0);
    return historicalSalesValues.map(val => (val / historicalSalesTotal) * 100);
  }, [historicalSalesValues, historicalSalesTotal]);

  // Calculate suggested order based on target quantity and historical sales distribution
  const calculateOrder = useMemo(() => {
    const target = parseFloat(targetQuantity) || 0;
    if (target === 0 || historicalSalesTotal === 0) {
      return sizes.map(() => 0);
    }

    // Initial distribution based on historical sales percentages
    const initialOrder = historicalSalesPercentages.map(pct => 
      Math.round((pct / 100) * target)
    );

    // Adjust to match exact target (handle rounding differences)
    const currentTotal = initialOrder.reduce((sum, val) => sum + val, 0);
    const diff = target - currentTotal;

    if (diff !== 0) {
      // Find the size with the highest historical percentage to adjust
      const maxIdx = historicalSalesPercentages.indexOf(Math.max(...historicalSalesPercentages));
      initialOrder[maxIdx] = (initialOrder[maxIdx] || 0) + diff;
    }

    return initialOrder;
  }, [targetQuantity, historicalSalesPercentages, historicalSalesTotal, sizes]);

  // Calculate new order with net need consideration
  const calculateNewOrderWithNetNeed = useMemo(() => {
    return calculateOrder.map((orderQty, idx) => {
      const netNeed = netNeedValues[idx] || 0;
      return Math.max(0, orderQty - netNeed);
    });
  }, [calculateOrder, netNeedValues]);

  const orderTotal = useMemo(() => 
    calculateOrder.reduce((sum, val) => sum + val, 0), 
    [calculateOrder]
  );

  const newOrderTotal = useMemo(() => 
    calculateNewOrderWithNetNeed.reduce((sum, val) => sum + val, 0), 
    [calculateNewOrderWithNetNeed]
  );

  // Validation helpers
  const netNeedValid = netNeedValues.length === 0 || netNeedValues.length === sizes.length;
  const historicalSalesValid = historicalSalesValues.length === 0 || historicalSalesValues.length === sizes.length;

  return (
    <div className="p-4 space-y-6 max-w-6xl">
      <div>
        <div className="text-xs text-slate-500">Purchase</div>
        <h1 className="text-2xl font-semibold">Size Distribution Calculator</h1>
        <p className="text-sm text-slate-600 mt-1">
          Calculate optimal order quantities based on historical sales and net need
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Size Set Selection */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Select Size Set
            </label>
            <div className="flex gap-3">
              <button
                onClick={() => setSizeSet('34-46')}
                className={`
                  px-4 py-2 rounded-lg border-2 transition-all text-sm font-medium
                  ${sizeSet === '34-46'
                    ? 'border-blue-600 bg-blue-50 text-blue-700'
                    : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'
                  }
                `}
              >
                34-46 (Numeric)
              </button>
              <button
                onClick={() => setSizeSet('S-XXL')}
                className={`
                  px-4 py-2 rounded-lg border-2 transition-all text-sm font-medium
                  ${sizeSet === 'S-XXL'
                    ? 'border-blue-600 bg-blue-50 text-blue-700'
                    : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'
                  }
                `}
              >
                S-XXL (Letter)
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Sizes: {sizes.join(', ')}
            </p>
          </div>

          {/* Current Net Need Input */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Current Net Need
              <span className="text-xs text-slate-500 ml-2 font-normal">
                (paste {sizes.length} space-separated values from Excel)
              </span>
            </label>
            <input
              type="text"
              value={netNeedInput}
              onChange={(e) => setNetNeedInput(e.target.value)}
              placeholder="e.g., 19 96 175 171 182 147 68"
              className={`
                w-full px-3 py-2 border rounded-lg text-sm
                ${!netNeedValid ? 'border-red-300 bg-red-50' : 'border-slate-300'}
                focus:outline-none focus:ring-2 focus:ring-blue-500
              `}
            />
            {!netNeedValid && (
              <p className="text-xs text-red-600 mt-1">
                Must have exactly {sizes.length} values (got {netNeedValues.length})
              </p>
            )}
            {netNeedValid && netNeedTotal > 0 && (
              <p className="text-xs text-slate-500 mt-1">
                Total: {netNeedTotal.toLocaleString()}
              </p>
            )}
          </div>

          {/* Historical Sales Input */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Historical Sales
              <span className="text-xs text-slate-500 ml-2 font-normal">
                (paste {sizes.length} space-separated values from Excel)
              </span>
            </label>
            <input
              type="text"
              value={historicalSalesInput}
              onChange={(e) => setHistoricalSalesInput(e.target.value)}
              placeholder="e.g., 19 96 175 171 182 147 68"
              className={`
                w-full px-3 py-2 border rounded-lg text-sm
                ${!historicalSalesValid ? 'border-red-300 bg-red-50' : 'border-slate-300'}
                focus:outline-none focus:ring-2 focus:ring-blue-500
              `}
            />
            {!historicalSalesValid && (
              <p className="text-xs text-red-600 mt-1">
                Must have exactly {sizes.length} values (got {historicalSalesValues.length})
              </p>
            )}
            {historicalSalesValid && historicalSalesTotal > 0 && (
              <p className="text-xs text-slate-500 mt-1">
                Total: {historicalSalesTotal.toLocaleString()}
              </p>
            )}
          </div>

          {/* Target Quantity Input */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Target Order Quantity
            </label>
            <input
              type="number"
              value={targetQuantity}
              onChange={(e) => setTargetQuantity(e.target.value)}
              placeholder="e.g., 400"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </CardContent>
      </Card>

      {/* Results Display */}
      {netNeedValid && historicalSalesValid && netNeedTotal > 0 && historicalSalesTotal > 0 && parseFloat(targetQuantity || '0') > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Distribution Analysis</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Distribution Percentages Table */}
            <div>
              <h3 className="text-sm font-semibold text-slate-700 mb-3">Percentage Distribution</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left py-2 px-3 font-medium text-slate-600">Size</th>
                      {sizes.map(size => (
                        <th key={size} className="text-center py-2 px-3 font-medium text-slate-600">
                          {size}
                        </th>
                      ))}
                      <th className="text-right py-2 px-3 font-medium text-slate-600">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-slate-100">
                      <td className="py-2 px-3 font-medium text-slate-700">Net Need</td>
                      {netNeedValues.map((val, idx) => (
                        <td key={idx} className="text-center py-2 px-3 text-slate-600">
                          {val}
                        </td>
                      ))}
                      <td className="text-right py-2 px-3 font-semibold text-slate-700">
                        {netNeedTotal.toLocaleString()}
                      </td>
                    </tr>
                    <tr className="border-b border-slate-100 bg-slate-50">
                      <td className="py-2 px-3 font-medium text-slate-700">Net Need %</td>
                      {netNeedPercentages.map((pct, idx) => (
                        <td key={idx} className="text-center py-2 px-3 text-slate-600">
                          {pct.toFixed(1)}%
                        </td>
                      ))}
                      <td className="text-right py-2 px-3 font-semibold text-slate-700">
                        100.0%
                      </td>
                    </tr>
                    <tr className="border-b border-slate-100">
                      <td className="py-2 px-3 font-medium text-slate-700">Historical Sales</td>
                      {historicalSalesValues.map((val, idx) => (
                        <td key={idx} className="text-center py-2 px-3 text-slate-600">
                          {val}
                        </td>
                      ))}
                      <td className="text-right py-2 px-3 font-semibold text-slate-700">
                        {historicalSalesTotal.toLocaleString()}
                      </td>
                    </tr>
                    <tr className="border-b border-slate-200 bg-blue-50">
                      <td className="py-2 px-3 font-medium text-blue-700">Historical Sales %</td>
                      {historicalSalesPercentages.map((pct, idx) => (
                        <td key={idx} className="text-center py-2 px-3 font-semibold text-blue-700">
                          {pct.toFixed(1)}%
                        </td>
                      ))}
                      <td className="text-right py-2 px-3 font-semibold text-blue-700">
                        100.0%
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Order Calculation Results */}
            <div>
              <h3 className="text-sm font-semibold text-slate-700 mb-3">
                Order Calculation (Target: {parseFloat(targetQuantity).toLocaleString()} pcs)
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left py-2 px-3 font-medium text-slate-600">Size</th>
                      {sizes.map(size => (
                        <th key={size} className="text-center py-2 px-3 font-medium text-slate-600">
                          {size}
                        </th>
                      ))}
                      <th className="text-right py-2 px-3 font-medium text-slate-600">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-slate-100 bg-green-50">
                      <td className="py-2 px-3 font-medium text-green-700">Order (by Historical %)</td>
                      {calculateOrder.map((qty, idx) => (
                        <td key={idx} className="text-center py-2 px-3 font-semibold text-green-700">
                          {qty}
                        </td>
                      ))}
                      <td className="text-right py-2 px-3 font-semibold text-green-700">
                        {orderTotal.toLocaleString()}
                      </td>
                    </tr>
                    <tr className="border-b border-slate-100">
                      <td className="py-2 px-3 font-medium text-slate-700">Less: Net Need</td>
                      {netNeedValues.map((val, idx) => (
                        <td key={idx} className="text-center py-2 px-3 text-slate-600">
                          -{val}
                        </td>
                      ))}
                      <td className="text-right py-2 px-3 font-semibold text-slate-700">
                        -{netNeedTotal.toLocaleString()}
                      </td>
                    </tr>
                    <tr className="border-b border-slate-200 bg-emerald-50">
                      <td className="py-2 px-3 font-medium text-emerald-700">
                        New Order (with Net Need)
                      </td>
                      {calculateNewOrderWithNetNeed.map((qty, idx) => (
                        <td key={idx} className="text-center py-2 px-3 font-bold text-emerald-700">
                          {qty}
                        </td>
                      ))}
                      <td className="text-right py-2 px-3 font-bold text-emerald-700">
                        {newOrderTotal.toLocaleString()}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Copy to Clipboard */}
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  const orderText = calculateOrder.join('\t');
                  navigator.clipboard.writeText(orderText);
                }}
                variant="outline"
                className="text-sm"
              >
                Copy Order (by Historical %)
              </Button>
              <Button
                onClick={() => {
                  const newOrderText = calculateNewOrderWithNetNeed.join('\t');
                  navigator.clipboard.writeText(newOrderText);
                }}
                variant="default"
                className="text-sm"
              >
                Copy New Order (with Net Need)
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

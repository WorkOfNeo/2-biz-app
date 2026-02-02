'use client';

import { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs';
import { Badge } from '../../../components/ui/badge';
import { Calculator, TrendingUp, Package, ArrowRight } from 'lucide-react';

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

  // Calculate NEW NET NEED after placing the order
  const newNetNeedAfterOrder = useMemo(() => {
    return netNeedValues.map((need, idx) => {
      const ordered = calculateNewOrderWithNetNeed[idx] || 0;
      return need + ordered;
    });
  }, [netNeedValues, calculateNewOrderWithNetNeed]);

  const newNetNeedTotal = useMemo(() => 
    newNetNeedAfterOrder.reduce((sum, val) => sum + val, 0), 
    [newNetNeedAfterOrder]
  );

  const newNetNeedPercentages = useMemo(() => {
    if (newNetNeedTotal === 0) return newNetNeedAfterOrder.map(() => 0);
    return newNetNeedAfterOrder.map(val => (val / newNetNeedTotal) * 100);
  }, [newNetNeedAfterOrder, newNetNeedTotal]);

  // Validation helpers
  const netNeedValid = netNeedValues.length === 0 || netNeedValues.length === sizes.length;
  const historicalSalesValid = historicalSalesValues.length === 0 || historicalSalesValues.length === sizes.length;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Calculator className="w-6 h-6 text-blue-600" />
          <div>
            <div className="text-xs text-slate-500 uppercase tracking-wide">Purchase</div>
            <h1 className="text-3xl font-bold text-slate-900">Size Distribution Calculator</h1>
          </div>
        </div>
        <p className="text-slate-600">
          Calculate optimal order quantities based on historical sales patterns and current net need
        </p>
      </div>

      {/* Configuration Card */}
      <Card className="border-2">
        <CardHeader className="bg-gradient-to-r from-slate-50 to-slate-100">
          <CardTitle className="flex items-center gap-2">
            <Package className="w-5 h-5" />
            Configuration
          </CardTitle>
          <CardDescription>Set up your size range and input data</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 pt-6">
          {/* Size Set Selection */}
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-3">
              Select Size Set
            </label>
            <Tabs value={sizeSet} onValueChange={(v) => setSizeSet(v as SizeSetType)} className="w-full">
              <TabsList className="grid w-full max-w-md grid-cols-2">
                <TabsTrigger value="34-46" className="flex items-center gap-2">
                  34-46 <Badge className="ml-1 bg-slate-100 text-slate-700">Numeric</Badge>
                </TabsTrigger>
                <TabsTrigger value="S-XXL" className="flex items-center gap-2">
                  S-XXL <Badge className="ml-1 bg-slate-100 text-slate-700">Letter</Badge>
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {sizes.map(size => (
                <Badge key={size} className="text-xs bg-blue-100 text-blue-700 border-blue-200">
                  {size}
                </Badge>
              ))}
            </div>
          </div>

          {/* Data Inputs Grid */}
          <div className="grid md:grid-cols-2 gap-6">
            {/* Current Net Need Input */}
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-700">
                Current Net Need
              </label>
              <p className="text-xs text-slate-500">
                Paste {sizes.length} space-separated values from Excel
              </p>
              <input
                type="text"
                value={netNeedInput}
                onChange={(e) => setNetNeedInput(e.target.value)}
                placeholder="e.g., 19 96 175 171 182 147 68"
                className={`
                  w-full px-4 py-3 border-2 rounded-lg text-sm font-mono
                  ${!netNeedValid 
                    ? 'border-red-300 bg-red-50 focus:ring-red-500' 
                    : 'border-slate-300 focus:border-blue-500'
                  }
                  focus:outline-none focus:ring-2
                `}
              />
              {!netNeedValid && (
                <p className="text-xs text-red-600 font-medium flex items-center gap-1">
                  ⚠️ Must have exactly {sizes.length} values (got {netNeedValues.length})
                </p>
              )}
              {netNeedValid && netNeedTotal > 0 && (
                <div className="flex items-center justify-between bg-slate-50 rounded px-3 py-2">
                  <span className="text-xs text-slate-600">Total:</span>
                  <Badge className="text-sm font-semibold bg-slate-200 text-slate-800 border-slate-300">
                    {netNeedTotal.toLocaleString()} pcs
                  </Badge>
                </div>
              )}
            </div>

            {/* Historical Sales Input */}
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-700">
                Historical Sales
              </label>
              <p className="text-xs text-slate-500">
                Paste {sizes.length} space-separated values from Excel
              </p>
              <input
                type="text"
                value={historicalSalesInput}
                onChange={(e) => setHistoricalSalesInput(e.target.value)}
                placeholder="e.g., 19 96 175 171 182 147 68"
                className={`
                  w-full px-4 py-3 border-2 rounded-lg text-sm font-mono
                  ${!historicalSalesValid 
                    ? 'border-red-300 bg-red-50 focus:ring-red-500' 
                    : 'border-slate-300 focus:border-blue-500'
                  }
                  focus:outline-none focus:ring-2
                `}
              />
              {!historicalSalesValid && (
                <p className="text-xs text-red-600 font-medium flex items-center gap-1">
                  ⚠️ Must have exactly {sizes.length} values (got {historicalSalesValues.length})
                </p>
              )}
              {historicalSalesValid && historicalSalesTotal > 0 && (
                <div className="flex items-center justify-between bg-blue-50 rounded px-3 py-2">
                  <span className="text-xs text-slate-600">Total:</span>
                  <Badge className="text-sm font-semibold bg-blue-600">
                    {historicalSalesTotal.toLocaleString()} pcs
                  </Badge>
                </div>
              )}
            </div>
          </div>

          {/* Target Quantity Input */}
          <div className="space-y-2 max-w-md">
            <label className="block text-sm font-semibold text-slate-700">
              Target Order Quantity
            </label>
            <p className="text-xs text-slate-500">
              Enter the total number of pieces you want to order
            </p>
            <input
              type="number"
              value={targetQuantity}
              onChange={(e) => setTargetQuantity(e.target.value)}
              placeholder="e.g., 400"
              className="w-full px-4 py-3 border-2 border-slate-300 rounded-lg text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </CardContent>
      </Card>

      {/* Results Display */}
      {netNeedValid && historicalSalesValid && netNeedTotal > 0 && historicalSalesTotal > 0 && parseFloat(targetQuantity || '0') > 0 && (
        <>
          {/* Input Distribution Analysis */}
          <Card className="border-2 border-blue-200">
            <CardHeader className="bg-gradient-to-r from-blue-50 to-indigo-50">
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-blue-600" />
                Input Distribution Analysis
              </CardTitle>
              <CardDescription>Current situation and historical patterns</CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse border border-slate-200 rounded-lg overflow-hidden">
                  <thead>
                    <tr className="bg-slate-100 border-b-2 border-slate-300">
                      <th className="text-left py-3 px-4 font-semibold text-slate-700 w-48">Metric</th>
                      {sizes.map(size => (
                        <th key={size} className="text-center py-3 px-3 font-semibold text-slate-700 border-l border-slate-200">
                          {size}
                        </th>
                      ))}
                      <th className="text-right py-3 px-4 font-semibold text-slate-700 border-l-2 border-slate-300 bg-slate-50">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Current Net Need */}
                    <tr className="border-b border-slate-200 hover:bg-slate-50">
                      <td className="py-3 px-4 font-medium text-slate-800">Current Net Need</td>
                      {netNeedValues.map((val, idx) => (
                        <td key={idx} className="text-center py-3 px-3 text-slate-700 border-l border-slate-100">
                          {val.toLocaleString()}
                        </td>
                      ))}
                      <td className="text-right py-3 px-4 font-bold text-slate-800 border-l-2 border-slate-300 bg-slate-50">
                        {netNeedTotal.toLocaleString()}
                      </td>
                    </tr>
                    <tr className="border-b-2 border-slate-300 bg-slate-50 hover:bg-slate-100">
                      <td className="py-3 px-4 font-medium text-slate-700 italic">% of Net Need Total</td>
                      {netNeedPercentages.map((pct, idx) => (
                        <td key={idx} className="text-center py-3 px-3 font-semibold text-slate-600 border-l border-slate-200">
                          {pct.toFixed(1)}%
                        </td>
                      ))}
                      <td className="text-right py-3 px-4 font-bold text-slate-700 border-l-2 border-slate-300 bg-slate-100">
                        100.0%
                      </td>
                    </tr>

                    {/* Historical Sales */}
                    <tr className="border-b border-slate-200 hover:bg-blue-50">
                      <td className="py-3 px-4 font-medium text-blue-800">Historical Sales</td>
                      {historicalSalesValues.map((val, idx) => (
                        <td key={idx} className="text-center py-3 px-3 text-blue-700 border-l border-slate-100">
                          {val.toLocaleString()}
                        </td>
                      ))}
                      <td className="text-right py-3 px-4 font-bold text-blue-800 border-l-2 border-slate-300 bg-blue-50">
                        {historicalSalesTotal.toLocaleString()}
                      </td>
                    </tr>
                    <tr className="border-b-2 border-blue-300 bg-blue-50 hover:bg-blue-100">
                      <td className="py-3 px-4 font-medium text-blue-800 italic">% of Historical Total</td>
                      {historicalSalesPercentages.map((pct, idx) => (
                        <td key={idx} className="text-center py-3 px-3 font-bold text-blue-700 border-l border-blue-100">
                          {pct.toFixed(1)}%
                        </td>
                      ))}
                      <td className="text-right py-3 px-4 font-bold text-blue-800 border-l-2 border-blue-300 bg-blue-100">
                        100.0%
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Order Calculation Results */}
          <Card className="border-2 border-green-200">
            <CardHeader className="bg-gradient-to-r from-green-50 to-emerald-50">
              <CardTitle className="flex items-center gap-2">
                <ArrowRight className="w-5 h-5 text-green-600" />
                Order Calculation
              </CardTitle>
              <CardDescription>
                Target: <strong>{parseFloat(targetQuantity).toLocaleString()} pieces</strong> distributed by historical sales patterns
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse border border-slate-200 rounded-lg overflow-hidden">
                  <thead>
                    <tr className="bg-slate-100 border-b-2 border-slate-300">
                      <th className="text-left py-3 px-4 font-semibold text-slate-700 w-48">Calculation</th>
                      {sizes.map(size => (
                        <th key={size} className="text-center py-3 px-3 font-semibold text-slate-700 border-l border-slate-200">
                          {size}
                        </th>
                      ))}
                      <th className="text-right py-3 px-4 font-semibold text-slate-700 border-l-2 border-slate-300 bg-slate-50">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-slate-200 bg-green-50 hover:bg-green-100">
                      <td className="py-3 px-4 font-medium text-green-800">Order (by Historical %)</td>
                      {calculateOrder.map((qty, idx) => (
                        <td key={idx} className="text-center py-3 px-3 font-bold text-green-700 border-l border-green-100">
                          {qty.toLocaleString()}
                        </td>
                      ))}
                      <td className="text-right py-3 px-4 font-bold text-green-800 border-l-2 border-slate-300 bg-green-100">
                        {orderTotal.toLocaleString()}
                      </td>
                    </tr>
                    <tr className="border-b border-slate-200 hover:bg-orange-50">
                      <td className="py-3 px-4 font-medium text-orange-800">Less: Current Net Need</td>
                      {netNeedValues.map((val, idx) => (
                        <td key={idx} className="text-center py-3 px-3 text-orange-700 border-l border-slate-100">
                          -{val.toLocaleString()}
                        </td>
                      ))}
                      <td className="text-right py-3 px-4 font-bold text-orange-800 border-l-2 border-slate-300 bg-orange-50">
                        -{netNeedTotal.toLocaleString()}
                      </td>
                    </tr>
                    <tr className="border-b-2 border-emerald-300 bg-emerald-50 hover:bg-emerald-100">
                      <td className="py-3 px-4 font-bold text-emerald-900">
                        = New Order to Place
                      </td>
                      {calculateNewOrderWithNetNeed.map((qty, idx) => (
                        <td key={idx} className="text-center py-3 px-3 font-bold text-emerald-800 text-base border-l border-emerald-100">
                          {qty.toLocaleString()}
                        </td>
                      ))}
                      <td className="text-right py-3 px-4 font-bold text-emerald-900 text-base border-l-2 border-emerald-300 bg-emerald-100">
                        {newOrderTotal.toLocaleString()}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Copy Buttons */}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    const orderText = calculateOrder.join('\t');
                    navigator.clipboard.writeText(orderText);
                  }}
                  variant="outline"
                  className="text-sm"
                >
                  📋 Copy Order (by Historical %)
                </Button>
                <Button
                  onClick={() => {
                    const newOrderText = calculateNewOrderWithNetNeed.join('\t');
                    navigator.clipboard.writeText(newOrderText);
                  }}
                  className="text-sm bg-emerald-600 hover:bg-emerald-700"
                >
                  📋 Copy New Order to Place
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* NEW NET NEED After Order */}
          <Card className="border-2 border-purple-200">
            <CardHeader className="bg-gradient-to-r from-purple-50 to-violet-50">
              <CardTitle className="flex items-center gap-2">
                <Package className="w-5 h-5 text-purple-600" />
                Net Need After Order
              </CardTitle>
              <CardDescription>
                Your inventory situation after placing the order
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse border border-slate-200 rounded-lg overflow-hidden">
                  <thead>
                    <tr className="bg-slate-100 border-b-2 border-slate-300">
                      <th className="text-left py-3 px-4 font-semibold text-slate-700 w-48">Metric</th>
                      {sizes.map(size => (
                        <th key={size} className="text-center py-3 px-3 font-semibold text-slate-700 border-l border-slate-200">
                          {size}
                        </th>
                      ))}
                      <th className="text-right py-3 px-4 font-semibold text-slate-700 border-l-2 border-slate-300 bg-slate-50">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-slate-200 hover:bg-purple-50">
                      <td className="py-3 px-4 font-medium text-purple-800">New Net Need (after order)</td>
                      {newNetNeedAfterOrder.map((val, idx) => (
                        <td key={idx} className="text-center py-3 px-3 font-bold text-purple-700 border-l border-slate-100">
                          {val.toLocaleString()}
                        </td>
                      ))}
                      <td className="text-right py-3 px-4 font-bold text-purple-800 border-l-2 border-slate-300 bg-purple-50">
                        {newNetNeedTotal.toLocaleString()}
                      </td>
                    </tr>
                    <tr className="border-b-2 border-purple-300 bg-purple-50 hover:bg-purple-100">
                      <td className="py-3 px-4 font-medium text-purple-800 italic">% of New Net Need Total</td>
                      {newNetNeedPercentages.map((pct, idx) => (
                        <td key={idx} className="text-center py-3 px-3 font-bold text-purple-700 border-l border-purple-100">
                          {pct.toFixed(1)}%
                        </td>
                      ))}
                      <td className="text-right py-3 px-4 font-bold text-purple-800 border-l-2 border-purple-300 bg-purple-100">
                        100.0%
                      </td>
                    </tr>
                    {/* Comparison row */}
                    <tr className="border-t-2 border-slate-300 bg-blue-50 hover:bg-blue-100">
                      <td className="py-3 px-4 font-medium text-blue-800 italic">Target % (Historical Sales)</td>
                      {historicalSalesPercentages.map((pct, idx) => (
                        <td key={idx} className="text-center py-3 px-3 font-semibold text-blue-700 border-l border-blue-100">
                          {pct.toFixed(1)}%
                        </td>
                      ))}
                      <td className="text-right py-3 px-4 font-semibold text-blue-800 border-l-2 border-slate-300 bg-blue-100">
                        100.0%
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Insights */}
              <div className="mt-4 p-4 bg-slate-50 rounded-lg border border-slate-200">
                <h4 className="text-sm font-semibold text-slate-700 mb-2">📊 Distribution Comparison</h4>
                <p className="text-xs text-slate-600">
                  The "New Net Need %" shows your inventory distribution after placing the order. 
                  Compare it with "Target % (Historical Sales)" to see how closely it matches your historical sales patterns.
                </p>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

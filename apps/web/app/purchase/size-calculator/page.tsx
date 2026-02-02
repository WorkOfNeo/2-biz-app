'use client';

import { useState, useMemo, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs';
import { Badge } from '../../../components/ui/badge';
import { Calculator, TrendingUp, Package, ArrowRight, Plus, Check, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import useSWR from 'swr';

type SizeSetType = '34-46' | 'S-XXL';

const SIZE_SETS = {
  '34-46': ['34', '36', '38', '40', '42', '44', '46'],
  'S-XXL': ['S', 'M', 'L', 'XL', 'XXL'],
};

type StyleColorItem = {
  id: string;
  style: string;
  color: string;
};

type OrderData = {
  styleColor: StyleColorItem;
  sizeSet: SizeSetType;
  netNeedValues: number[];
  historicalSalesValues: number[];
  targetQuantity: number;
  computedOrder: number[];
  timestamp: number;
  isColorBreakdown: boolean;
  whiteWeftPo?: number; // PO quantity from WHITE WEFT if color breakdown
};

type FlowStep = 'selection' | 'calculator' | 'overview';

export default function SizeCalculatorPage() {
  const supabase = createClientComponentClient();

  // Fetch styles from database
  const { data: styles } = useSWR('styles:all', async () => {
    const { data, error } = await supabase
      .from('styles')
      .select('id, style_no, style_name')
      .order('style_no');
    if (error) throw error;
    return data as Array<{ id: string; style_no: string; style_name: string }>;
  });

  // Flow state
  const [flowStep, setFlowStep] = useState<FlowStep>('selection');
  const [selectedItems, setSelectedItems] = useState<StyleColorItem[]>([]);
  const [currentItemIndex, setCurrentItemIndex] = useState(0);
  const [savedOrders, setSavedOrders] = useState<OrderData[]>([]);
  
  // Style/Color selection
  const [selectedStyleId, setSelectedStyleId] = useState('');
  const [selectedColorId, setSelectedColorId] = useState('');
  
  // Fetch colors for selected style
  const { data: styleColors } = useSWR(
    selectedStyleId ? ['style_colors', selectedStyleId] : null,
    async () => {
      const { data, error } = await supabase
        .from('style_colors')
        .select('id, color')
        .eq('style_id', selectedStyleId)
        .order('color');
      if (error) throw error;
      return data as Array<{ id: string; color: string }>;
    }
  );

  // Calculator state
  const [sizeSet, setSizeSet] = useState<SizeSetType>('34-46');
  const [netNeedInput, setNetNeedInput] = useState('');
  const [historicalSalesInput, setHistoricalSalesInput] = useState('');
  const [targetQuantity, setTargetQuantity] = useState('');
  const [computedOrder, setComputedOrder] = useState<number[] | null>(null);
  const [isColorBreakdown, setIsColorBreakdown] = useState(false);
  const [whiteWeftPo, setWhiteWeftPo] = useState<number | null>(null);

  const sizes = SIZE_SETS[sizeSet];
  const currentItem = selectedItems[currentItemIndex];

  // Reset calculator when moving to next item
  useEffect(() => {
    if (flowStep === 'calculator') {
      setNetNeedInput('');
      setHistoricalSalesInput('');
      setTargetQuantity('');
      setComputedOrder(null);
      setSizeSet('34-46');
      setIsColorBreakdown(false);
      setWhiteWeftPo(null);
    }
  }, [currentItemIndex, flowStep]);

  // Fetch WHITE WEFT PO when color breakdown is enabled
  useEffect(() => {
    if (!isColorBreakdown || !currentItem || flowStep !== 'calculator') {
      setWhiteWeftPo(null);
      return;
    }

    const fetchWhiteWeftPo = async () => {
      try {
        // First get Running/Shipped PO numbers
        const { data: pos, error: posError } = await supabase
          .from('purchase_orders')
          .select('po_no')
          .in('status', ['Running', 'Shipped']);

        if (posError) throw posError;
        if (!pos || pos.length === 0) {
          setWhiteWeftPo(0);
          return;
        }

        const poNumbers = pos.map(p => p.po_no);

        // Then get WHITE WEFT items for this style from those POs
        const { data: items, error: itemsError } = await supabase
          .from('purchase_order_items')
          .select('qty')
          .eq('style_no', currentItem.style)
          .ilike('color', 'WHITE WEFT')
          .in('po_no', poNumbers);

        if (itemsError) throw itemsError;

        const total = (items || []).reduce((sum, item) => sum + (item.qty || 0), 0);
        setWhiteWeftPo(total);
      } catch (error) {
        console.error('Error fetching WHITE WEFT PO:', error);
        setWhiteWeftPo(0);
      }
    };

    fetchWhiteWeftPo();
  }, [isColorBreakdown, currentItem, flowStep, supabase]);

  // Reset computed order when inputs change
  useEffect(() => {
    setComputedOrder(null);
  }, [netNeedInput, historicalSalesInput, targetQuantity, sizeSet]);

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

  // Calculate optimal order to match historical sales distribution in the final net need
  const calculateOptimalOrder = useMemo(() => {
    return (targetQty: number): number[] => {
      if (targetQty === 0 || historicalSalesTotal === 0 || netNeedTotal === 0) {
        return sizes.map(() => 0);
      }

      const maxIterations = 100;
      
      // Target final total after order
      const targetFinalTotal = netNeedTotal + targetQty;
      
      // Calculate desired quantities for each size based on historical percentages
      let order = sizes.map((_, idx) => {
        const histPct = historicalSalesPercentages[idx] ?? 0;
        const needVal = netNeedValues[idx] ?? 0;
        const desiredFinalQty = (histPct / 100) * targetFinalTotal;
        const orderQty = Math.max(0, desiredFinalQty - needVal);
        return Math.round(orderQty);
      });

      // Iteratively adjust to hit target total while maintaining distribution
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        const currentTotal = order.reduce((sum, val) => sum + val, 0);
        const diff = targetQty - currentTotal;
        
        if (Math.abs(diff) === 0) break;

        // Calculate current distribution quality (how close to target %)
        const currentFinal = order.map((o, idx) => (netNeedValues[idx] ?? 0) + o);
        const currentFinalTotal = currentFinal.reduce((sum, val) => sum + val, 0);
        const currentPcts = currentFinal.map(val => (val / currentFinalTotal) * 100);
        
        // Find size with largest deviation from target percentage
        const deviations = currentPcts.map((pct, idx) => ({
          idx,
          deviation: Math.abs(pct - (historicalSalesPercentages[idx] ?? 0)),
          direction: pct - (historicalSalesPercentages[idx] ?? 0)
        }));
        
        if (diff > 0) {
          // Need to add more - add to size that's most under target
          const underTarget = deviations
            .filter(d => d.direction < 0)
            .sort((a, b) => b.deviation - a.deviation);
          const targetIdx = underTarget.length > 0 ? underTarget[0]!.idx : deviations[0]!.idx;
          order[targetIdx]! += 1;
        } else {
          // Need to remove - remove from size that's most over target
          const overTarget = deviations
            .filter(d => d.direction > 0 && (order[d.idx] ?? 0) > 0)
            .sort((a, b) => b.deviation - a.deviation);
          const targetIdx = overTarget.length > 0 ? overTarget[0]!.idx : 
            order.findIndex((o) => o > 0);
          if (targetIdx >= 0 && order[targetIdx] !== undefined) order[targetIdx]! -= 1;
        }
      }

      return order;
    };
  }, [sizes, historicalSalesPercentages, historicalSalesTotal, netNeedTotal, netNeedValues]);
  
  // Use computed order if available, otherwise use simple distribution
  const calculateOrder = useMemo(() => {
    if (computedOrder) return computedOrder;
    
    const target = parseFloat(targetQuantity) || 0;
    if (target === 0 || historicalSalesTotal === 0) {
      return sizes.map(() => 0);
    }

    // Simple initial distribution based on historical sales percentages
    const initialOrder = historicalSalesPercentages.map(pct => 
      Math.round((pct / 100) * target)
    );

    // Adjust to match exact target (handle rounding differences)
    const currentTotal = initialOrder.reduce((sum, val) => sum + val, 0);
    const diff = target - currentTotal;

    if (diff !== 0) {
      const maxIdx = historicalSalesPercentages.indexOf(Math.max(...historicalSalesPercentages));
      initialOrder[maxIdx] = (initialOrder[maxIdx] || 0) + diff;
    }

    return initialOrder;
  }, [targetQuantity, historicalSalesPercentages, historicalSalesTotal, sizes, computedOrder]);

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
      const ordered = calculateOrder[idx] || 0;
      return need + ordered;
    });
  }, [netNeedValues, calculateOrder]);

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

  // Get selected style and color details
  const selectedStyle = styles?.find(s => s.id === selectedStyleId);
  const selectedColor = styleColors?.find(c => c.id === selectedColorId);

  // Handler functions
  const handleAddStyleColor = () => {
    if (!selectedStyle || !selectedColor) return;
    
    // Check if already added
    const exists = selectedItems.some(
      item => item.style === selectedStyle.style_no && item.color === selectedColor.color
    );
    if (exists) return;

    const newItem: StyleColorItem = {
      id: `${Date.now()}-${Math.random()}`,
      style: selectedStyle.style_no,
      color: selectedColor.color,
    };
    setSelectedItems([...selectedItems, newItem]);
    setSelectedStyleId('');
    setSelectedColorId('');
  };

  const handleRemoveItem = (id: string) => {
    setSelectedItems(selectedItems.filter(item => item.id !== id));
  };

  const handleStartCalculator = () => {
    if (selectedItems.length === 0) return;
    setCurrentItemIndex(0);
    setFlowStep('calculator');
  };

  const handleSaveAndNext = () => {
    if (!computedOrder || !currentItem) return;

    const orderData: OrderData = {
      styleColor: currentItem,
      sizeSet,
      netNeedValues,
      historicalSalesValues,
      targetQuantity: parseFloat(targetQuantity),
      computedOrder,
      timestamp: Date.now(),
      isColorBreakdown,
      whiteWeftPo: isColorBreakdown ? (whiteWeftPo ?? undefined) : undefined,
    };

    setSavedOrders([...savedOrders, orderData]);

    // Move to next item or overview
    if (currentItemIndex < selectedItems.length - 1) {
      setCurrentItemIndex(currentItemIndex + 1);
    } else {
      setFlowStep('overview');
    }
  };

  const handleSkipItem = () => {
    if (currentItemIndex < selectedItems.length - 1) {
      setCurrentItemIndex(currentItemIndex + 1);
    } else {
      setFlowStep('overview');
    }
  };

  const handleBackToSelection = () => {
    setFlowStep('selection');
    setCurrentItemIndex(0);
    setSavedOrders([]);
  };

  const handleRemoveOrder = (timestamp: number) => {
    setSavedOrders(savedOrders.filter(order => order.timestamp !== timestamp));
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-5xl mx-auto p-8">
        {/* Header */}
        <div className="mb-12 text-center">
          <h1 className="text-4xl font-light text-slate-900 tracking-tight mb-2">
            Purchase Order Calculator
          </h1>
          <p className="text-slate-500 text-sm">
            {flowStep === 'selection' && 'Select styles and colors to calculate'}
            {flowStep === 'calculator' && `${currentItemIndex + 1} of ${selectedItems.length}`}
            {flowStep === 'overview' && 'Order summary'}
          </p>
        </div>

        {/* STEP 1: Style/Color Selection */}
        {flowStep === 'selection' && (
          <div className="space-y-8">
            <Card className="border-0 shadow-sm">
              <CardContent className="p-8">
                <div className="space-y-6">
                  {/* Input Form */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-2 uppercase tracking-wide">
                        Style ({styles?.length || 0} available)
                      </label>
                      <select
                        value={selectedStyleId}
                        onChange={(e) => {
                          setSelectedStyleId(e.target.value);
                          setSelectedColorId(''); // Reset color when style changes
                        }}
                        className="w-full px-4 py-3 border border-slate-200 rounded-none focus:outline-none focus:border-slate-900 transition-colors text-sm bg-white"
                      >
                        <option value="">Select a style...</option>
                        {styles?.map(style => (
                          <option key={style.id} value={style.id}>
                            {style.style_no} {style.style_name ? `- ${style.style_name}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-2 uppercase tracking-wide">
                        Color {styleColors ? `(${styleColors.length} available)` : ''}
                      </label>
                      <select
                        value={selectedColorId}
                        onChange={(e) => setSelectedColorId(e.target.value)}
                        disabled={!selectedStyleId}
                        className="w-full px-4 py-3 border border-slate-200 rounded-none focus:outline-none focus:border-slate-900 transition-colors text-sm bg-white disabled:bg-slate-100 disabled:text-slate-400"
                      >
                        <option value="">
                          {!selectedStyleId ? 'Select a style first' : 'Select a color...'}
                        </option>
                        {styleColors?.map(color => (
                          <option key={color.id} value={color.id}>
                            {color.color}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  
                  <Button
                    onClick={handleAddStyleColor}
                    disabled={!selectedStyleId || !selectedColorId || !selectedStyle || !selectedColor}
                    variant="outline"
                    className="w-full rounded-none border-slate-900 text-slate-900 hover:bg-slate-900 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add to List
                  </Button>
                  {selectedStyle && selectedColor && (
                    <p className="text-xs text-center text-slate-500">
                      Adding: <span className="font-medium">{selectedStyle.style_no} - {selectedColor.color}</span>
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Selected Items */}
            {selectedItems.length > 0 && (
              <div className="space-y-3">
                <p className="text-xs font-medium text-slate-600 uppercase tracking-wide">
                  Selected ({selectedItems.length})
                </p>
                <div className="space-y-2">
                  {selectedItems.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between p-4 bg-white border border-slate-200"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-8 h-8 bg-slate-100 flex items-center justify-center text-xs font-medium text-slate-600">
                          {selectedItems.indexOf(item) + 1}
                        </div>
                        <div>
                          <p className="font-medium text-slate-900">{item.style}</p>
                          <p className="text-sm text-slate-500">{item.color}</p>
                        </div>
                      </div>
                      <button
                        onClick={() => handleRemoveItem(item.id)}
                        className="text-slate-400 hover:text-slate-900 transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>

                <Button
                  onClick={handleStartCalculator}
                  className="w-full rounded-none bg-slate-900 hover:bg-slate-800 text-white py-6"
                >
                  Start Calculator
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            )}
          </div>
        )}

        {/* STEP 2: Calculator */}
        {flowStep === 'calculator' && currentItem && (
          <div className="space-y-8">
            {/* Current Item Header */}
            <Card className="border-0 shadow-sm bg-slate-900 text-white">
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs opacity-60 mb-1">Currently calculating</p>
                    <p className="text-xl font-light">{currentItem.style}</p>
                    <p className="text-sm opacity-80">{currentItem.color}</p>
                  </div>
                  <Badge className="bg-white text-slate-900 border-0">
                    {currentItemIndex + 1} / {selectedItems.length}
                  </Badge>
                </div>
              </CardContent>
            </Card>

            <Card className="border-0 shadow-sm">
              <CardContent className="p-8 space-y-6">
                {/* Size Set Selection */}
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-3 uppercase tracking-wide">
                    Size Range
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setSizeSet('34-46')}
                      className={`p-3 border text-sm transition-all ${
                        sizeSet === '34-46'
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      34-46
                    </button>
                    <button
                      onClick={() => setSizeSet('S-XXL')}
                      className={`p-3 border text-sm transition-all ${
                        sizeSet === 'S-XXL'
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      S-XXL
                    </button>
                  </div>
                  <div className="mt-2 flex gap-1 text-xs text-slate-500">
                    {sizes.join(' · ')}
                  </div>
                </div>

                {/* Color Breakdown Toggle */}
                <div className="pb-6 border-b border-slate-200">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isColorBreakdown}
                      onChange={(e) => setIsColorBreakdown(e.target.checked)}
                      className="w-5 h-5 border-2 border-slate-300 rounded-none focus:outline-none focus:ring-2 focus:ring-slate-900"
                    />
                    <div>
                      <span className="text-sm font-medium text-slate-900">Color Breakdown</span>
                      <p className="text-xs text-slate-500 mt-0.5">
                        This color is made by deducting from WHITE WEFT inventory
                      </p>
                    </div>
                  </label>
                  {isColorBreakdown && whiteWeftPo !== null && (
                    <div className="mt-3 p-3 bg-blue-50 border border-blue-200">
                      <p className="text-xs font-medium text-blue-900 mb-1">
                        WHITE WEFT PO (Running/Shipped)
                      </p>
                      <p className="text-2xl font-light text-blue-900">
                        {whiteWeftPo.toLocaleString()} pieces
                      </p>
                      <p className="text-xs text-blue-700 mt-1">
                        Available for {currentItem.style} - WHITE WEFT
                      </p>
                    </div>
                  )}
                </div>

                {/* Data Inputs */}
                <div className="space-y-6">
                  {/* Current Net Need */}
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-2 uppercase tracking-wide">
                      Current Net Need ({sizes.length} values)
                    </label>
                    <input
                      type="text"
                      value={netNeedInput}
                      onChange={(e) => setNetNeedInput(e.target.value)}
                      placeholder="Paste space-separated values"
                      className={`w-full px-4 py-3 border text-sm font-mono focus:outline-none transition-colors ${
                        !netNeedValid
                          ? 'border-red-300 bg-red-50'
                          : netNeedTotal > 0
                          ? 'border-slate-900 bg-white'
                          : 'border-slate-200'
                      }`}
                    />
                    {netNeedValid && netNeedTotal > 0 && (
                      <p className="text-xs text-slate-500 mt-1">Total: {netNeedTotal.toLocaleString()}</p>
                    )}
                  </div>

                  {/* Historical Sales */}
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-2 uppercase tracking-wide">
                      Historical Sales ({sizes.length} values)
                    </label>
                    <input
                      type="text"
                      value={historicalSalesInput}
                      onChange={(e) => setHistoricalSalesInput(e.target.value)}
                      placeholder="Paste space-separated values"
                      className={`w-full px-4 py-3 border text-sm font-mono focus:outline-none transition-colors ${
                        !historicalSalesValid
                          ? 'border-red-300 bg-red-50'
                          : historicalSalesTotal > 0
                          ? 'border-slate-900 bg-white'
                          : 'border-slate-200'
                      }`}
                    />
                    {historicalSalesValid && historicalSalesTotal > 0 && (
                      <p className="text-xs text-slate-500 mt-1">Total: {historicalSalesTotal.toLocaleString()}</p>
                    )}
                  </div>

                  {/* Target Quantity */}
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-2 uppercase tracking-wide">
                      Target Order Quantity
                    </label>
                    <input
                      type="number"
                      value={targetQuantity}
                      onChange={(e) => setTargetQuantity(e.target.value)}
                      placeholder="Enter total pieces"
                      className="w-full px-4 py-3 border border-slate-200 text-lg font-semibold focus:outline-none focus:border-slate-900 transition-colors"
                    />
                  </div>
                </div>

                {/* Compute Button */}
                <Button
                  onClick={() => {
                    const target = parseFloat(targetQuantity) || 0;
                    if (target > 0) {
                      const optimal = calculateOptimalOrder(target);
                      setComputedOrder(optimal);
                    }
                  }}
                  disabled={
                    !targetQuantity ||
                    parseFloat(targetQuantity) <= 0 ||
                    !netNeedValid ||
                    !historicalSalesValid ||
                    netNeedTotal === 0 ||
                    historicalSalesTotal === 0
                  }
                  className="w-full rounded-none bg-slate-900 hover:bg-slate-800 text-white py-6"
                >
                  <Calculator className="w-4 h-4 mr-2" />
                  Compute Optimal Order
                </Button>

                {/* Action Buttons After Compute */}
                {computedOrder && (
                  <div className="pt-6 border-t border-slate-200 space-y-3">
                    <div className="flex items-center justify-center gap-2 text-sm text-slate-600 mb-4">
                      <Check className="w-4 h-4 text-green-600" />
                      Order computed: {computedOrder.reduce((sum, val) => sum + val, 0).toLocaleString()} pieces
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Button
                        onClick={handleSkipItem}
                        variant="outline"
                        className="rounded-none border-slate-200 hover:border-slate-300"
                      >
                        Skip
                      </Button>
                      <Button
                        onClick={handleSaveAndNext}
                        className="rounded-none bg-slate-900 hover:bg-slate-800 text-white"
                      >
                        {currentItemIndex < selectedItems.length - 1 ? 'Save & Next' : 'Save & Finish'}
                        <ArrowRight className="w-4 h-4 ml-2" />
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Navigation */}
            <div className="flex justify-between items-center text-sm text-slate-500">
              <button
                onClick={() => setFlowStep('selection')}
                className="hover:text-slate-900 transition-colors"
              >
                ← Back to selection
              </button>
              <span>
                {savedOrders.length} of {selectedItems.length} saved
              </span>
            </div>
          </div>
        )}

        {/* STEP 3: Overview */}
        {flowStep === 'overview' && (
          <div className="space-y-8">
            <Card className="border-0 shadow-sm">
              <CardContent className="p-8">
                {savedOrders.length === 0 ? (
                  <div className="text-center py-12 text-slate-500">
                    <p>No orders saved</p>
                    <Button
                      onClick={handleBackToSelection}
                      variant="outline"
                      className="mt-4 rounded-none"
                    >
                      Start Over
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-6">
                    <div className="flex items-center justify-between">
                      <h2 className="text-2xl font-light">Order Summary</h2>
                      <p className="text-sm text-slate-500">{savedOrders.length} items</p>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-200">
                            <th className="text-left py-3 px-4 font-medium text-slate-600 uppercase tracking-wide text-xs">
                              Style / Color
                            </th>
                            <th className="text-right py-3 px-3 font-medium text-slate-600 uppercase tracking-wide text-xs">
                              Historical Sales
                            </th>
                            <th className="text-right py-3 px-3 font-medium text-slate-600 uppercase tracking-wide text-xs">
                              Current Net Need
                            </th>
                            <th className="text-right py-3 px-3 font-medium text-slate-600 uppercase tracking-wide text-xs">
                              New PO
                            </th>
                            <th className="text-right py-3 px-3 font-medium text-slate-600 uppercase tracking-wide text-xs">
                              New Net Need
                            </th>
                            <th className="text-right py-3 px-3 font-medium text-slate-600 uppercase tracking-wide text-xs">
                              WHITE WEFT PO
                            </th>
                            <th className="w-12"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {savedOrders.map((order) => {
                            const histTotal = order.historicalSalesValues.reduce((sum, val) => sum + val, 0);
                            const netNeedTotal = order.netNeedValues.reduce((sum, val) => sum + val, 0);
                            const poTotal = order.computedOrder.reduce((sum, val) => sum + val, 0);
                            const newNetNeedTotal = netNeedTotal + poTotal;

                            return (
                              <tr key={order.timestamp} className="border-b border-slate-100 hover:bg-slate-50">
                                <td className="py-4 px-4">
                                  <div className="flex items-center gap-2">
                                    <div>
                                      <p className="font-medium text-slate-900">{order.styleColor.style}</p>
                                      <p className="text-xs text-slate-500">{order.styleColor.color}</p>
                                      <p className="text-xs text-slate-400 mt-1">{order.sizeSet}</p>
                                    </div>
                                    {order.isColorBreakdown && (
                                      <Badge className="bg-blue-100 text-blue-700 border-blue-300 text-[10px] px-1.5 py-0.5">
                                        Breakdown
                                      </Badge>
                                    )}
                                  </div>
                                </td>
                                <td className="text-right py-4 px-3 text-slate-700">
                                  {histTotal.toLocaleString()}
                                </td>
                                <td className="text-right py-4 px-3 text-slate-700">
                                  {netNeedTotal.toLocaleString()}
                                </td>
                                <td className="text-right py-4 px-3 font-semibold text-slate-900">
                                  {poTotal.toLocaleString()}
                                </td>
                                <td className="text-right py-4 px-3 text-slate-700">
                                  {newNetNeedTotal.toLocaleString()}
                                </td>
                                <td className="text-right py-4 px-3">
                                  {order.isColorBreakdown && order.whiteWeftPo !== undefined ? (
                                    <span className="text-blue-700 font-medium">
                                      {order.whiteWeftPo.toLocaleString()}
                                    </span>
                                  ) : (
                                    <span className="text-slate-400">—</span>
                                  )}
                                </td>
                                <td className="py-4 px-3">
                                  <button
                                    onClick={() => handleRemoveOrder(order.timestamp)}
                                    className="text-slate-400 hover:text-slate-900 transition-colors"
                                  >
                                    <X className="w-4 h-4" />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="border-t-2 border-slate-300 font-semibold">
                            <td className="py-4 px-4 text-slate-900">Total</td>
                            <td className="text-right py-4 px-3 text-slate-900">
                              {savedOrders.reduce((sum, o) => sum + o.historicalSalesValues.reduce((s, v) => s + v, 0), 0).toLocaleString()}
                            </td>
                            <td className="text-right py-4 px-3 text-slate-900">
                              {savedOrders.reduce((sum, o) => sum + o.netNeedValues.reduce((s, v) => s + v, 0), 0).toLocaleString()}
                            </td>
                            <td className="text-right py-4 px-3 text-slate-900">
                              {savedOrders.reduce((sum, o) => sum + o.computedOrder.reduce((s, v) => s + v, 0), 0).toLocaleString()}
                            </td>
                            <td className="text-right py-4 px-3 text-slate-900">
                              {savedOrders.reduce((sum, o) => {
                                const netNeed = o.netNeedValues.reduce((s, v) => s + v, 0);
                                const po = o.computedOrder.reduce((s, v) => s + v, 0);
                                return sum + netNeed + po;
                              }, 0).toLocaleString()}
                            </td>
                            <td className="text-right py-4 px-3 text-blue-700">
                              {savedOrders.reduce((sum, o) => sum + (o.whiteWeftPo || 0), 0).toLocaleString()}
                            </td>
                            <td></td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>

                    {/* Actions */}
                    <div className="flex gap-3 pt-6 border-t border-slate-200">
                      <Button
                        onClick={handleBackToSelection}
                        variant="outline"
                        className="rounded-none border-slate-200"
                      >
                        <ChevronLeft className="w-4 h-4 mr-2" />
                        Start New Order
                      </Button>
                      <Button
                        onClick={() => {
                          const csvContent = savedOrders.map(o => 
                            `${o.styleColor.style}\t${o.styleColor.color}\t${o.computedOrder.join('\t')}`
                          ).join('\n');
                          navigator.clipboard.writeText(csvContent);
                        }}
                        className="rounded-none bg-slate-900 hover:bg-slate-800"
                      >
                        Copy All Orders
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

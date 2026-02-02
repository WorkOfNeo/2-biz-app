'use client';

import { useState, useMemo, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs';
import { Badge } from '../../../components/ui/badge';
import { Calculator, TrendingUp, Package, ArrowRight, Plus, Check, ChevronLeft, ChevronRight, X, Search } from 'lucide-react';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import useSWR from 'swr';
import { SearchSelect } from '../../../components/SearchSelect';

type SizeSetType = '34-46' | 'S-XXL';

const SIZE_SETS = {
  '34-46': ['34', '36', '38', '40', '42', '44', '46'],
  'S-XXL': ['S', 'M', 'L', 'XL', 'XXL'],
};

type StyleColorItem = {
  id: string;
  style: string;
  color: string;
  isColorBreakdown: boolean;
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

type FlowStep = 'selection' | 'loading' | 'calculator' | 'overview';

type ScrapedStockData = {
  style_no: string;
  color: string;
  sizes: string[];
  stock: number[];
  sales: number[];
  po: number[];
  delivered?: number[];
  netNeed: number[];
};

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
  
  // Scraping state
  const [scrapeJobId, setScrapeJobId] = useState<string | null>(null);
  const [scrapedData, setScrapedData] = useState<Map<string, ScrapedStockData>>(new Map());
  const [scrapeError, setScrapeError] = useState<string | null>(null);
  
  // APP PO creation state
  const [creatingAppPo, setCreatingAppPo] = useState(false);
  const [appPoCreated, setAppPoCreated] = useState<Array<{ poNo: string; poId: string }>>([]);
  
  // Style/Color selection
  const [selectedStyleId, setSelectedStyleId] = useState('');
  const [selectedColorIds, setSelectedColorIds] = useState<Set<string>>(new Set());
  
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

  const toggleColorSelection = (colorId: string) => {
    setSelectedColorIds(prev => {
      const next = new Set(prev);
      if (next.has(colorId)) {
        next.delete(colorId);
      } else {
        next.add(colorId);
      }
      return next;
    });
  };

  const selectAllColors = () => {
    if (!styleColors) return;
    setSelectedColorIds(new Set(styleColors.map(c => c.id)));
  };

  const deselectAllColors = () => {
    setSelectedColorIds(new Set());
  };

  // Calculator state
  const [sizeSet, setSizeSet] = useState<SizeSetType>('34-46');
  const [netNeedInput, setNetNeedInput] = useState('');
  const [historicalSalesInput, setHistoricalSalesInput] = useState('');
  const [targetQuantity, setTargetQuantity] = useState('');
  const [computedOrder, setComputedOrder] = useState<number[] | null>(null);
  const [whiteWeftPo, setWhiteWeftPo] = useState<number | null>(null);

  const sizes = SIZE_SETS[sizeSet];
  const currentItem = selectedItems[currentItemIndex];
  
  // Get color breakdown status from current item
  const isColorBreakdown = currentItem?.isColorBreakdown || false;

  // Reset calculator and load scraped data when moving to next item
  useEffect(() => {
    if (flowStep === 'calculator' && currentItem) {
      const key = `${currentItem.style}|${currentItem.color}`;
      const scraped = scrapedData.get(key);
      
      if (scraped) {
        // Auto-populate from scraped data
        setNetNeedInput(scraped.netNeed.join(' '));
        setHistoricalSalesInput((scraped.delivered || []).join(' '));
        // Detect size set from scraped sizes
        const firstSize = scraped.sizes[0];
        if (firstSize && /^\d+$/.test(firstSize)) {
          setSizeSet('34-46');
        } else {
          setSizeSet('S-XXL');
        }
      } else {
        // No scraped data, reset fields
        setNetNeedInput('');
        setHistoricalSalesInput('');
        setSizeSet('34-46');
      }
      
      setTargetQuantity('');
      setComputedOrder(null);
      setWhiteWeftPo(null);
    }
  }, [currentItemIndex, flowStep, currentItem, scrapedData]);

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

  // Get selected style details
  const selectedStyle = styles?.find(s => s.id === selectedStyleId);
  const selectedColors = styleColors?.filter(c => selectedColorIds.has(c.id)) || [];

  // Handler functions
  const handleAddStyleColors = () => {
    if (!selectedStyle || selectedColors.length === 0) return;
    
    // Create a line for each selected color
    const newItems: StyleColorItem[] = selectedColors
      .filter(color => {
        // Skip if already exists
        return !selectedItems.some(
          item => item.style === selectedStyle.style_no && item.color === color.color
        );
      })
      .map(color => ({
        id: `${Date.now()}-${Math.random()}-${color.id}`,
        style: selectedStyle.style_no,
        color: color.color,
        isColorBreakdown: false, // Default to false, can be toggled per line
      }));

    setSelectedItems([...selectedItems, ...newItems]);
    setSelectedStyleId('');
    setSelectedColorIds(new Set());
  };

  const toggleItemColorBreakdown = (itemId: string) => {
    setSelectedItems(prev =>
      prev.map(item =>
        item.id === itemId
          ? { ...item, isColorBreakdown: !item.isColorBreakdown }
          : item
      )
    );
  };

  const handleRemoveItem = (id: string) => {
    setSelectedItems(selectedItems.filter(item => item.id !== id));
  };

  const handleStartCalculator = async () => {
    if (selectedItems.length === 0) return;
    
    setScrapeError(null);
    setFlowStep('loading');
    
    // Prepare style/color pairs for scraping
    const styleColorPairs = selectedItems.map(item => ({
      style_no: item.style,
      color: item.color
    }));
    
    try {
      // Enqueue scrape job
      const response = await fetch('/api/noos-call-off/enqueue-scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ styleColorPairs })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        console.error('[NOOS Call Off] Enqueue failed:', errorData);
        
        let errorMsg = errorData.error || 'Failed to enqueue scrape job';
        
        // Provide helpful hint if it's a constraint violation
        if (errorData.code === '23514' || errorMsg.includes('check constraint')) {
          errorMsg += '\n\nThe database migrations may not have been run yet. Please run the SQL migrations in supabase/sql/154_*, 155_*, 156_*.';
        }
        
        throw new Error(errorMsg);
      }
      
      const responseData = await response.json();
      console.log('[NOOS Call Off] Enqueue response:', responseData);
      
      const { jobId } = responseData;
      if (!jobId) {
        throw new Error('No job ID returned from server');
      }
      
      setScrapeJobId(jobId);
      
      // Poll for job completion
      let attempts = 0;
      const maxAttempts = 60; // 5 minutes with 5-second intervals
      
      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        attempts++;
        
        // Check job status
        const { data: job, error: jobError } = await supabase
          .from('jobs')
          .select('status, error')
          .eq('id', jobId)
          .maybeSingle();
        
        if (jobError) {
          console.error('Error fetching job:', jobError);
          continue; // Retry on error
        }
        
        if (!job) {
          console.warn('Job not found yet, retrying...');
          continue; // Job might not be visible yet, retry
        }
        
        if (job.status === 'failed') {
          throw new Error(job.error || 'Scrape job failed');
        }
        
        if (job.status === 'succeeded') {
          // Fetch scraped data
          const { data: stockRows } = await supabase
            .from('noos_call_off_stock')
            .select('*')
            .eq('job_id', jobId);
          
          if (!stockRows) {
            throw new Error('No stock data found');
          }
          
          // Process scraped data into usable format
          const dataMap = new Map<string, ScrapedStockData>();
          
          for (const item of selectedItems) {
            const key = `${item.style}|${item.color}`;
            const rows = (stockRows as any[]).filter(
              r => r.style_no === item.style && r.color.toLowerCase() === item.color.toLowerCase()
            );
            
            if (rows.length === 0) continue;
            
            const stockRow = rows.find(r => r.section === 'Stock' && r.row_label === 'Stock');
            const salesRows = rows.filter(r => r.section === 'Sold');
            const poRows = rows.filter(r => r.section === 'Purchase (Running + Shipped)');
            const deliveredRow = salesRows.find(r => /delivered/i.test(r.row_label || ''));
            
            if (!stockRow) continue;
            
            const sizes = stockRow.sizes as string[];
            const stock = stockRow.values as number[];
            
            // Sum all sales rows
            const sales = sizes.map((_, idx) => 
              salesRows.reduce((sum, row) => sum + ((row.values as number[])[idx] || 0), 0)
            );
            
            // Sum all PO rows
            const po = sizes.map((_, idx) => 
              poRows.reduce((sum, row) => sum + ((row.values as number[])[idx] || 0), 0)
            );
            
            // Delivered (Historical Sales)
            const delivered = deliveredRow ? (deliveredRow.values as number[]) : undefined;
            
            // Calculate Net Need: Stock - Sales + PO
            const netNeed = sizes.map((_, idx) => 
              (stock[idx] || 0) - (sales[idx] || 0) + (po[idx] || 0)
            );
            
            dataMap.set(key, {
              style_no: item.style,
              color: item.color,
              sizes,
              stock,
              sales,
              po,
              delivered,
              netNeed
            });
          }
          
          setScrapedData(dataMap);
          setCurrentItemIndex(0);
          setFlowStep('calculator');
          return;
        }
      }
      
      throw new Error('Scrape job timed out');
      
    } catch (error: any) {
      console.error('Error scraping stock:', error);
      setScrapeError(error.message || 'Failed to scrape stock data');
      setFlowStep('selection');
    }
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
    setAppPoCreated([]);
    setScrapeJobId(null);
    setScrapedData(new Map());
  };

  const handleRemoveOrder = (timestamp: number) => {
    setSavedOrders(savedOrders.filter(order => order.timestamp !== timestamp));
  };

  const handleCreateAppPo = async () => {
    if (savedOrders.length === 0) return;
    
    setCreatingAppPo(true);
    setAppPoCreated(null);
    
    try {
      // Separate regular orders from color breakdown orders
      const regularOrders = savedOrders.filter(o => !o.isColorBreakdown);
      const colorBreakdownOrders = savedOrders.filter(o => o.isColorBreakdown);
      
      // Get unique styles to fetch suppliers
      const uniqueStyles = Array.from(new Set(savedOrders.map(o => o.styleColor.style)));
      const { data: stylesData } = await supabase
        .from('styles')
        .select('style_no, supplier')
        .in('style_no', uniqueStyles);
      
      const styleToSupplier = new Map<string, string>();
      for (const style of (stylesData || [])) {
        styleToSupplier.set(style.style_no, style.supplier || 'Unknown');
      }
      
      const createdPos: Array<{ poNo: string; poId: string }> = [];
      
      // Create APP PO for regular orders (if any)
      if (regularOrders.length > 0) {
        const date = new Date();
        const poNo = `NOOS-${date.toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
        
        const supplier = styleToSupplier.get(regularOrders[0].styleColor.style) || 'Mixed';
        const totalQty = regularOrders.reduce((sum, o) => sum + o.computedOrder.reduce((s, v) => s + v, 0), 0);
        
        const items = regularOrders.map(order => {
          const sizes = SIZE_SETS[order.sizeSet];
          return {
            style_no: order.styleColor.style,
            color: order.styleColor.color,
            sizes,
            quantities: order.computedOrder,
            total: order.computedOrder.reduce((sum, val) => sum + val, 0),
            size_source: 'noos_call_off',
            net_need_before: order.netNeedValues,
            historical_sales: order.historicalSalesValues,
          };
        });
        
        const { data: newPo, error: poError } = await supabase
          .from('app_pos')
          .insert({
            po_no: poNo,
            status: 'Running',
            supplier,
            styles: Array.from(new Set(regularOrders.map(o => o.styleColor.style))).length,
            ordered: totalQty,
            meta: {
              items,
              source: 'noos_call_off',
              created_from_noos_call_off: true,
              scrape_job_id: scrapeJobId,
            },
          })
          .select('id, po_no')
          .single();
        
        if (poError || !newPo) {
          throw new Error(poError?.message || 'Failed to create regular APP PO');
        }
        
        createdPos.push({ poNo: newPo.po_no, poId: newPo.id });
      }
      
      // Create separate APP PO for each color breakdown order
      for (const order of colorBreakdownOrders) {
        const date = new Date();
        const poNo = `NOOS-COLORING-${date.toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
        
        const supplier = styleToSupplier.get(order.styleColor.style) || 'Unknown';
        const totalQty = order.computedOrder.reduce((s, v) => s + v, 0);
        const sizes = SIZE_SETS[order.sizeSet];
        
        const items = [{
          style_no: order.styleColor.style,
          color: order.styleColor.color,
          sizes,
          quantities: order.computedOrder,
          total: totalQty,
          size_source: 'noos_call_off_color_breakdown',
          net_need_before: order.netNeedValues,
          historical_sales: order.historicalSalesValues,
          white_weft_po: order.whiteWeftPo,
        }];
        
        const { data: newPo, error: poError } = await supabase
          .from('app_pos')
          .insert({
            po_no: poNo,
            status: 'Running',
            supplier,
            styles: 1,
            ordered: totalQty,
            meta: {
              items,
              source: 'noos_call_off_color_breakdown',
              created_from_noos_call_off: true,
              color_breakdown: true,
              scrape_job_id: scrapeJobId,
            },
          })
          .select('id, po_no')
          .single();
        
        if (poError || !newPo) {
          throw new Error(poError?.message || `Failed to create color breakdown APP PO for ${order.styleColor.style}/${order.styleColor.color}`);
        }
        
        createdPos.push({ poNo: newPo.po_no, poId: newPo.id });
      }
      
      setAppPoCreated(createdPos);
      
    } catch (error: any) {
      console.error('Error creating APP PO:', error);
      alert(`Failed to create APP PO: ${error.message}`);
    } finally {
      setCreatingAppPo(false);
    }
  };

  // Get style details for current item
  const currentStyleDetails = useMemo(() => {
    if (!currentItem) return null;
    return styles?.find(s => s.style_no === currentItem.style);
  }, [currentItem, styles]);

  // Overview expanded state
  const [expandedOrderTimestamps, setExpandedOrderTimestamps] = useState<Set<number>>(new Set());
  
  const toggleOrderExpanded = (timestamp: number) => {
    setExpandedOrderTimestamps(prev => {
      const next = new Set(prev);
      if (next.has(timestamp)) {
        next.delete(timestamp);
      } else {
        next.add(timestamp);
      }
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-6xl mx-auto p-6">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Package className="w-7 h-7 text-slate-700" />
            <h1 className="text-3xl font-semibold text-slate-900">
              NOOS Call Off
            </h1>
          </div>
          <div className="flex items-center gap-4">
            <p className="text-slate-600 text-sm">
              {flowStep === 'selection' && 'Select styles and colors for NOOS replenishment'}
              {flowStep === 'loading' && 'Fetching stock data from supplier...'}
              {flowStep === 'calculator' && (
                <>
                  <span className="font-medium">Processing:</span> {currentItemIndex + 1} of {selectedItems.length} items
                </>
              )}
              {flowStep === 'overview' && `Order summary - ${savedOrders.length} items`}
            </p>
            {flowStep === 'calculator' && (
              <div className="flex-1 max-w-xs">
                <div className="w-full bg-slate-300 h-2 rounded-full overflow-hidden">
                  <div 
                    className="bg-slate-900 h-2 transition-all duration-300"
                    style={{ width: `${((currentItemIndex + 1) / selectedItems.length) * 100}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* STEP 1: Style/Color Selection */}
        {flowStep === 'selection' && (
          <div className="space-y-6">
            <Card className="border border-slate-200 shadow-md">
              <CardContent className="p-6">
                <div className="space-y-5">
                  {/* Style Search */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Search Style <span className="text-slate-500 font-normal">({styles?.length || 0} available)</span>
                    </label>
                    <SearchSelect
                      items={styles?.map(s => ({
                        value: s.id,
                        label: s.style_no,
                        description: s.style_name || undefined,
                      })) || []}
                      value={selectedStyleId}
                      onChange={(id) => {
                        setSelectedStyleId(id);
                        setSelectedColorIds(new Set()); // Reset colors when style changes
                      }}
                      placeholder="Type to search..."
                      className="w-full"
                    />
                  </div>

                  {/* Color Multi-Select */}
                  {selectedStyleId && styleColors && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="block text-xs font-semibold text-slate-700">
                          Select Colors <span className="text-slate-500 font-normal">({styleColors.length} available)</span>
                        </label>
                        <div className="flex gap-3">
                          <button
                            onClick={selectAllColors}
                            className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                          >
                            Select All
                          </button>
                          <button
                            onClick={deselectAllColors}
                            className="text-xs text-slate-600 hover:text-slate-900 font-medium"
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                      <div className="border-2 border-slate-200 rounded-lg max-h-64 overflow-y-auto">
                        {styleColors.map(color => (
                          <label
                            key={color.id}
                            className="flex items-center gap-3 px-3 py-2 hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-b-0 transition-colors"
                          >
                            <input
                              type="checkbox"
                              checked={selectedColorIds.has(color.id)}
                              onChange={() => toggleColorSelection(color.id)}
                              className="w-4 h-4 border-2 border-slate-300 text-slate-900 focus:ring-2 focus:ring-slate-900 rounded"
                            />
                            <span className="text-sm text-slate-900">{color.color}</span>
                          </label>
                        ))}
                      </div>
                      <div className="flex items-center justify-between mt-1.5">
                        <p className="text-xs text-slate-600 font-medium">
                          {selectedColorIds.size} selected
                        </p>
                      </div>
                    </div>
                  )}
                  
                  <Button
                    onClick={handleAddStyleColors}
                    disabled={!selectedStyleId || selectedColors.length === 0}
                    className="w-full bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white h-11 shadow-md disabled:opacity-50"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add {selectedColors.length > 0 ? `${selectedColors.length} Line${selectedColors.length !== 1 ? 's' : ''}` : 'Lines'}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Selected Items */}
            {selectedItems.length > 0 && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-900">
                    Selected Lines <Badge className="ml-2 bg-slate-900 text-white border-0">{selectedItems.length}</Badge>
                  </p>
                </div>
                
                <div className="grid gap-2">
                  {selectedItems.map((item) => {
                    const styleDetail = styles?.find(s => s.style_no === item.style);
                    return (
                      <div
                        key={item.id}
                        className="group flex items-center justify-between p-3 bg-white border border-slate-200 hover:border-slate-300 hover:shadow-sm transition-all"
                      >
                        <div className="flex items-center gap-3 flex-1">
                          <div className="w-7 h-7 bg-slate-900 text-white flex items-center justify-center text-xs font-semibold flex-shrink-0">
                            {selectedItems.indexOf(item) + 1}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="font-semibold text-slate-900 text-sm">
                                {item.style}
                              </p>
                              {styleDetail?.style_name && (
                                <p className="text-xs text-slate-500 truncate">
                                  {styleDetail.style_name}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              <p className="text-xs text-slate-600">{item.color}</p>
                              {item.isColorBreakdown && (
                                <Badge className="bg-blue-100 text-blue-700 border-blue-200 text-[10px] px-1.5 py-0.5">
                                  Breakdown
                                </Badge>
                              )}
                            </div>
                          </div>
                          
                          {/* Color Breakdown Toggle - Inline */}
                          <label className="flex items-center gap-2 cursor-pointer mr-2" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={item.isColorBreakdown}
                              onChange={() => toggleItemColorBreakdown(item.id)}
                              className="w-4 h-4 border-2 border-slate-300 text-slate-900 focus:ring-2 focus:ring-slate-900 rounded"
                            />
                            <span className="text-[11px] text-slate-500 whitespace-nowrap">Break</span>
                          </label>

                          <button
                            onClick={() => handleRemoveItem(item.id)}
                            className="text-slate-400 hover:text-red-600 transition-colors opacity-0 group-hover:opacity-100"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {scrapeError && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <p className="text-sm text-red-800 font-medium">Error fetching stock data:</p>
                    <p className="text-sm text-red-600 mt-1">{scrapeError}</p>
                  </div>
                )}

                <Button
                  onClick={handleStartCalculator}
                  className="w-full bg-slate-900 hover:bg-slate-800 text-white h-12 text-sm font-medium"
                  disabled={selectedItems.length === 0}
                >
                  Start NOOS Call Off
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            )}
          </div>
        )}

        {/* LOADING STATE */}
        {flowStep === 'loading' && (
          <Card className="border border-slate-200 shadow-md">
            <CardContent className="p-12">
              <div className="flex flex-col items-center justify-center">
                <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-slate-900 mb-6"></div>
                <p className="text-lg font-medium text-slate-900 mb-2">Fetching stock data...</p>
                <p className="text-sm text-slate-600 text-center max-w-md">
                  Scraping stock, sales, and PO data for {selectedItems.length} style{selectedItems.length !== 1 ? 's' : ''}. 
                  This may take a few minutes.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* STEP 2: Calculator */}
        {flowStep === 'calculator' && currentItem && (
          <div className="space-y-6">
            {/* Current Item Info Bar */}
            <div className="bg-gradient-to-r from-slate-900 to-slate-800 text-white rounded-lg p-5 shadow-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 bg-white/10 backdrop-blur flex items-center justify-center rounded-lg">
                    <Package className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="font-semibold text-lg">{currentItem.style}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <p className="text-sm text-slate-300">{currentStyleDetails?.style_name || currentItem.style}</p>
                      <span className="text-slate-400">•</span>
                      <p className="text-sm text-white">{currentItem.color}</p>
                      {currentItem.isColorBreakdown && (
                        <>
                          <span className="text-slate-400">•</span>
                          <Badge className="bg-blue-500 text-white border-0 text-[10px] px-2">
                            Color Breakdown
                          </Badge>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-xs text-slate-400">Item</p>
                  <p className="text-2xl font-light">{currentItemIndex + 1}<span className="text-slate-400 text-lg">/{selectedItems.length}</span></p>
                </div>
              </div>
            </div>

            <Card className="border border-slate-200 shadow-md">
              <CardContent className="p-6 space-y-5">
                {/* Scraped Stock Data Display */}
                {(() => {
                  const key = `${currentItem.style}|${currentItem.color}`;
                  const scraped = scrapedData.get(key);
                  if (scraped) {
                    return (
                      <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                        <h3 className="text-sm font-semibold text-slate-900 mb-3">Current Stock Status</h3>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-slate-300">
                                <th className="text-left py-2 px-2 font-semibold text-slate-700">Size</th>
                                {scraped.sizes.map(size => (
                                  <th key={size} className="text-center py-2 px-2 font-semibold text-slate-700">{size}</th>
                                ))}
                                <th className="text-center py-2 px-2 font-semibold text-slate-700">Total</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-200">
                              <tr className="hover:bg-white">
                                <td className="py-2 px-2 font-medium text-slate-700">Stock</td>
                                {scraped.stock.map((val, idx) => (
                                  <td key={idx} className="text-center py-2 px-2 text-slate-900">{val}</td>
                                ))}
                                <td className="text-center py-2 px-2 font-semibold text-slate-900">
                                  {scraped.stock.reduce((a, b) => a + b, 0)}
                                </td>
                              </tr>
                              <tr className="hover:bg-white">
                                <td className="py-2 px-2 font-medium text-slate-700">Sales</td>
                                {scraped.sales.map((val, idx) => (
                                  <td key={idx} className="text-center py-2 px-2 text-slate-900">{val}</td>
                                ))}
                                <td className="text-center py-2 px-2 font-semibold text-slate-900">
                                  {scraped.sales.reduce((a, b) => a + b, 0)}
                                </td>
                              </tr>
                              <tr className="hover:bg-white">
                                <td className="py-2 px-2 font-medium text-slate-700">PO</td>
                                {scraped.po.map((val, idx) => (
                                  <td key={idx} className="text-center py-2 px-2 text-slate-900">{val}</td>
                                ))}
                                <td className="text-center py-2 px-2 font-semibold text-slate-900">
                                  {scraped.po.reduce((a, b) => a + b, 0)}
                                </td>
                              </tr>
                              {scraped.delivered && (
                                <tr className="hover:bg-white bg-blue-50">
                                  <td className="py-2 px-2 font-medium text-blue-900">Delivered</td>
                                  {scraped.delivered.map((val, idx) => (
                                    <td key={idx} className="text-center py-2 px-2 text-blue-900">{val}</td>
                                  ))}
                                  <td className="text-center py-2 px-2 font-semibold text-blue-900">
                                    {scraped.delivered.reduce((a, b) => a + b, 0)}
                                  </td>
                                </tr>
                              )}
                              <tr className="hover:bg-white bg-slate-100 font-semibold">
                                <td className="py-2 px-2 text-slate-900">Net Need</td>
                                {scraped.netNeed.map((val, idx) => (
                                  <td key={idx} className={`text-center py-2 px-2 ${val < 0 ? 'text-red-600' : 'text-green-600'}`}>
                                    {val}
                                  </td>
                                ))}
                                <td className={`text-center py-2 px-2 ${scraped.netNeed.reduce((a, b) => a + b, 0) < 0 ? 'text-red-600' : 'text-green-600'}`}>
                                  {scraped.netNeed.reduce((a, b) => a + b, 0)}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                        <p className="text-xs text-slate-600 mt-2 italic">
                          Net Need = Stock - Sales + PO
                        </p>
                      </div>
                    );
                  }
                  return null;
                })()}

                {/* Color Breakdown Info (if enabled) */}
                {isColorBreakdown && whiteWeftPo !== null && (
                  <div className="bg-gradient-to-r from-blue-50 to-blue-100 border-l-4 border-blue-500 p-4 rounded-r">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs font-semibold text-blue-900 uppercase tracking-wide">
                          WHITE WEFT Available
                        </p>
                        <p className="text-sm text-blue-700 mt-0.5">
                          Running/Shipped PO for {currentItem.style}
                        </p>
                      </div>
                      <p className="text-3xl font-bold text-blue-900">
                        {whiteWeftPo.toLocaleString()}
                      </p>
                    </div>
                  </div>
                )}

                {/* Size Set Selection */}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-2">
                    Size Range
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setSizeSet('34-46')}
                      className={`flex-1 px-4 py-2.5 text-sm font-medium border-2 transition-all ${
                        sizeSet === '34-46'
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-200 hover:border-slate-400 bg-white'
                      }`}
                    >
                      34-46
                    </button>
                    <button
                      onClick={() => setSizeSet('S-XXL')}
                      className={`flex-1 px-4 py-2.5 text-sm font-medium border-2 transition-all ${
                        sizeSet === 'S-XXL'
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-200 hover:border-slate-400 bg-white'
                      }`}
                    >
                      S-XXL
                    </button>
                  </div>
                  <p className="text-xs text-slate-500 mt-1.5">
                    {sizes.join(' · ')}
                  </p>
                </div>

                {/* Data Inputs */}
                <div className="grid md:grid-cols-3 gap-4">
                  {/* Current Net Need */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Current Net Need
                    </label>
                    <input
                      type="text"
                      value={netNeedInput}
                      onChange={(e) => setNetNeedInput(e.target.value)}
                      placeholder={`${sizes.length} values`}
                      className={`w-full px-3 py-2 border-2 text-sm font-mono focus:outline-none focus:ring-2 transition-colors ${
                        !netNeedValid
                          ? 'border-red-400 bg-red-50 focus:ring-red-200'
                          : netNeedTotal > 0
                          ? 'border-slate-900 bg-white focus:ring-slate-200'
                          : 'border-slate-300 focus:ring-slate-200'
                      }`}
                    />
                    {netNeedValid && netNeedTotal > 0 && (
                      <p className="text-xs text-slate-600 mt-1 font-medium">{netNeedTotal.toLocaleString()} pcs</p>
                    )}
                  </div>

                  {/* Historical Sales */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Historical Sales
                    </label>
                    <input
                      type="text"
                      value={historicalSalesInput}
                      onChange={(e) => setHistoricalSalesInput(e.target.value)}
                      placeholder={`${sizes.length} values`}
                      className={`w-full px-3 py-2 border-2 text-sm font-mono focus:outline-none focus:ring-2 transition-colors ${
                        !historicalSalesValid
                          ? 'border-red-400 bg-red-50 focus:ring-red-200'
                          : historicalSalesTotal > 0
                          ? 'border-blue-600 bg-white focus:ring-blue-200'
                          : 'border-slate-300 focus:ring-slate-200'
                      }`}
                    />
                    {historicalSalesValid && historicalSalesTotal > 0 && (
                      <p className="text-xs text-blue-600 mt-1 font-medium">{historicalSalesTotal.toLocaleString()} pcs</p>
                    )}
                  </div>

                  {/* Target Quantity */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Target Quantity
                    </label>
                    <input
                      type="number"
                      value={targetQuantity}
                      onChange={(e) => setTargetQuantity(e.target.value)}
                      placeholder="Total"
                      className="w-full px-3 py-2 border-2 border-slate-300 text-lg font-bold focus:outline-none focus:ring-2 focus:ring-slate-200 focus:border-slate-900 transition-colors"
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
                  className="w-full bg-gradient-to-r from-slate-900 to-slate-800 hover:from-slate-800 hover:to-slate-700 text-white h-11 text-sm font-semibold shadow-md"
                >
                  <TrendingUp className="w-4 h-4 mr-2" />
                  Compute Optimal Order
                </Button>

                {/* Calculation Results */}
                {computedOrder && netNeedValid && historicalSalesValid && (
                  <div className="pt-5 border-t-2 border-slate-200 space-y-4">
                    <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-lg px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Check className="w-5 h-5 text-green-600" />
                        <span className="text-sm font-medium text-green-900">Order Computed</span>
                      </div>
                      <span className="text-xl font-bold text-green-900">
                        {computedOrder.reduce((sum, val) => sum + val, 0).toLocaleString()}
                      </span>
                    </div>

                    {/* Results Table */}
                    <div className="overflow-x-auto bg-white border-2 border-slate-200 rounded-lg">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-gradient-to-r from-slate-100 to-slate-50 border-b-2 border-slate-300">
                            <th className="text-left py-2.5 px-4 font-semibold text-slate-700 w-32">Metric</th>
                            {sizes.map(size => (
                              <th key={size} className="text-center py-2.5 px-2 font-semibold text-slate-700 border-l border-slate-200">
                                {size}
                              </th>
                            ))}
                            <th className="text-right py-2.5 px-4 font-semibold text-slate-700 border-l-2 border-slate-300">
                              Total
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {/* Current Net Need */}
                          <tr className="border-b border-slate-200 hover:bg-slate-50">
                            <td className="py-2 px-4 text-slate-700 font-medium">Net Need</td>
                            {netNeedValues.map((val, idx) => (
                              <td key={idx} className="text-center py-2 px-2 border-l border-slate-100">
                                <div className="font-semibold text-slate-800">{val.toLocaleString()}</div>
                                <div className="text-[9px] text-slate-500">{(netNeedPercentages[idx] ?? 0).toFixed(1)}%</div>
                              </td>
                            ))}
                            <td className="text-right py-2 px-4 font-bold text-slate-800 border-l-2 border-slate-300">
                              {netNeedTotal.toLocaleString()}
                            </td>
                          </tr>

                          {/* Historical Sales */}
                          <tr className="border-b-2 border-blue-200 bg-gradient-to-r from-blue-50 to-blue-100">
                            <td className="py-2 px-4 text-blue-900 font-semibold">Hist. Sales</td>
                            {historicalSalesValues.map((val, idx) => (
                              <td key={idx} className="text-center py-2 px-2 border-l border-blue-100">
                                <div className="font-semibold text-blue-800">{val.toLocaleString()}</div>
                                <div className="text-[9px] text-blue-700 font-semibold">{(historicalSalesPercentages[idx] ?? 0).toFixed(1)}%</div>
                              </td>
                            ))}
                            <td className="text-right py-2 px-4 font-bold text-blue-900 border-l-2 border-slate-300">
                              {historicalSalesTotal.toLocaleString()}
                            </td>
                          </tr>

                          {/* New Order */}
                          <tr className="border-b-2 border-green-200 bg-gradient-to-r from-green-50 to-green-100">
                            <td className="py-2 px-4 font-bold text-green-900">New Order</td>
                            {calculateOrder.map((qty, idx) => (
                              <td key={idx} className="text-center py-2 px-2 font-bold text-green-800 border-l border-green-100">
                                {qty.toLocaleString()}
                              </td>
                            ))}
                            <td className="text-right py-2 px-4 font-bold text-green-900 border-l-2 border-slate-300">
                              {orderTotal.toLocaleString()}
                            </td>
                          </tr>

                          {/* New Net Need After Order */}
                          <tr className="bg-gradient-to-r from-purple-50 to-purple-100">
                            <td className="py-2 px-4 font-bold text-purple-900">New Net Need</td>
                            {newNetNeedAfterOrder.map((val, idx) => {
                              const deviation = Math.abs((newNetNeedPercentages[idx] ?? 0) - (historicalSalesPercentages[idx] ?? 0));
                              const isClose = deviation < 1.0;
                              return (
                                <td key={idx} className="text-center py-2 px-2 border-l border-purple-100">
                                  <div className="font-bold text-purple-800">{val.toLocaleString()}</div>
                                  <div className={`text-[9px] font-bold ${isClose ? 'text-green-600' : 'text-orange-600'}`}>
                                    {(newNetNeedPercentages[idx] ?? 0).toFixed(1)}%
                                  </div>
                                </td>
                              );
                            })}
                            <td className="text-right py-2 px-4 font-bold text-purple-900 border-l-2 border-slate-300">
                              {newNetNeedTotal.toLocaleString()}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex gap-3">
                      <Button
                        onClick={handleSkipItem}
                        variant="outline"
                        className="flex-1 border-2 border-slate-300 hover:border-slate-400 hover:bg-slate-50"
                      >
                        Skip
                      </Button>
                      <Button
                        onClick={handleSaveAndNext}
                        className="flex-[2] bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white shadow-md"
                      >
                        <Check className="w-4 h-4 mr-2" />
                        {currentItemIndex < selectedItems.length - 1 ? 'Save & Next' : 'Save & Finish'}
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Navigation */}
            <div className="flex justify-between items-center">
              <Button
                onClick={() => setFlowStep('selection')}
                variant="ghost"
                size="sm"
                className="text-slate-600 hover:text-slate-900"
              >
                <ChevronLeft className="w-4 h-4 mr-1" />
                Back to selection
              </Button>
              <Badge className="bg-slate-100 text-slate-700 border-slate-300">
                {savedOrders.length} of {selectedItems.length} saved
              </Badge>
            </div>
          </div>
        )}

        {/* STEP 3: Overview */}
        {flowStep === 'overview' && (
          <div className="space-y-6">
            <Card className="border border-slate-200 shadow-md">
              <CardHeader className="bg-gradient-to-r from-slate-50 to-slate-100 border-b">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-xl font-semibold text-slate-900">Order Summary</CardTitle>
                  <Badge className="bg-slate-900 text-white border-0 px-3 py-1">
                    {savedOrders.length} items
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="p-6">
                {savedOrders.length === 0 ? (
                  <div className="text-center py-16 text-slate-500">
                    <Package className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                    <p className="mb-4">No orders saved</p>
                    <Button
                      onClick={handleBackToSelection}
                      variant="outline"
                      className="border-2"
                    >
                      Start Over
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-5">

                    <div className="overflow-x-auto bg-white border-2 border-slate-200 rounded-lg">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-gradient-to-r from-slate-100 to-slate-50 border-b-2 border-slate-300">
                            <th className="text-left py-3 px-4 font-semibold text-slate-700 text-xs">
                              Style / Color
                            </th>
                            <th className="text-right py-3 px-3 font-semibold text-slate-700 text-xs">
                              Hist. Sales
                            </th>
                            <th className="text-right py-3 px-3 font-semibold text-slate-700 text-xs">
                              Net Need
                            </th>
                            <th className="text-right py-3 px-3 font-semibold text-slate-700 text-xs">
                              New PO
                            </th>
                            <th className="text-right py-3 px-3 font-semibold text-slate-700 text-xs">
                              New Net Need
                            </th>
                            <th className="text-right py-3 px-3 font-semibold text-slate-700 text-xs">
                              WHITE WEFT
                            </th>
                            <th className="w-10"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {savedOrders.map((order) => {
                            const histTotal = order.historicalSalesValues.reduce((sum, val) => sum + val, 0);
                            const netNeedTotal = order.netNeedValues.reduce((sum, val) => sum + val, 0);
                            const poTotal = order.computedOrder.reduce((sum, val) => sum + val, 0);
                            const newNetNeedTotal = netNeedTotal + poTotal;
                            const styleDetail = styles?.find(s => s.style_no === order.styleColor.style);
                            const isExpanded = expandedOrderTimestamps.has(order.timestamp);
                            const sizes = SIZE_SETS[order.sizeSet];

                            return (
                              <>
                                <tr key={order.timestamp} className="border-b border-slate-200 hover:bg-gradient-to-r hover:from-slate-50 hover:to-transparent transition-colors">
                                  <td className="py-3 px-4">
                                    <div className="flex items-center gap-2">
                                      <button
                                        onClick={() => toggleOrderExpanded(order.timestamp)}
                                        className="text-slate-400 hover:text-slate-700 transition-colors"
                                      >
                                        {isExpanded ? (
                                          <ChevronDown className="w-4 h-4" />
                                        ) : (
                                          <ChevronRight className="w-4 h-4" />
                                        )}
                                      </button>
                                      <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                          <p className="font-semibold text-slate-900">{order.styleColor.style}</p>
                                          {styleDetail?.style_name && (
                                            <p className="text-xs text-slate-500 truncate">
                                              {styleDetail.style_name}
                                            </p>
                                          )}
                                        </div>
                                        <div className="flex items-center gap-2 mt-0.5">
                                          <p className="text-xs text-slate-600">{order.styleColor.color}</p>
                                          <span className="text-slate-300">·</span>
                                          <p className="text-xs text-slate-400">{order.sizeSet}</p>
                                          {order.isColorBreakdown && (
                                            <>
                                              <span className="text-slate-300">·</span>
                                              <Badge className="bg-blue-500 text-white border-0 text-[9px] px-1.5 py-0">
                                                Breakdown
                                              </Badge>
                                            </>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                  <td className="text-right py-3 px-3 text-slate-700 font-medium">
                                    {histTotal.toLocaleString()}
                                  </td>
                                  <td className="text-right py-3 px-3 text-slate-700 font-medium">
                                    {netNeedTotal.toLocaleString()}
                                  </td>
                                  <td className="text-right py-3 px-3 font-bold text-green-700">
                                    {poTotal.toLocaleString()}
                                  </td>
                                  <td className="text-right py-3 px-3 text-slate-700 font-medium">
                                    {newNetNeedTotal.toLocaleString()}
                                  </td>
                                  <td className="text-right py-3 px-3">
                                    {order.isColorBreakdown && order.whiteWeftPo !== undefined ? (
                                      <span className="text-blue-700 font-bold">
                                        {order.whiteWeftPo.toLocaleString()}
                                      </span>
                                    ) : (
                                      <span className="text-slate-300">—</span>
                                    )}
                                  </td>
                                  <td className="py-3 px-3">
                                    <button
                                      onClick={() => handleRemoveOrder(order.timestamp)}
                                      className="text-slate-400 hover:text-red-600 transition-colors"
                                    >
                                      <X className="w-4 h-4" />
                                    </button>
                                  </td>
                                </tr>
                                {isExpanded && (
                                  <tr key={`${order.timestamp}-detail`} className="bg-slate-50">
                                    <td colSpan={7} className="px-4 py-3">
                                      <div className="ml-8 bg-white border border-slate-200 rounded-lg p-3">
                                        <p className="text-xs font-semibold text-slate-700 mb-2">Size Breakdown</p>
                                        <div className="overflow-x-auto">
                                          <table className="w-full text-xs">
                                            <thead>
                                              <tr className="border-b border-slate-200">
                                                <th className="text-left py-1 px-2 text-slate-600 font-medium">Size</th>
                                                {sizes.map(size => (
                                                  <th key={size} className="text-center py-1 px-2 text-slate-600 font-medium">{size}</th>
                                                ))}
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {histTotal > 0 && (
                                                <tr className="border-b border-slate-100">
                                                  <td className="py-1 px-2 text-slate-600">Hist. Sales</td>
                                                  {order.historicalSalesValues.map((val, idx) => (
                                                    <td key={idx} className="text-center py-1 px-2 text-slate-700">{val}</td>
                                                  ))}
                                                </tr>
                                              )}
                                              <tr className="border-b border-slate-100">
                                                <td className="py-1 px-2 text-slate-600">Net Need</td>
                                                {order.netNeedValues.map((val, idx) => (
                                                  <td key={idx} className="text-center py-1 px-2 text-slate-700">{val}</td>
                                                ))}
                                              </tr>
                                              <tr className="border-b border-slate-100 bg-green-50">
                                                <td className="py-1 px-2 text-green-800 font-semibold">New Order</td>
                                                {order.computedOrder.map((val, idx) => (
                                                  <td key={idx} className="text-center py-1 px-2 text-green-800 font-semibold">{val}</td>
                                                ))}
                                              </tr>
                                              <tr className="bg-slate-50">
                                                <td className="py-1 px-2 text-slate-800 font-semibold">New Net Need</td>
                                                {order.netNeedValues.map((need, idx) => {
                                                  const newNeed = need + (order.computedOrder[idx] || 0);
                                                  return (
                                                    <td key={idx} className="text-center py-1 px-2 text-slate-800 font-semibold">{newNeed}</td>
                                                  );
                                                })}
                                              </tr>
                                            </tbody>
                                          </table>
                                        </div>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="border-t-2 border-slate-300 bg-gradient-to-r from-slate-100 to-slate-50 font-bold">
                            <td className="py-3 px-4 text-slate-900 text-base">Total</td>
                            <td className="text-right py-3 px-3 text-slate-900">
                              {savedOrders.reduce((sum, o) => sum + o.historicalSalesValues.reduce((s, v) => s + v, 0), 0).toLocaleString()}
                            </td>
                            <td className="text-right py-3 px-3 text-slate-900">
                              {savedOrders.reduce((sum, o) => sum + o.netNeedValues.reduce((s, v) => s + v, 0), 0).toLocaleString()}
                            </td>
                            <td className="text-right py-3 px-3 text-green-700 text-base">
                              {savedOrders.reduce((sum, o) => sum + o.computedOrder.reduce((s, v) => s + v, 0), 0).toLocaleString()}
                            </td>
                            <td className="text-right py-3 px-3 text-slate-900">
                              {savedOrders.reduce((sum, o) => {
                                const netNeed = o.netNeedValues.reduce((s, v) => s + v, 0);
                                const po = o.computedOrder.reduce((s, v) => s + v, 0);
                                return sum + netNeed + po;
                              }, 0).toLocaleString()}
                            </td>
                            <td className="text-right py-3 px-3 text-blue-700">
                              {savedOrders.reduce((sum, o) => sum + (o.whiteWeftPo || 0), 0).toLocaleString()}
                            </td>
                            <td></td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>

                    {/* Success Message */}
                    {appPoCreated.length > 0 && (
                      <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                        <div className="flex items-center gap-3">
                          <Check className="w-5 h-5 text-green-600" />
                          <div className="flex-1">
                            <p className="text-sm font-medium text-green-900">
                              {appPoCreated.length === 1 
                                ? 'APP PO Created Successfully' 
                                : `${appPoCreated.length} APP POs Created Successfully`
                              }
                            </p>
                            {appPoCreated.length === 1 ? (
                              <p className="text-sm text-green-700 mt-1">
                                PO Number: <span className="font-mono font-semibold">{appPoCreated[0].poNo}</span>
                              </p>
                            ) : (
                              <div className="text-sm text-green-700 mt-1 space-y-0.5">
                                {appPoCreated.map((po, idx) => (
                                  <div key={po.poId} className="flex items-center gap-2">
                                    <span className="font-mono text-xs">{po.poNo}</span>
                                    <Button
                                      onClick={() => window.open(`/purchase/app-pos/${po.poId}`, '_blank')}
                                      size="sm"
                                      variant="ghost"
                                      className="h-6 px-2 text-xs text-green-700 hover:text-green-900"
                                    >
                                      View
                                    </Button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          {appPoCreated.length === 1 && (
                            <Button
                              onClick={() => window.open(`/purchase/app-pos/${appPoCreated[0].poId}`, '_blank')}
                              size="sm"
                              className="bg-green-600 hover:bg-green-700 text-white"
                            >
                              View PO
                            </Button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex gap-3 pt-5 border-t-2 border-slate-200">
                      <Button
                        onClick={handleBackToSelection}
                        variant="outline"
                        className="border-2 border-slate-300 hover:border-slate-400 hover:bg-slate-50"
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
                        variant="outline"
                        className="border-2 border-slate-300 hover:border-slate-400 hover:bg-slate-50"
                      >
                        Copy to Clipboard
                      </Button>
                      <Button
                        onClick={handleCreateAppPo}
                        disabled={creatingAppPo || appPoCreated.length > 0}
                        className="flex-1 bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white shadow-md disabled:opacity-50"
                      >
                        {creatingAppPo ? (
                          <>Creating APP PO{savedOrders.filter(o => o.isColorBreakdown).length > 0 ? 's' : ''}...</>
                        ) : appPoCreated.length > 0 ? (
                          <>
                            <Check className="w-4 h-4 mr-2" />
                            {appPoCreated.length === 1 ? 'APP PO Created' : `${appPoCreated.length} APP POs Created`}
                          </>
                        ) : (
                          <>
                            <Package className="w-4 h-4 mr-2" />
                            Create APP PO{savedOrders.filter(o => o.isColorBreakdown).length > 0 ? 's' : ''}
                          </>
                        )}
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

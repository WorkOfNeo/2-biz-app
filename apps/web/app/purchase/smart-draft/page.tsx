'use client';
import React, { useState, useCallback, useMemo, useEffect } from 'react';
import useSWR from 'swr';
import { useRouter } from 'next/navigation';
import { supabase } from '../../../lib/supabaseClient';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs';
import { SearchSelect } from '../../../components/SearchSelect';
import { parseWeights, normalizeWeights, gapFillSizing, simpleSplitBuy } from '../../../lib/purchase/gapFillSizing';

// Types
type Style = {
  id: string;
  style_no: string;
  style_name: string | null;
  supplier: string | null;
  image_url: string | null;
};

type StyleColor = {
  id: string;
  style_id: string;
  color: string;
};

type Selection = {
  style_no: string;
  color: string;
};

type StyleColorSummary = {
  style_no: string;
  color: string;
  style_name: string | null;
  supplier: string | null;
  image_url: string | null;
  sizes: string[];
  stock: number[];
  sold: number[];
  purchase: number[];
  incoming: number[];
  netNeed: number[];
  totalStock: number;
  totalSold: number;
  totalPurchase: number;
  totalIncoming: number;
  totalNetNeed: number;
};

type DraftItem = {
  style_no: string;
  color: string;
  sizes: string[];
  weights: number[];
  targetBuy: number;
  buyBySize: number[];
  summary: StyleColorSummary | null;
};

// Progress Steps Component
function ProgressSteps({ currentStep, steps }: { currentStep: number; steps: string[] }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {steps.map((label, idx) => {
        const stepNum = idx + 1;
        const isActive = stepNum === Math.floor(currentStep);
        const isComplete = stepNum < Math.floor(currentStep);
        
        return (
          <React.Fragment key={idx}>
            <div className="flex items-center gap-2">
              <div className={`
                w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium
                ${isComplete ? 'bg-[#8FA894] text-white' : ''}
                ${isActive ? 'bg-[#B8A8D8] text-white' : ''}
                ${!isComplete && !isActive ? 'bg-slate-100 text-slate-400' : ''}
              `}>
                {isComplete ? '✓' : stepNum}
              </div>
              <span className={`text-sm ${isActive ? 'font-medium text-slate-900' : 'text-slate-500'}`}>
                {label}
              </span>
            </div>
            {idx < steps.length - 1 && (
              <div className={`w-12 h-0.5 ${isComplete ? 'bg-[#8FA894]' : 'bg-slate-200'}`} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// Style Card for selection
function StyleCard({ 
  style, 
  selected, 
  onToggle 
}: { 
  style: Style; 
  selected: boolean; 
  onToggle: () => void;
}) {
  return (
    <div
      onClick={onToggle}
      className={`
        border rounded-lg p-3 cursor-pointer transition-all
        ${selected 
          ? 'border-[#8FA894] bg-[#C5D5CA]/10 ring-1 ring-[#8FA894]' 
          : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
        }
      `}
    >
      <div className="flex items-start gap-3">
        {style.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={style.image_url}
            alt={style.style_name || style.style_no}
            className="h-16 w-16 object-cover rounded border"
          />
        ) : (
          <div className="h-16 w-16 rounded border bg-gray-100 flex items-center justify-center text-xs text-gray-400">
            No image
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{style.style_no}</span>
            {selected && (
              <Badge className="bg-[#8FA894] text-white text-[10px]">Selected</Badge>
            )}
          </div>
          <div className="text-xs text-slate-600 truncate">{style.style_name || '—'}</div>
          {style.supplier && (
            <Badge className="mt-1 bg-[#F5F3F0] text-slate-600 text-[10px]">{style.supplier}</Badge>
          )}
        </div>
      </div>
    </div>
  );
}

// Color Badge for selection
function ColorBadge({
  color,
  selected,
  onToggle,
}: {
  color: StyleColor;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={`
        px-3 py-1.5 rounded-full text-xs font-medium transition-all
        ${selected
          ? 'bg-[#8FA894] text-white'
          : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
        }
      `}
    >
      {color.color}
    </button>
  );
}

// Draft Item Card with pressure calculation
function DraftItemCard({
  item,
  onUpdate,
  onRemove,
}: {
  item: DraftItem;
  onUpdate: (updates: Partial<DraftItem>) => void;
  onRemove: () => void;
}) {
  const [showPressureModal, setShowPressureModal] = useState(false);
  const [showManualModal, setShowManualModal] = useState(false);
  const [weightsInput, setWeightsInput] = useState(item.weights.join(', '));
  const [localTargetBuy, setLocalTargetBuy] = useState(item.targetBuy.toString());
  const [manualBuyInputs, setManualBuyInputs] = useState<string[]>([]);
  
  const summary = item.summary;
  const sizes = item.sizes;
  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
  
  // Compute base (current available) = stock - sold + purchase + incoming
  const base = useMemo(() => {
    if (!summary) return [];
    return sizes.map((_, i) => 
      (summary.stock[i] || 0) - (summary.sold[i] || 0) + 
      (summary.purchase[i] || 0) + (summary.incoming[i] || 0)
    );
  }, [summary, sizes]);
  
  // Calculate sales pressure (based on sold distribution)
  const salesPressure = useMemo(() => {
    if (!summary || summary.totalSold === 0) return sizes.map(() => 0);
    return summary.sold.map(v => (v / summary.totalSold) * 100);
  }, [summary, sizes]);
  
  // Calculate final pressure (after new buy) = (netNeed + newBuy) distribution
  const finalPressure = useMemo(() => {
    const final = sizes.map((_, i) => (base[i] || 0) + (item.buyBySize[i] || 0));
    const totalFinal = sum(final);
    if (totalFinal === 0) return sizes.map(() => 0);
    return final.map(v => (v / totalFinal) * 100);
  }, [base, item.buyBySize, sizes]);
  
  // Handle weight changes
  const handleApplyWeights = () => {
    const parsed = parseWeights(weightsInput);
    
    // Validate length matches sizes
    if (parsed.length !== sizes.length && parsed.length > 0) {
      alert(`Please enter ${sizes.length} weight values (one per size: ${sizes.join(', ')})`);
      return;
    }
    
    // Use parsed weights or default to equal distribution
    const weights = parsed.length === sizes.length ? parsed : sizes.map(() => 1);
    const targetBuy = parseInt(localTargetBuy) || 0;
    
    // Calculate buy by size using gap-fill
    const result = gapFillSizing({ weights, base, targetBuy });
    
    onUpdate({
      weights,
      targetBuy,
      buyBySize: result.buyBySize,
    });
    
    setShowPressureModal(false);
  };
  
  // Handle manual buy input for a specific size
  const handleBuySizeChange = (index: number, value: string) => {
    const newBuyBySize = [...item.buyBySize];
    newBuyBySize[index] = parseInt(value) || 0;
    onUpdate({
      buyBySize: newBuyBySize,
      targetBuy: sum(newBuyBySize),
    });
  };
  
  // Open manual modal and initialize inputs
  const openManualModal = () => {
    setManualBuyInputs(item.buyBySize.length > 0 
      ? item.buyBySize.map(v => v.toString())
      : sizes.map(() => '0')
    );
    setShowManualModal(true);
  };
  
  // Apply manual inputs
  const handleApplyManual = () => {
    const newBuyBySize = manualBuyInputs.map(v => parseInt(v) || 0);
    onUpdate({
      buyBySize: newBuyBySize,
      targetBuy: sum(newBuyBySize),
    });
    setShowManualModal(false);
  };
  
  const normalizedWeights = useMemo(() => {
    if (item.weights.length === 0) return [];
    return normalizeWeights(item.weights).map(w => (w * 100).toFixed(1));
  }, [item.weights]);
  
  const totalBuy = sum(item.buyBySize);
  
  return (
    <Card className="mb-4">
      <CardContent className="p-4">
        <div className="flex gap-4">
          {/* Image */}
          <div className="flex-shrink-0" style={{ maxWidth: '120px' }}>
            {summary?.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={summary.image_url}
                alt={summary.style_name || item.style_no}
                className="w-full h-auto object-cover rounded border"
              />
            ) : (
              <div className="w-28 h-28 rounded border bg-gray-100 flex items-center justify-center text-xs text-gray-400">
                No image
              </div>
            )}
          </div>
          
          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Header */}
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="text-base font-semibold">{item.style_no}</div>
                <div className="text-sm text-slate-600">{summary?.style_name || '—'}</div>
                <div className="text-sm">
                  Color: <span className="font-medium">{item.color}</span>
                </div>
                {summary?.supplier && (
                  <Badge className="mt-1 bg-[#F5F3F0] text-slate-600 text-[10px]">
                    {summary.supplier}
                  </Badge>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={onRemove}
                className="text-red-500 hover:text-red-700 hover:bg-red-50"
              >
                Remove
              </Button>
            </div>
            
            {/* Stock Numbers Strip */}
            {summary && sizes.length > 0 && (
              <div className="overflow-x-auto mb-4">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-slate-50">
                      <th className="p-1.5 text-left font-medium border">Section</th>
                      {sizes.map((size, i) => (
                        <th key={i} className="p-1.5 text-right font-medium border min-w-[40px]">{size}</th>
                      ))}
                      <th className="p-1.5 text-right font-semibold border bg-slate-100">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="p-1.5 border font-medium">Stock</td>
                      {summary.stock.map((v, i) => (
                        <td key={i} className="p-1.5 text-right border">{v}</td>
                      ))}
                      <td className="p-1.5 text-right border font-semibold bg-slate-50">{summary.totalStock}</td>
                    </tr>
                    <tr>
                      <td className="p-1.5 border font-medium text-red-700">Sold</td>
                      {summary.sold.map((v, i) => (
                        <td key={i} className="p-1.5 text-right border text-red-700">-{v}</td>
                      ))}
                      <td className="p-1.5 text-right border font-semibold text-red-700 bg-slate-50">-{summary.totalSold}</td>
                    </tr>
                    {/* Sales Pressure Row */}
                    <tr className="bg-red-50/50">
                      <td className="p-1.5 border font-medium text-red-600 text-[10px]">Sales %</td>
                      {salesPressure.map((v, i) => (
                        <td key={i} className="p-1.5 text-right border text-red-600 text-[10px]">{v.toFixed(1)}%</td>
                      ))}
                      <td className="p-1.5 text-right border font-semibold text-red-600 text-[10px] bg-slate-50">100%</td>
                    </tr>
                    <tr>
                      <td className="p-1.5 border font-medium text-blue-700">Purchase</td>
                      {summary.purchase.map((v, i) => (
                        <td key={i} className="p-1.5 text-right border text-blue-700">{v}</td>
                      ))}
                      <td className="p-1.5 text-right border font-semibold text-blue-700 bg-slate-50">{summary.totalPurchase}</td>
                    </tr>
                    <tr className="bg-amber-50">
                      <td className="p-1.5 border font-medium">Net Need</td>
                      {summary.netNeed.map((v, i) => (
                        <td key={i} className={`p-1.5 text-right border font-medium ${v < 0 ? 'text-red-700' : v > 0 ? 'text-green-700' : ''}`}>
                          {v}
                        </td>
                      ))}
                      <td className={`p-1.5 text-right border font-bold ${summary.totalNetNeed < 0 ? 'text-red-700' : summary.totalNetNeed > 0 ? 'text-green-700' : ''}`}>
                        {summary.totalNetNeed}
                      </td>
                    </tr>
                    {/* Target Weights Row - Show if weights are set */}
                    {item.weights.length === sizes.length && (
                      <tr className="bg-[#B8A8D8]/20">
                        <td className="p-1.5 border font-medium text-[#8B7BB8] text-[10px]">Target %</td>
                        {normalizedWeights.map((w, i) => (
                          <td key={i} className="p-1.5 text-right border text-[#8B7BB8] text-[10px]">{w}%</td>
                        ))}
                        <td className="p-1.5 text-right border font-semibold text-[#8B7BB8] text-[10px] bg-slate-50">100%</td>
                      </tr>
                    )}
                    {/* New Purchase Row - Always show with editable cells */}
                    <tr className="bg-[#C5D5CA]/30">
                      <td className="p-1.5 border font-medium text-[#8FA894]">+ New Buy</td>
                      {sizes.map((_, i) => (
                        <td key={i} className="p-0.5 border">
                          <input
                            type="number"
                            min={0}
                            value={item.buyBySize[i] || 0}
                            onChange={(e) => handleBuySizeChange(i, e.target.value)}
                            className="w-full h-6 text-right text-xs font-medium text-[#8FA894] bg-transparent border-0 focus:ring-1 focus:ring-[#8FA894] rounded px-1"
                          />
                        </td>
                      ))}
                      <td className="p-1.5 text-right border font-bold text-[#8FA894]">{totalBuy}</td>
                    </tr>
                    {/* New Net Need Row - Show total after new buy */}
                    {totalBuy > 0 && (
                      <tr className="bg-[#C5D5CA]/50">
                        <td className="p-1.5 border font-medium text-[#6B8A70]">New Net</td>
                        {sizes.map((_, i) => {
                          const newNet = (summary.netNeed[i] || 0) + (item.buyBySize[i] || 0);
                          return (
                            <td key={i} className={`p-1.5 text-right border font-medium ${newNet < 0 ? 'text-red-700' : newNet > 0 ? 'text-[#6B8A70]' : ''}`}>
                              {newNet}
                            </td>
                          );
                        })}
                        <td className={`p-1.5 text-right border font-bold ${(summary.totalNetNeed + totalBuy) < 0 ? 'text-red-700' : 'text-[#6B8A70]'}`}>
                          {summary.totalNetNeed + totalBuy}
                        </td>
                      </tr>
                    )}
                    {/* Final Pressure Row */}
                    {totalBuy > 0 && (
                      <tr className="bg-[#C5D5CA]/70">
                        <td className="p-1.5 border font-medium text-[#5A7A5F] text-[10px]">Final %</td>
                        {finalPressure.map((v, i) => (
                          <td key={i} className="p-1.5 text-right border text-[#5A7A5F] text-[10px]">{v.toFixed(1)}%</td>
                        ))}
                        <td className="p-1.5 text-right border font-semibold text-[#5A7A5F] text-[10px] bg-slate-50">100%</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
            
            {/* Pressure & Target Controls */}
            <div className="flex items-center gap-3 flex-wrap">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowPressureModal(true)}
                className="border-[#B8A8D8] text-[#B8A8D8] hover:bg-[#B8A8D8]/10"
              >
                {item.weights.length > 0 ? 'Edit' : 'Calculate'} Pressure
              </Button>
              
              <Button
                variant="outline"
                size="sm"
                onClick={openManualModal}
                className="border-slate-400 text-slate-600 hover:bg-slate-100"
              >
                Manual Input
              </Button>
              
              {item.weights.length > 0 && (
                <div className="text-xs text-slate-500">
                  Target weights: {normalizedWeights.map((w, i) => `${sizes[i]}: ${w}%`).join(', ')}
                </div>
              )}
              
              {totalBuy > 0 && (
                <Badge className="bg-[#8FA894] text-white">
                  Total: {totalBuy} units
                </Badge>
              )}
            </div>
          </div>
        </div>
        
        {/* Pressure Modal */}
        {showPressureModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 p-6">
              <h3 className="text-lg font-semibold mb-2">Calculate Sales Pressure</h3>
              <p className="text-sm text-slate-600 mb-4">
                Enter weight values for each size ({sizes.join(', ')}). 
                These will be normalized to percentages and used to distribute your purchase across sizes,
                accounting for current stock levels.
              </p>
              
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1">
                  Weights (comma, space, or tab separated)
                </label>
                <textarea
                  value={weightsInput}
                  onChange={(e) => setWeightsInput(e.target.value)}
                  placeholder={`e.g., 1 2 2 1 or 1, 2, 2, 1 (${sizes.length} values for ${sizes.join(', ')})`}
                  className="w-full border rounded-md p-2 text-sm min-h-[80px]"
                />
              </div>
              
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1">Target Buy Units</label>
                <Input
                  type="number"
                  min={0}
                  value={localTargetBuy}
                  onChange={(e) => setLocalTargetBuy(e.target.value)}
                  placeholder="e.g., 400"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Total units to purchase (will be distributed by weights)
                </p>
              </div>
              
              {/* Preview */}
              {weightsInput && (
                <div className="mb-4 p-3 bg-slate-50 rounded-md">
                  <div className="text-xs font-medium mb-2">Preview</div>
                  {(() => {
                    const parsed = parseWeights(weightsInput);
                    if (parsed.length !== sizes.length) {
                      return (
                        <div className="text-xs text-amber-600">
                          Expected {sizes.length} values, got {parsed.length}
                        </div>
                      );
                    }
                    const normalized = normalizeWeights(parsed);
                    const targetBuy = parseInt(localTargetBuy) || 0;
                    const result = gapFillSizing({ weights: parsed, base, targetBuy });
                    
                    return (
                      <div className="text-xs space-y-1">
                        <div>
                          <span className="text-slate-500">Distribution: </span>
                          {normalized.map((w, i) => `${sizes[i]}: ${(w * 100).toFixed(1)}%`).join(', ')}
                        </div>
                        <div>
                          <span className="text-slate-500">Buy by size: </span>
                          {result.buyBySize.map((v, i) => `${sizes[i]}: ${v}`).join(', ')}
                        </div>
                        <div>
                          <span className="text-slate-500">Total: </span>
                          {sum(result.buyBySize)} units
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
              
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowPressureModal(false)}>
                  Cancel
                </Button>
                <Button onClick={handleApplyWeights} className="bg-[#8FA894] hover:bg-[#8FA894]/90">
                  Apply
                </Button>
              </div>
            </div>
          </div>
        )}
        
        {/* Manual Input Modal */}
        {showManualModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 p-6">
              <h3 className="text-lg font-semibold mb-2">Manual Buy Input</h3>
              <p className="text-sm text-slate-600 mb-4">
                Enter the quantity to purchase for each size.
              </p>
              
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                {sizes.map((size, i) => (
                  <div key={i}>
                    <label className="block text-xs font-medium text-slate-600 mb-1">{size}</label>
                    <Input
                      type="number"
                      min={0}
                      value={manualBuyInputs[i] || '0'}
                      onChange={(e) => {
                        const newInputs = [...manualBuyInputs];
                        newInputs[i] = e.target.value;
                        setManualBuyInputs(newInputs);
                      }}
                      className="h-9"
                    />
                  </div>
                ))}
              </div>
              
              <div className="mb-4 p-3 bg-slate-50 rounded-md">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">Total:</span>
                  <span className="font-semibold">{manualBuyInputs.reduce((a, b) => a + (parseInt(b) || 0), 0)} units</span>
                </div>
              </div>
              
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowManualModal(false)}>
                  Cancel
                </Button>
                <Button onClick={handleApplyManual} className="bg-[#8FA894] hover:bg-[#8FA894]/90">
                  Apply
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Main Page Component
export default function SmartDraftPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  
  // Style selection
  const [styleQuery, setStyleQuery] = useState('');
  const [selectedStyleNos, setSelectedStyleNos] = useState<string[]>([]);
  
  // Color selection
  const [selectedColors, setSelectedColors] = useState<Selection[]>([]);
  
  // Draft items with pressure/buy data
  const [draftItems, setDraftItems] = useState<DraftItem[]>([]);
  
  // Create state
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createResults, setCreateResults] = useState<any>(null);
  const [deadline, setDeadline] = useState('');
  const [notes, setNotes] = useState('');
  
  // Fetch styles
  const { data: stylesData, isLoading: stylesLoading } = useSWR('smart-draft:styles', async () => {
    const { data, error } = await supabase
      .from('styles')
      .select('id, style_no, style_name, supplier, image_url')
      .order('style_no', { ascending: true })
      .limit(10000);
    if (error) throw error;
    return data as Style[];
  });
  
  // Filter styles
  const filteredStyles = useMemo(() => {
    if (!stylesData) return [];
    const q = styleQuery.toLowerCase().trim();
    if (!q) return stylesData.slice(0, 100); // Show first 100 if no query
    return stylesData.filter(s => 
      s.style_no.toLowerCase().includes(q) ||
      (s.style_name || '').toLowerCase().includes(q) ||
      (s.supplier || '').toLowerCase().includes(q)
    ).slice(0, 100);
  }, [stylesData, styleQuery]);
  
  // Fetch colors for selected styles
  const { data: colorsData } = useSWR(
    selectedStyleNos.length > 0 ? ['smart-draft:colors', selectedStyleNos] : null,
    async () => {
      // First get style IDs
      const { data: styles } = await supabase
        .from('styles')
        .select('id, style_no')
        .in('style_no', selectedStyleNos);
      
      if (!styles || styles.length === 0) return [];
      
      const styleIdToNo = new Map(styles.map(s => [s.id, s.style_no]));
      const styleIds = styles.map(s => s.id);
      
      const { data: colors, error } = await supabase
        .from('style_colors')
        .select('id, style_id, color')
        .in('style_id', styleIds)
        .order('color');
      
      if (error) throw error;
      
      return (colors || []).map(c => ({
        ...c,
        style_no: styleIdToNo.get(c.style_id) || '',
      })) as (StyleColor & { style_no: string })[];
    }
  );
  
  // Group colors by style
  const colorsByStyle = useMemo(() => {
    const map = new Map<string, (StyleColor & { style_no: string })[]>();
    for (const c of colorsData || []) {
      const list = map.get(c.style_no) || [];
      list.push(c);
      map.set(c.style_no, list);
    }
    return map;
  }, [colorsData]);
  
  // Fetch summaries for draft items
  const { data: summariesData, mutate: mutateSummaries } = useSWR(
    draftItems.length > 0 ? ['smart-draft:summaries', draftItems.map(d => `${d.style_no}|${d.color}`).join(',')] : null,
    async () => {
      const selections = draftItems.map(d => ({ style_no: d.style_no, color: d.color }));
      const res = await fetch('/api/purchase/smart-draft/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selections }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      return data.summaries as StyleColorSummary[];
    }
  );
  
  // Update draft items with summaries
  useEffect(() => {
    if (!summariesData) return;
    
    setDraftItems(prev => prev.map(item => {
      const summary = summariesData.find(
        s => s.style_no === item.style_no && s.color.toLowerCase() === item.color.toLowerCase()
      );
      if (summary && (!item.summary || item.sizes.length === 0)) {
        return {
          ...item,
          summary,
          sizes: summary.sizes,
        };
      }
      return { ...item, summary: summary || item.summary };
    }));
  }, [summariesData]);
  
  // Style selection handlers
  const toggleStyle = (styleNo: string) => {
    setSelectedStyleNos(prev => 
      prev.includes(styleNo)
        ? prev.filter(s => s !== styleNo)
        : [...prev, styleNo]
    );
  };
  
  // Color selection handlers
  const toggleColor = (styleNo: string, color: string) => {
    const key = `${styleNo}|${color}`.toLowerCase();
    setSelectedColors(prev => {
      const exists = prev.some(s => `${s.style_no}|${s.color}`.toLowerCase() === key);
      if (exists) {
        return prev.filter(s => `${s.style_no}|${s.color}`.toLowerCase() !== key);
      }
      return [...prev, { style_no: styleNo, color }];
    });
  };
  
  const isColorSelected = (styleNo: string, color: string) => {
    const key = `${styleNo}|${color}`.toLowerCase();
    return selectedColors.some(s => `${s.style_no}|${s.color}`.toLowerCase() === key);
  };
  
  // Move to step 3 - initialize draft items from selections
  const initializeDraftItems = () => {
    const items: DraftItem[] = selectedColors.map(sel => ({
      style_no: sel.style_no,
      color: sel.color,
      sizes: [],
      weights: [],
      targetBuy: 0,
      buyBySize: [],
      summary: null,
    }));
    setDraftItems(items);
    setStep(3);
  };
  
  // Update a draft item
  const updateDraftItem = (index: number, updates: Partial<DraftItem>) => {
    setDraftItems(prev => prev.map((item, i) => 
      i === index ? { ...item, ...updates } : item
    ));
  };
  
  // Remove a draft item
  const removeDraftItem = (index: number) => {
    setDraftItems(prev => prev.filter((_, i) => i !== index));
  };
  
  // Calculate totals
  const totals = useMemo(() => {
    let totalUnits = 0;
    const bySupplier = new Map<string, { styles: number; units: number }>();
    
    for (const item of draftItems) {
      const itemTotal = item.buyBySize.reduce((a, b) => a + b, 0);
      totalUnits += itemTotal;
      
      const supplier = item.summary?.supplier || 'Unknown';
      const current = bySupplier.get(supplier) || { styles: 0, units: 0 };
      current.styles += 1;
      current.units += itemTotal;
      bySupplier.set(supplier, current);
    }
    
    return { totalUnits, bySupplier };
  }, [draftItems]);
  
  // Create draft orders
  const handleCreate = async () => {
    const validItems = draftItems.filter(d => d.buyBySize.reduce((a, b) => a + b, 0) > 0);
    
    if (validItems.length === 0) {
      setCreateError('No items with purchase quantities. Please set target buy amounts.');
      return;
    }
    
    setIsCreating(true);
    setCreateError('');
    
    try {
      const items = validItems.map(d => ({
        style_no: d.style_no,
        color: d.color,
        quantities: d.buyBySize,
        total: d.buyBySize.reduce((a, b) => a + b, 0),
        sizes: d.sizes,
        pressure: {
          weights: d.weights,
          normalized: normalizeWeights(d.weights),
        },
        targetBuyUnits: d.targetBuy,
      }));
      
      const res = await fetch('/api/purchase/smart-draft/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, deadline: deadline || null, notes: notes || null }),
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create orders');
      }
      
      setCreateResults(data);
      setStep(4);
    } catch (err: any) {
      setCreateError(err.message);
    } finally {
      setIsCreating(false);
    }
  };
  
  // Get selected styles metadata
  const selectedStyles = useMemo(() => {
    if (!stylesData) return [];
    return stylesData.filter(s => selectedStyleNos.includes(s.style_no));
  }, [stylesData, selectedStyleNos]);
  
  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-slate-900">Smart Draft Orders</h1>
        <p className="text-slate-500 text-sm mt-1">
          Create purchase orders with intelligent size distribution based on sales pressure
        </p>
      </div>
      
      <ProgressSteps
        currentStep={step}
        steps={['Select Styles', 'Select Colors', 'Configure', 'Complete']}
      />
      
      {/* Step 1: Select Styles */}
      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Select Styles</CardTitle>
            <CardDescription>
              Search and select the styles you want to order
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-4">
              <Input
                value={styleQuery}
                onChange={(e) => setStyleQuery(e.target.value)}
                placeholder="Search by style number, name, or supplier..."
                className="max-w-md"
              />
            </div>
            
            {stylesLoading && (
              <div className="text-center py-8 text-slate-500">Loading styles...</div>
            )}
            
            {!stylesLoading && filteredStyles.length === 0 && (
              <div className="text-center py-8 text-slate-500">
                {styleQuery ? 'No styles match your search' : 'No styles found'}
              </div>
            )}
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
              {filteredStyles.map(style => (
                <StyleCard
                  key={style.id}
                  style={style}
                  selected={selectedStyleNos.includes(style.style_no)}
                  onToggle={() => toggleStyle(style.style_no)}
                />
              ))}
            </div>
            
            {selectedStyleNos.length > 0 && (
              <div className="flex items-center justify-between pt-4 border-t">
                <div className="text-sm text-slate-600">
                  {selectedStyleNos.length} style{selectedStyleNos.length !== 1 ? 's' : ''} selected
                </div>
                <Button
                  onClick={() => setStep(2)}
                  className="bg-[#8FA894] hover:bg-[#8FA894]/90"
                >
                  Continue to Colors →
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      
      {/* Step 2: Select Colors */}
      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle>Select Colors</CardTitle>
            <CardDescription>
              Choose which colors to order for each selected style
            </CardDescription>
          </CardHeader>
          <CardContent>
            {selectedStyles.map(style => {
              const colors = colorsByStyle.get(style.style_no) || [];
              
              return (
                <div key={style.style_no} className="mb-6 pb-6 border-b last:border-b-0">
                  <div className="flex items-center gap-3 mb-3">
                    {style.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={style.image_url}
                        alt={style.style_name || style.style_no}
                        className="h-12 w-12 object-cover rounded border"
                      />
                    ) : (
                      <div className="h-12 w-12 rounded border bg-gray-100" />
                    )}
                    <div>
                      <div className="font-semibold">{style.style_no}</div>
                      <div className="text-xs text-slate-600">{style.style_name || '—'}</div>
                    </div>
                  </div>
                  
                  {colors.length === 0 ? (
                    <div className="text-sm text-slate-500">No colors found</div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {colors.map(color => (
                        <ColorBadge
                          key={color.id}
                          color={color}
                          selected={isColorSelected(style.style_no, color.color)}
                          onToggle={() => toggleColor(style.style_no, color.color)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            
            <div className="flex items-center justify-between pt-4 border-t">
              <Button variant="outline" onClick={() => setStep(1)}>
                ← Back
              </Button>
              <div className="flex items-center gap-4">
                <span className="text-sm text-slate-600">
                  {selectedColors.length} color{selectedColors.length !== 1 ? 's' : ''} selected
                </span>
                <Button
                  onClick={initializeDraftItems}
                  disabled={selectedColors.length === 0}
                  className="bg-[#8FA894] hover:bg-[#8FA894]/90"
                >
                  Continue to Configure →
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      
      {/* Step 3: Configure */}
      {step === 3 && (
        <>
          {draftItems.map((item, index) => (
            <DraftItemCard
              key={`${item.style_no}|${item.color}`}
              item={item}
              onUpdate={(updates) => updateDraftItem(index, updates)}
              onRemove={() => removeDraftItem(index)}
            />
          ))}
          
          {draftItems.length === 0 && (
            <Card>
              <CardContent className="py-12 text-center text-slate-500">
                No items to configure. Go back and select some colors.
              </CardContent>
            </Card>
          )}
          
          {draftItems.length > 0 && (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Order Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                  <div className="bg-[#F5F3F0] rounded-md p-4 text-center">
                    <div className="text-2xl font-semibold text-slate-700">{draftItems.length}</div>
                    <div className="text-xs text-slate-500">Style/Colors</div>
                  </div>
                  <div className="bg-[#C5D5CA]/30 rounded-md p-4 text-center">
                    <div className="text-2xl font-semibold text-[#8FA894]">{totals.totalUnits}</div>
                    <div className="text-xs text-slate-500">Total Units</div>
                  </div>
                  <div className="bg-[#B8A8D8]/20 rounded-md p-4 text-center">
                    <div className="text-2xl font-semibold text-[#B8A8D8]">{totals.bySupplier.size}</div>
                    <div className="text-xs text-slate-500">Suppliers</div>
                  </div>
                  <div className="bg-[#D4E4E8]/30 rounded-md p-4 text-center">
                    <div className="text-2xl font-semibold text-slate-600">{totals.bySupplier.size}</div>
                    <div className="text-xs text-slate-500">Draft POs</div>
                  </div>
                </div>
                
                {/* Supplier breakdown */}
                {totals.bySupplier.size > 0 && (
                  <div className="mb-6">
                    <div className="text-sm font-medium mb-2">By Supplier</div>
                    <div className="space-y-2">
                      {Array.from(totals.bySupplier.entries()).map(([supplier, data]) => (
                        <div key={supplier} className="flex items-center justify-between text-sm bg-slate-50 rounded-md px-3 py-2">
                          <span className="font-medium">{supplier}</span>
                          <span className="text-slate-600">{data.styles} item{data.styles !== 1 ? 's' : ''} • {data.units} units</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* Optional fields */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                  <div>
                    <label className="block text-sm font-medium mb-1">Deadline (optional)</label>
                    <Input
                      type="date"
                      value={deadline}
                      onChange={(e) => setDeadline(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Notes (optional)</label>
                    <Input
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Add notes for this order..."
                    />
                  </div>
                </div>
                
                {createError && (
                  <div className="mb-4 bg-red-50 border border-red-200 text-red-700 rounded-md p-3 text-sm">
                    {createError}
                  </div>
                )}
                
                <div className="flex items-center justify-between pt-4 border-t">
                  <Button variant="outline" onClick={() => setStep(2)}>
                    ← Back
                  </Button>
                  <Button
                    onClick={handleCreate}
                    disabled={isCreating || totals.totalUnits === 0}
                    className="bg-[#8FA894] hover:bg-[#8FA894]/90"
                  >
                    {isCreating ? 'Creating...' : `Create ${totals.bySupplier.size} Draft PO${totals.bySupplier.size !== 1 ? 's' : ''}`}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
      
      {/* Step 4: Complete */}
      {step === 4 && createResults && (
        <Card>
          <CardHeader>
            <CardTitle className="text-[#8FA894]">✓ Orders Created</CardTitle>
            <CardDescription>
              Your draft purchase orders have been created successfully
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="bg-green-50 rounded-md p-4 text-center">
                <div className="text-2xl font-semibold text-green-700">{createResults.summary.created}</div>
                <div className="text-xs text-slate-500">POs Created</div>
              </div>
              <div className="bg-slate-50 rounded-md p-4 text-center">
                <div className="text-2xl font-semibold text-slate-700">
                  {createResults.results.reduce((sum: number, r: any) => sum + r.itemCount, 0)}
                </div>
                <div className="text-xs text-slate-500">Style/Colors</div>
              </div>
              <div className="bg-[#C5D5CA]/30 rounded-md p-4 text-center">
                <div className="text-2xl font-semibold text-[#8FA894]">
                  {createResults.results.reduce((sum: number, r: any) => sum + r.totalQty, 0)}
                </div>
                <div className="text-xs text-slate-500">Total Units</div>
              </div>
            </div>
            
            <div className="space-y-3 mb-6">
              {createResults.results.map((result: any, idx: number) => (
                <div
                  key={idx}
                  className={`border rounded-lg p-4 ${
                    result.status === 'created' ? 'border-green-200 bg-green-50/50' : 'border-red-200 bg-red-50/50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold">{result.poNo || 'Error'}</div>
                      <div className="text-sm text-slate-600">{result.supplier}</div>
                      <div className="text-xs text-slate-500">
                        {result.itemCount} item{result.itemCount !== 1 ? 's' : ''} • {result.totalQty} units
                      </div>
                    </div>
                    {result.status === 'created' && result.poId && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => router.push(`/purchase/app-pos/${result.poId}`)}
                      >
                        View Order →
                      </Button>
                    )}
                  </div>
                  {result.error && (
                    <div className="mt-2 text-sm text-red-600">{result.error}</div>
                  )}
                </div>
              ))}
            </div>
            
            <div className="flex items-center justify-between pt-4 border-t">
              <Button variant="outline" onClick={() => router.push('/purchase/app-pos')}>
                View All Orders
              </Button>
              <Button
                onClick={() => {
                  setStep(1);
                  setSelectedStyleNos([]);
                  setSelectedColors([]);
                  setDraftItems([]);
                  setCreateResults(null);
                  setDeadline('');
                  setNotes('');
                }}
                className="bg-[#8FA894] hover:bg-[#8FA894]/90"
              >
                Create More Orders
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}


import React from 'react';
import { Input } from '../../../../components/ui/input';
import { Check } from 'lucide-react';

type SizeLevelData = {
  sold_by_size: Record<string, number>;
  stock_by_size: Record<string, number>;
  po_by_size: Record<string, number>;
  net_need_by_size: Record<string, number>;
  suggested_by_size: Record<string, number>;
};

type Props = {
  sizes: string[];
  data: SizeLevelData;
  editable?: boolean;
  currentBreakdown?: number[];
  onQuantityChange?: (sizeIndex: number, value: number) => void;
  isSkipped?: boolean;
};

export function SizeLevelTable({ 
  sizes, 
  data, 
  editable = false, 
  currentBreakdown,
  onQuantityChange,
  isSkipped = false
}: Props) {
  const formatNumber = (n: number) => n.toLocaleString('da-DK');
  
  // Calculate row totals
  const soldTotal = sizes.reduce((sum, size) => sum + (data.sold_by_size[size] || 0), 0);
  const poTotal = sizes.reduce((sum, size) => sum + (data.po_by_size[size] || 0), 0);
  const stockTotal = sizes.reduce((sum, size) => sum + (data.stock_by_size[size] || 0), 0);
  const netNeedTotal = sizes.reduce((sum, size) => sum + (data.net_need_by_size[size] || 0), 0);
  const suggestedTotal = currentBreakdown 
    ? currentBreakdown.reduce((a, b) => a + b, 0)
    : sizes.reduce((sum, size) => sum + (data.suggested_by_size[size] || 0), 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-slate-100 border-b border-slate-300">
            <th className="px-3 py-2 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">
              Metric
            </th>
            {sizes.map((size) => (
              <th
                key={size}
                className="px-3 py-2 text-center text-xs font-semibold text-slate-600 uppercase tracking-wider border-l border-slate-200"
              >
                {size}
              </th>
            ))}
            <th className="px-3 py-2 text-center text-xs font-semibold text-slate-600 uppercase tracking-wider border-l border-slate-300 bg-slate-200">
              Total
            </th>
          </tr>
        </thead>
        <tbody className="bg-white">
          <tr className="border-b border-slate-200">
            <td className="px-3 py-2 text-xs font-medium text-slate-700 bg-slate-50">
              Sold
            </td>
            {sizes.map((size) => (
              <td
                key={size}
                className="px-3 py-2 text-center text-sm text-slate-900 border-l border-slate-100"
              >
                {formatNumber(data.sold_by_size[size] || 0)}
              </td>
            ))}
            <td className="px-3 py-2 text-center text-sm font-semibold text-slate-900 border-l border-slate-300 bg-slate-50">
              {formatNumber(soldTotal)}
            </td>
          </tr>
          <tr className="border-b border-slate-200">
            <td className="px-3 py-2 text-xs font-medium text-slate-700 bg-slate-50">
              Open POs
            </td>
            {sizes.map((size) => (
              <td
                key={size}
                className="px-3 py-2 text-center text-sm text-slate-900 border-l border-slate-100"
              >
                {formatNumber(data.po_by_size[size] || 0)}
              </td>
            ))}
            <td className="px-3 py-2 text-center text-sm font-semibold text-slate-900 border-l border-slate-300 bg-slate-50">
              {formatNumber(poTotal)}
            </td>
          </tr>
          <tr className="border-b border-slate-200">
            <td className="px-3 py-2 text-xs font-medium text-slate-700 bg-slate-50">
              Stock
            </td>
            {sizes.map((size) => (
              <td
                key={size}
                className="px-3 py-2 text-center text-sm text-slate-900 border-l border-slate-100"
              >
                {formatNumber(data.stock_by_size[size] || 0)}
              </td>
            ))}
            <td className="px-3 py-2 text-center text-sm font-semibold text-slate-900 border-l border-slate-300 bg-slate-50">
              {formatNumber(stockTotal)}
            </td>
          </tr>
          <tr className="border-b border-slate-200 bg-amber-50">
            <td className="px-3 py-2 text-xs font-medium text-slate-700 bg-amber-100">
              Net Need
            </td>
            {sizes.map((size) => (
              <td
                key={size}
                className="px-3 py-2 text-center text-sm font-medium text-amber-900 border-l border-amber-100"
              >
                {formatNumber(data.net_need_by_size[size] || 0)}
              </td>
            ))}
            <td className="px-3 py-2 text-center text-sm font-bold text-amber-900 border-l border-amber-300 bg-amber-100">
              {formatNumber(netNeedTotal)}
            </td>
          </tr>
          <tr className="bg-indigo-50">
            <td className="px-3 py-2 text-xs font-bold text-slate-700 bg-indigo-100 flex items-center gap-2">
              Suggestion
              {editable && (
                <Check className="w-3 h-3 text-indigo-600" />
              )}
            </td>
            {sizes.map((size, sizeIdx) => {
              const value = currentBreakdown ? currentBreakdown[sizeIdx] : (data.suggested_by_size[size] || 0);
              return (
                <td
                  key={size}
                  className="px-2 py-2 text-center border-l border-indigo-100"
                >
                  {editable && onQuantityChange ? (
                    <Input
                      type="number"
                      className="w-16 text-center text-sm h-7 font-bold text-indigo-900 bg-white border-indigo-200 focus:border-indigo-400"
                      value={value}
                      min={0}
                      onChange={(e) => onQuantityChange(sizeIdx, parseInt(e.target.value) || 0)}
                      disabled={isSkipped}
                    />
                  ) : (
                    <span className="text-sm font-bold text-indigo-900">
                      {formatNumber(value)}
                    </span>
                  )}
                </td>
              );
            })}
            <td className="px-3 py-2 text-center text-sm font-bold text-indigo-900 border-l border-indigo-300 bg-indigo-100">
              {formatNumber(suggestedTotal)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

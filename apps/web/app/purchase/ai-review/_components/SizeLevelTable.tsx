import React from 'react';

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
};

export function SizeLevelTable({ sizes, data }: Props) {
  const formatNumber = (n: number) => n.toLocaleString('da-DK');

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
          </tr>
          <tr className="bg-indigo-50">
            <td className="px-3 py-2 text-xs font-bold text-slate-700 bg-indigo-100">
              Suggestion
            </td>
            {sizes.map((size) => (
              <td
                key={size}
                className="px-3 py-2 text-center text-sm font-bold text-indigo-900 border-l border-indigo-100"
              >
                {formatNumber(data.suggested_by_size[size] || 0)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

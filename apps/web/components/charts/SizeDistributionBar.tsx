'use client';

import React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';

type Props = {
  sizes: string[];
  totals: Record<string, number>;
  height?: number;
  showPercentage?: boolean;
};

// Gradient of brand green
const COLORS = [
  '#C5D5CA',
  '#A8C4AF',
  '#9DB8A5',
  '#8FA894',
  '#8CA395',
  '#7B9B85',
  '#6E9078',
  '#6B8E7B',
  '#5C8465',
  '#4A6B52',
];

export function SizeDistributionBar({ sizes, totals, height = 250, showPercentage = false }: Props) {
  const grandTotal = Object.values(totals).reduce((sum, v) => sum + v, 0);
  
  const chartData = sizes.map((size, index) => {
    const value = totals[size] || 0;
    const percentage = grandTotal > 0 ? (value / grandTotal) * 100 : 0;
    return {
      size,
      value,
      percentage: Math.round(percentage * 10) / 10,
      fill: COLORS[index % COLORS.length],
    };
  });

  // Custom tooltip
  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload || !payload.length) return null;
    
    const data = payload[0].payload;
    
    return (
      <div className="bg-white p-3 rounded-lg shadow-lg border border-slate-200 text-sm">
        <p className="font-medium text-slate-900 mb-1">Size {data.size}</p>
        <p className="text-slate-600">{data.value.toLocaleString('da-DK')} units</p>
        <p className="text-slate-500">{data.percentage}% of total</p>
      </div>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
        <XAxis 
          dataKey="size" 
          tick={{ fontSize: 12 }} 
          tickLine={false}
          axisLine={{ stroke: '#e2e8f0' }}
        />
        <YAxis 
          tick={{ fontSize: 11 }} 
          tickLine={false}
          axisLine={{ stroke: '#e2e8f0' }}
          tickFormatter={(value) => showPercentage ? `${value}%` : value.toLocaleString('da-DK')}
        />
        <Tooltip content={<CustomTooltip />} />
        <Bar 
          dataKey={showPercentage ? "percentage" : "value"} 
          radius={[4, 4, 0, 0]}
        >
          {chartData.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={entry.fill} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

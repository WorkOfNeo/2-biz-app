'use client';

import React from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

type DataPoint = {
  date: string;
  total: number;
  byColor?: Record<string, number>;
};

type Props = {
  data: DataPoint[];
  colors: string[];
  maxColors?: number;
  height?: number;
};

// Color palette for stacked areas
const COLOR_PALETTE = [
  '#8FA894',
  '#6B8E7B',
  '#C5D5CA',
  '#4A6B52',
  '#A8C4AF',
  '#7B9B85',
  '#5C8465',
  '#9DB8A5',
  '#8CA395',
  '#6E9078',
  '#94a3b8', // slate for "Other"
];

export function StackedAreaByColor({ data, colors, maxColors = 8, height = 300 }: Props) {
  // Determine which colors to show and aggregate the rest as "Other"
  const topColors = colors.slice(0, maxColors);
  const hasOther = colors.length > maxColors;
  const otherColors = hasOther ? colors.slice(maxColors) : [];

  // Format date for display
  const formatDate = (date: string) => {
    const d = new Date(date);
    return d.toLocaleDateString('da-DK', { day: '2-digit', month: '2-digit' });
  };

  // Transform data
  const chartData = data.map(point => {
    const result: Record<string, any> = {
      date: formatDate(point.date),
    };
    
    // Add top colors
    for (const color of topColors) {
      result[color] = point.byColor?.[color] || 0;
    }
    
    // Aggregate "Other"
    if (hasOther) {
      let otherTotal = 0;
      for (const color of otherColors) {
        otherTotal += point.byColor?.[color] || 0;
      }
      result['Other'] = otherTotal;
    }
    
    return result;
  });

  const displayColors = hasOther ? [...topColors, 'Other'] : topColors;

  // Custom tooltip
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload || !payload.length) return null;
    
    const total = payload.reduce((sum: number, entry: any) => sum + (entry.value || 0), 0);
    
    return (
      <div className="bg-white p-3 rounded-lg shadow-lg border border-slate-200 text-sm max-w-xs">
        <p className="font-medium text-slate-900 mb-2">{label}</p>
        <p className="text-slate-600 mb-2">Total: {total.toLocaleString('da-DK')}</p>
        <div className="space-y-1">
          {payload.reverse().map((entry: any, index: number) => (
            <div key={index} className="flex justify-between gap-4">
              <span style={{ color: entry.color }}>{entry.name}</span>
              <span className="font-medium">{entry.value?.toLocaleString('da-DK')}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis 
          dataKey="date" 
          tick={{ fontSize: 11 }} 
          tickLine={false}
          axisLine={{ stroke: '#e2e8f0' }}
        />
        <YAxis 
          tick={{ fontSize: 11 }} 
          tickLine={false}
          axisLine={{ stroke: '#e2e8f0' }}
          tickFormatter={(value) => value.toLocaleString('da-DK')}
        />
        <Tooltip content={<CustomTooltip />} />
        <Legend />
        {displayColors.map((color, index) => (
          <Area
            key={color}
            type="monotone"
            dataKey={color}
            name={color}
            stackId="1"
            stroke={COLOR_PALETTE[index % COLOR_PALETTE.length]}
            fill={COLOR_PALETTE[index % COLOR_PALETTE.length]}
            fillOpacity={0.6}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

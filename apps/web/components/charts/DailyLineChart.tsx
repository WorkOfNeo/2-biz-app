'use client';

import React from 'react';
import {
  LineChart,
  Line,
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
  colors?: string[];
  showByColor?: boolean;
  height?: number;
};

// Color palette for multiple lines
const COLOR_PALETTE = [
  '#8FA894', // Brand green
  '#6B8E7B',
  '#C5D5CA',
  '#4A6B52',
  '#A8C4AF',
  '#7B9B85',
  '#5C8465',
  '#9DB8A5',
  '#8CA395',
  '#6E9078',
];

export function DailyLineChart({ data, colors = [], showByColor = false, height = 300 }: Props) {
  // Format date for display
  const formatDate = (date: string) => {
    const d = new Date(date);
    return d.toLocaleDateString('da-DK', { day: '2-digit', month: '2-digit' });
  };

  // Custom tooltip
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload || !payload.length) return null;
    
    return (
      <div className="bg-white p-3 rounded-lg shadow-lg border border-slate-200 text-sm">
        <p className="font-medium text-slate-900 mb-1">{label}</p>
        {payload.map((entry: any, index: number) => (
          <p key={index} style={{ color: entry.color }}>
            {entry.name}: {entry.value?.toLocaleString('da-DK')} units
          </p>
        ))}
      </div>
    );
  };

  if (showByColor && colors.length > 0) {
    // Multi-line chart by color
    const chartData = data.map(point => ({
      date: formatDate(point.date),
      ...point.byColor,
    }));

    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
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
          {colors.slice(0, 10).map((color, index) => (
            <Line
              key={color}
              type="monotone"
              dataKey={color}
              name={color}
              stroke={COLOR_PALETTE[index % COLOR_PALETTE.length]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  // Single line chart for total
  const chartData = data.map(point => ({
    date: formatDate(point.date),
    total: point.total,
  }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
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
        <Line
          type="monotone"
          dataKey="total"
          name="Total"
          stroke="#8FA894"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

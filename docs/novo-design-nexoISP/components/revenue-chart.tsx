"use client";

import { useId } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { RevenuePoint } from "@/lib/types";

export function RevenueChart({
  data,
  compact = false,
}: {
  data: RevenuePoint[];
  compact?: boolean;
}) {
  const gradient = useId().replaceAll(":", "");
  return (
    <ChartContainer
      config={{
        current: { label: "Recebido · R$ mil", color: "var(--chart-1)" },
        previous: {
          label: "Período anterior · R$ mil",
          color: "var(--chart-2)",
        },
      }}
      className={compact ? "mini-chart" : "revenue-chart"}
    >
      <AreaChart
        accessibilityLayer
        data={data}
        margin={{ top: 14, right: 12, left: compact ? 0 : -18, bottom: 0 }}
      >
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.18} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.01} />
          </linearGradient>
        </defs>
        {!compact && (
          <>
            <CartesianGrid
              vertical={false}
              strokeDasharray="3 4"
              stroke="var(--border)"
            />
            <XAxis
              dataKey="day"
              axisLine={false}
              tickLine={false}
              interval={3}
              tickMargin={12}
              fontSize={10}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `${v} mil`}
              tickCount={5}
              fontSize={10}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Area
              type="monotone"
              dataKey="previous"
              stroke="var(--color-previous)"
              strokeDasharray="4 4"
              fill="transparent"
              strokeWidth={1.5}
            />
          </>
        )}
        <Area
          type="monotone"
          dataKey="current"
          stroke="var(--color-current)"
          fill={`url(#${gradient})`}
          strokeWidth={compact ? 1.7 : 2.3}
        />
      </AreaChart>
    </ChartContainer>
  );
}

import { useId } from "react";

interface Point {
  value: number;
}

function formatCompact(value: number): string {
  if (!Number.isFinite(value)) {
    return "-";
  }

  const abs = Math.abs(value);
  if (abs >= 1000) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  if (abs >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(3);
}

export function Sparkline({ points }: { points: Point[] }) {
  if (!points.length) {
    return <span className="muted">No data</span>;
  }

  const gradientId = useId().replace(/:/g, "");
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const latest = values[values.length - 1] ?? 0;
  const range = max - min || 1;

  if (points.length === 1) {
    return (
      <div className="sparkline-shell sparkline-single">
        <div className="sparkline-single-dot" />
        <div className="sparkline-single-value">{formatCompact(latest)}</div>
        <div className="sparkline-single-hint">Single sample</div>
      </div>
    );
  }

  const width = 100;
  const height = 56;
  const padX = 4;
  const padTop = 6;
  const padBottom = 8;
  const innerW = width - padX * 2;
  const innerH = height - padTop - padBottom;

  const coords = points.map((point, index) => {
    const x = padX + (index / Math.max(points.length - 1, 1)) * innerW;
    const y = padTop + (1 - (point.value - min) / range) * innerH;
    return { x, y };
  });

  const linePath = coords
    .map((coord, index) => `${index === 0 ? "M" : "L"} ${coord.x.toFixed(2)} ${coord.y.toFixed(2)}`)
    .join(" ");
  const areaPath = `${linePath} L ${(padX + innerW).toFixed(2)} ${(height - padBottom).toFixed(2)} L ${padX.toFixed(2)} ${(height - padBottom).toFixed(2)} Z`;
  const lastCoord = coords[coords.length - 1] ?? { x: width / 2, y: height / 2 };

  return (
    <div className="sparkline-shell">
      <svg viewBox={`0 0 ${width} ${height}`} className="sparkline" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.32" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.03" />
          </linearGradient>
        </defs>
        <line x1={padX} y1={height - padBottom} x2={padX + innerW} y2={height - padBottom} className="sparkline-grid" />
        <line x1={padX} y1={padTop + innerH * 0.5} x2={padX + innerW} y2={padTop + innerH * 0.5} className="sparkline-grid" />
        <line x1={padX} y1={padTop} x2={padX + innerW} y2={padTop} className="sparkline-grid" />
        <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
        <path d={linePath} fill="none" className="sparkline-line" />
        <circle cx={lastCoord.x} cy={lastCoord.y} r="2.2" className="sparkline-dot" />
      </svg>

      <div className="sparkline-meta">
        <span>min {formatCompact(min)}</span>
        <span>max {formatCompact(max)}</span>
        <span>latest {formatCompact(latest)}</span>
      </div>
    </div>
  );
}

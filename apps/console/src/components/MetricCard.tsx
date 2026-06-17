import type { ReactNode } from "react";

export function MetricCard({ title, value, hint }: { title: string; value: ReactNode; hint?: string }) {
  return (
    <article className="metric-card">
      <h4>{title}</h4>
      <div className="metric-value">{value}</div>
      {hint ? <div className="metric-hint">{hint}</div> : null}
    </article>
  );
}

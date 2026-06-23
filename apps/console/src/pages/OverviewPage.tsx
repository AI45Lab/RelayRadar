import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fetchOverview } from "../api";
import { useAsyncData, usePagination } from "../hooks";
import { fmtDateTime, fmtNumber } from "../format";
import { StatusBadge } from "../components/StatusBadge";
import { PaginationControls } from "../components/PaginationControls";

export function OverviewPage() {
  const navigate = useNavigate();
  const { loading, error, data, refresh } = useAsyncData(fetchOverview, [], 15000);
  const [endpointSearch, setEndpointSearch] = useState("");
  const [statusView, setStatusView] = useState<"all" | "attention" | "stable">("all");
  const [sortMode, setSortMode] = useState<"attention" | "requests" | "latency" | "drift" | "shield">("attention");
  const summary = useMemo(() => {
    const rows = data ?? [];
    return {
      endpoints: rows.length,
      attention: rows.filter((item) => item.status !== "Stable").length,
      requests24h: rows.reduce((total, item) => total + item.requestCount24h, 0),
      shieldBlocks24h: rows.reduce((total, item) => total + item.shieldInterceptions24h, 0),
      maxP95: rows.reduce((max, item) => Math.max(max, item.p95LatencyMs ?? 0), 0)
    };
  }, [data]);
  const filteredRows = useMemo(() => {
    const query = endpointSearch.trim().toLowerCase();
    const rows = (data ?? []).filter((item) => {
      if (statusView === "attention" && item.status === "Stable") return false;
      if (statusView === "stable" && item.status !== "Stable") return false;
      if (!query) return true;
      return [item.endpointName, item.endpointId, item.providerTag, item.declaredModel]
        .some((value) => (value ?? "").toLowerCase().includes(query));
    });
    return rows.sort((a, b) => {
      if (sortMode === "requests") return b.requestCount24h - a.requestCount24h;
      if (sortMode === "latency") return b.p95LatencyMs - a.p95LatencyMs;
      if (sortMode === "drift") return b.driftScore - a.driftScore;
      if (sortMode === "shield") return b.shieldInterceptions24h - a.shieldInterceptions24h;
      const aAttention = a.status === "Stable" ? 0 : 1;
      const bAttention = b.status === "Stable" ? 0 : 1;
      return bAttention - aAttention || b.driftScore - a.driftScore || b.p95LatencyMs - a.p95LatencyMs;
    });
  }, [data, endpointSearch, sortMode, statusView]);
  const hasActiveFilters = endpointSearch.trim().length > 0 || statusView !== "all";
  const pagination = usePagination(filteredRows, 10);

  return (
    <section>
      <div className="section-header overview-page-header">
        <div>
          <h2>Endpoint Monitor</h2>
          <p className="muted small">Live routing health, model drift, latency, and Shield activity across the relay fleet.</p>
        </div>
        <div className="row-actions">
          {data && data.length > 0 ? (
            <span className={`overview-health-chip ${summary.attention === 0 ? "stable" : "attention"}`}>
              {summary.attention === 0 ? "Healthy" : `${summary.attention} need review`}
            </span>
          ) : null}
          <button className="btn ghost" onClick={() => void refresh()} disabled={loading}>
            <span className="btn-glyph" aria-hidden="true">↻</span>
            Refresh
          </button>
        </div>
      </div>

      {loading ? <p className="loading-state">Loading route monitor...</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {!loading && !error && data ? (
        data.length === 0 ? (
          <div className="card empty-state">
            <p className="muted">No monitored routes yet.</p>
            <div className="empty-state-actions">
              <Link to="/routes" className="btn">Create Route</Link>
            </div>
          </div>
        ) : (
          <>
            <dl className="overview-metric-row">
              <div>
                <dt>Routes</dt>
                <dd>{summary.endpoints}</dd>
              </div>
              <div>
                <dt>Requests 24h</dt>
                <dd>{fmtNumber(summary.requests24h, 0)}</dd>
              </div>
              <div>
                <dt>Max P95</dt>
                <dd>{fmtNumber(summary.maxP95, 0)} ms</dd>
              </div>
              <div>
                <dt>Shield blocks</dt>
                <dd>{summary.shieldBlocks24h}</dd>
              </div>
            </dl>

            <div className="overview-workspace">
              <div className="overview-workspace-head">
                <div>
                  <h3>Monitored routes</h3>
                  <p className="muted small">Open a route to inspect health, drift, and protection events.</p>
                </div>

                <div className="toolbar-result-count">
                  {filteredRows.length} of {summary.endpoints} shown
                </div>
              </div>

              <div className="resource-toolbar">
                <label className="search-control">
                  <span>Search</span>
                  <input
                    value={endpointSearch}
                    onChange={(event) => setEndpointSearch(event.target.value)}
                    placeholder="Route, provider, or model"
                  />
                </label>
                <div className="segmented-control" aria-label="Route status filter">
                  <button
                    type="button"
                    className={statusView === "all" ? "active" : ""}
                    onClick={() => setStatusView("all")}
                  >
                    All <span>{summary.endpoints}</span>
                  </button>
                  <button
                    type="button"
                    className={statusView === "attention" ? "active" : ""}
                    onClick={() => setStatusView("attention")}
                  >
                    Attention <span>{summary.attention}</span>
                  </button>
                  <button
                    type="button"
                    className={statusView === "stable" ? "active" : ""}
                    onClick={() => setStatusView("stable")}
                  >
                    Stable <span>{summary.endpoints - summary.attention}</span>
                  </button>
                </div>
                <label className="toolbar-select">
                  <span>Sort</span>
                  <select value={sortMode} onChange={(event) => setSortMode(event.target.value as typeof sortMode)}>
                    <option value="attention">Needs attention</option>
                    <option value="requests">Request volume</option>
                    <option value="latency">P95 latency</option>
                    <option value="drift">Drift score</option>
                    <option value="shield">Shield blocks</option>
                  </select>
                </label>
                {hasActiveFilters ? (
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => {
                      setEndpointSearch("");
                      setStatusView("all");
                    }}
                  >
                    Clear
                  </button>
                ) : null}
              </div>

              <div className="table-wrap resource-table">
                <table>
                  <thead>
                    <tr>
                      <th>Route</th>
                      <th>Declared Model</th>
                      <th>Status</th>
                      <th>Req (24h)</th>
                      <th>P50 (ms)</th>
                      <th>P95 (ms)</th>
                      <th>Drift</th>
                      <th>Shield Blocks</th>
                      <th>Last Anomaly</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagination.items.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="table-empty">No routes match the current filters.</td>
                      </tr>
                    ) : (
                      pagination.items.map((item) => {
                        const detailPath = `/monitor/endpoints/${encodeURIComponent(item.endpointId)}`;
                        return (
                          <tr
                            key={item.endpointId}
                            className="clickable-row"
                            role="link"
                            tabIndex={0}
                            aria-label={`Open route ${item.endpointName}`}
                            onClick={() => navigate(detailPath)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                navigate(detailPath);
                              }
                            }}
                          >
                            <td>
                              <Link to={detailPath} className="row-drill-link">
                                {item.endpointName}
                              </Link>
                              <div className="muted small">{item.providerTag}</div>
                            </td>
                            <td>{item.declaredModel}</td>
                            <td><StatusBadge status={item.status} /></td>
                            <td>{item.requestCount24h}</td>
                            <td>{fmtNumber(item.p50LatencyMs, 0)}</td>
                            <td>{fmtNumber(item.p95LatencyMs, 0)}</td>
                            <td>{fmtNumber(item.driftScore, 3)}</td>
                            <td>{item.shieldInterceptions24h}</td>
                            <td>{fmtDateTime(item.lastAnomalyAt)}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
                {filteredRows.length > 0 ? (
                  <PaginationControls
                    page={pagination.page}
                    pageCount={pagination.pageCount}
                    total={pagination.total}
                    startIndex={pagination.startIndex}
                    endIndex={pagination.endIndex}
                    onPageChange={pagination.setPage}
                  />
                ) : null}
              </div>
            </div>
          </>
        )
      ) : null}
    </section>
  );
}

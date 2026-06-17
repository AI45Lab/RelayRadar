import { Link } from "react-router-dom";
import { fetchOverview } from "../api";
import { useAsyncData, usePagination } from "../hooks";
import { fmtDateTime, fmtNumber } from "../format";
import { StatusBadge } from "../components/StatusBadge";
import { PaginationControls } from "../components/PaginationControls";

export function OverviewPage() {
  const { loading, error, data, refresh } = useAsyncData(fetchOverview, [], 15000);
  const pagination = usePagination(data ?? [], 10);

  return (
    <section>
      <div className="section-header">
        <h2>Endpoint Overview</h2>
        <button className="btn" onClick={() => void refresh()} disabled={loading}>Refresh</button>
      </div>

      {loading ? <p>Loading endpoint overview...</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {!loading && !error && data ? (
        data.length === 0 ? (
          <div className="card empty-state">
            <p className="muted">No endpoints configured yet.</p>
          </div>
        ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Endpoint</th>
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
              {pagination.items.map((item) => (
                <tr key={item.endpointId}>
                  <td>
                    <Link to={`/endpoints/${encodeURIComponent(item.endpointId)}`}>{item.endpointName}</Link>
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
              ))}
            </tbody>
          </table>
          <PaginationControls
            page={pagination.page}
            pageCount={pagination.pageCount}
            total={pagination.total}
            startIndex={pagination.startIndex}
            endIndex={pagination.endIndex}
            onPageChange={pagination.setPage}
          />
        </div>
        )
      ) : null}
    </section>
  );
}

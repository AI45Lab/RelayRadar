import type { FingerprintAuditRecord, FingerprintWindowStats } from "@relayradar/shared";
import type { FingerprintApiResponse } from "../api";
import { fmtDateTime, fmtNumber, fmtPercent } from "../format";
import { usePagination } from "../hooks";
import { PaginationControls } from "./PaginationControls";

function conclusionLabel(conclusion: FingerprintAuditRecord["conclusion"]): string {
  switch (conclusion) {
    case "model_match":
      return "Match";
    case "model_mismatch":
      return "Mismatch";
    case "inconclusive":
      return "Inconclusive";
    default:
      return conclusion;
  }
}

function conclusionClass(conclusion: FingerprintAuditRecord["conclusion"]): string {
  switch (conclusion) {
    case "model_match":
      return "conclusion-match";
    case "model_mismatch":
      return "conclusion-mismatch";
    default:
      return "conclusion-inconclusive";
  }
}

function TopList({ title, rows }: { title: string; rows: Array<{ key: string; share: number }> }) {
  if (rows.length === 0) {
    return (
      <div className="fingerprint-mini-block">
        <div className="fingerprint-mini-title">{title}</div>
        <p className="muted small">No samples yet</p>
      </div>
    );
  }

  return (
    <div className="fingerprint-mini-block">
      <div className="fingerprint-mini-title">{title}</div>
      <table className="fingerprint-mini-table">
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="mono fingerprint-key" title={row.key}>
                {row.key}
              </td>
              <td>{fmtPercent(row.share)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WindowColumn({ title, stats }: { title: string; stats: FingerprintWindowStats }) {
  return (
    <div className="fingerprint-window">
      <h4>{title}</h4>
      <p className="muted small">Samples: {stats.sampleSize}</p>
      <dl className="fingerprint-dl">
        <div>
          <dt>Output Length P50</dt>
          <dd>{fmtNumber(stats.outputLengthP50, 0)} chars</dd>
        </div>
        <div>
          <dt>Output Length P95</dt>
          <dd>{fmtNumber(stats.outputLengthP95, 0)} chars</dd>
        </div>
        <div>
          <dt>JSON Valid Rate</dt>
          <dd>{stats.jsonValidRate === null ? "—" : fmtPercent(stats.jsonValidRate)}</dd>
        </div>
        <div>
          <dt>Tool Call Rate</dt>
          <dd>{fmtPercent(stats.toolCallRate)}</dd>
        </div>
        <div>
          <dt>Refusal Rate</dt>
          <dd>{fmtPercent(stats.refusalRate)}</dd>
        </div>
        <div>
          <dt>Streaming Share</dt>
          <dd>{fmtPercent(stats.streamShare)}</dd>
        </div>
        <div>
          <dt>Avg Stream Events / Request</dt>
          <dd>{stats.avgStreamEvents === null ? "—" : fmtNumber(stats.avgStreamEvents, 1)}</dd>
        </div>
        <div>
          <dt>Avg Stream Payload Chars</dt>
          <dd>{stats.avgStreamPayloadChars === null ? "—" : fmtNumber(stats.avgStreamPayloadChars, 0)} chars</dd>
        </div>
      </dl>
      <div className="fingerprint-tops">
        <TopList title="Top Finish Reasons" rows={stats.topFinishReasons} />
        <TopList title="Top Usage Shapes" rows={stats.topUsageShapes} />
        <TopList title="Top Error Fingerprints" rows={stats.topErrorFingerprints} />
        <TopList title="Top Refusal Templates" rows={stats.topRefusalTemplates} />
      </div>
    </div>
  );
}

export interface FingerprintSectionProps {
  loading: boolean;
  error: string | null;
  data: FingerprintApiResponse | null;
  auditBusy: boolean;
  onRefresh: () => void;
  onRunAudit: () => void;
}

export function FingerprintSection({ loading, error, data, auditBusy, onRefresh, onRunAudit }: FingerprintSectionProps) {
  const auditPagination = usePagination(data?.audits ?? [], 5);
  return (
    <article className="card fingerprint-article">
      <div className="section-header fingerprint-header">
        <div>
          <h3>Model Fingerprint</h3>
          <div className="fingerprint-meta">
            <span className="fingerprint-pill">Window {data?.windowHours ?? "—"}h</span>
          </div>
        </div>
        <div className="row-actions">
          <button type="button" className="btn ghost" onClick={() => void onRefresh()} disabled={loading}>
            <span className="btn-glyph" aria-hidden="true">↻</span>
            Refresh
          </button>
          <button type="button" className="btn" onClick={() => onRunAudit()} disabled={auditBusy || loading}>
            {auditBusy ? "Auditing..." : "Run Audit"}
          </button>
        </div>
      </div>

      {loading ? <p className="muted">Loading fingerprint data...</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {data ? (
        <>
          {data.portrait.shiftHints.length > 0 ? (
            <div className="fingerprint-hints">
              <strong>Shift Hints</strong>
              <ul>
                {data.portrait.shiftHints.map((hint) => (
                  <li key={hint}>{hint}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="muted small">No significant shift hints yet (or not enough samples).</p>
          )}

          <div className="grid-2 fingerprint-grid">
            <WindowColumn title={`Recent ${data.windowHours}h`} stats={data.portrait.recent} />
            <WindowColumn title={`Previous ${data.windowHours}h`} stats={data.portrait.previous} />
          </div>

          <div className="table-wrap">
            <h4>Audit History</h4>
            {data.audits.length === 0 ? (
              <p className="muted small">No records yet. It auto-runs on high drift, or run manually.</p>
            ) : (
              <>
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Trigger</th>
                      <th>Conclusion</th>
                      <th>Confidence</th>
                      <th>Compared Baseline</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditPagination.items.map((row) => {
                      const selected = row.evidence?.selectedBaseline as Record<string, unknown> | undefined;
                      const selectedName = typeof selected?.name === "string" ? selected.name : null;
                      const paperTest = row.evidence?.paperLogprobTest as Record<string, unknown> | undefined;
                      const paperBest = paperTest?.bestMatch as Record<string, unknown> | undefined;
                      const paperLabel = typeof paperBest?.label === "string" ? paperBest.label : null;
                      const b3itTest = row.evidence?.b3itTest as Record<string, unknown> | undefined;
                      const b3itBest = b3itTest?.bestMatch as Record<string, unknown> | undefined;
                      const b3itLabel = typeof b3itBest?.label === "string" ? b3itBest.label : null;
                      const comparedBaseline = selectedName ?? paperLabel ?? b3itLabel ?? "—";
                      return (
                      <tr key={row.id}>
                        <td>{fmtDateTime(row.createdAt)}</td>
                        <td className="mono small">{row.trigger}</td>
                        <td><span className={`conclusion-badge ${conclusionClass(row.conclusion)}`}>{conclusionLabel(row.conclusion)}</span></td>
                        <td>{fmtNumber(row.confidence, 2)}</td>
                        <td>{comparedBaseline}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
                <PaginationControls
                  page={auditPagination.page}
                  pageCount={auditPagination.pageCount}
                  total={auditPagination.total}
                  startIndex={auditPagination.startIndex}
                  endIndex={auditPagination.endIndex}
                  onPageChange={auditPagination.setPage}
                />
              </>
            )}
          </div>
        </>
      ) : null}
    </article>
  );
}

import type { SentinelHealthResponse } from "@relayradar/shared";
import { fmtDateTime, fmtPercent } from "../format";
import { StatusBadge } from "./StatusBadge";

interface SentinelSectionProps {
  loading: boolean;
  error: string | null;
  data: SentinelHealthResponse | null;
  runBusy: boolean;
  runFeedback: { text: string; isError: boolean } | null;
  onRefresh: () => void;
  onRun: () => void;
}

function fmtNullablePercent(value: number | null): string {
  return value === null ? "-" : fmtPercent(value);
}

function statusText(status: SentinelHealthResponse["overallStatus"]): string {
  return status === "No Data" ? "No Data" : status;
}

function issueLabel(prompt: SentinelHealthResponse["prompts"][number]): string {
  if (prompt.lastStatus === "failed" || prompt.lastStatus === "http_error" || prompt.lastStatus === "skipped") {
    return "Availability check needs attention";
  }
  if (prompt.lastExpectationPassed === false) {
    return "Output contract check needs attention";
  }
  if ((prompt.lastDivergence ?? 0) >= 0.42) {
    return "Behavior check changed noticeably";
  }
  return "Check needs attention";
}

export function SentinelSection({ loading, error, data, runBusy, runFeedback, onRefresh, onRun }: SentinelSectionProps) {
  const issuePrompts = (data?.prompts ?? []).filter((prompt) => prompt.lastIssue || prompt.consecutiveIssues > 0);
  const visibleIssues = issuePrompts.slice(0, 3);

  return (
    <article className="card sentinel-article">
      <div className="sentinel-header">
        <div>
          <h3>Sentinel</h3>
          <p className="muted small">Endpoint checks focused on availability, performance, output contracts, and behavior.</p>
        </div>
        <div className="row-actions">
          <button type="button" className="btn ghost" onClick={onRefresh} disabled={loading || runBusy}>
            Refresh
          </button>
          <button type="button" className="btn" onClick={onRun} disabled={runBusy || data?.enabled === false}>
            {runBusy ? "Checking..." : "Run Check Now"}
          </button>
        </div>
      </div>

      {loading ? <p className="muted">Loading Sentinel health...</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {runFeedback ? <p className={runFeedback.isError ? "error" : "muted small"}>{runFeedback.text}</p> : null}

      {data ? (
        <>
          <div className="sentinel-summary">
            <div>
              <div className="sentinel-status-line">
                {data.overallStatus === "No Data" ? (
                  <span className="sentinel-no-data">No Data</span>
                ) : (
                  <StatusBadge status={data.overallStatus} />
                )}
                <strong>{data.headline}</strong>
              </div>
              <p className="muted small">{data.recommendedAction}</p>
            </div>
            <dl className="sentinel-facts">
              <div>
                <dt>Last Check</dt>
                <dd>{fmtDateTime(data.lastRunAt)}</dd>
              </div>
              <div>
                <dt>Success 24h</dt>
                <dd>{fmtNullablePercent(data.successRate24h)}</dd>
              </div>
              <div>
                <dt>Runs 24h</dt>
                <dd>{data.runCount24h}</dd>
              </div>
              <div>
                <dt>Probes/day</dt>
                <dd>{data.estimatedProbeCallsPerDay}</dd>
              </div>
            </dl>
          </div>

          <div className="sentinel-dimensions">
            {data.dimensions.map((dimension) => (
              <div key={dimension.key} className="sentinel-dimension">
                <div className="sentinel-dimension-top">
                  <span>{dimension.label}</span>
                  <strong>{statusText(dimension.status)}</strong>
                </div>
                <div className="sentinel-bar">
                  <div className={`sentinel-bar-fill sentinel-bar-${dimension.status.toLowerCase().replace(/\s+/g, "-")}`} style={{ width: `${Math.max(4, dimension.score * 100)}%` }} />
                </div>
                <p>{dimension.summary}</p>
              </div>
            ))}
          </div>

          <div className="sentinel-issues">
            <div className="sentinel-issues-header">
              <h4>Current Attention</h4>
              <span className="muted small">
                {issuePrompts.length === 0 ? "No active issues" : `${issuePrompts.length} check${issuePrompts.length === 1 ? "" : "s"} need review`}
              </span>
            </div>
            {visibleIssues.length > 0 ? (
              <div className="sentinel-issue-list">
                {visibleIssues.map((prompt) => (
                  <div key={prompt.promptId} className="sentinel-issue-item">
                    <div>
                      <strong>{issueLabel(prompt)}</strong>
                      <p className="muted small">
                        {prompt.lastIssue ?? "Recent check changed from the expected pattern."}
                        {prompt.consecutiveIssues > 1 ? ` ${prompt.consecutiveIssues} times in a row.` : ""}
                      </p>
                    </div>
                    <p>{prompt.recommendation}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted small">No immediate action is needed from the latest checks.</p>
            )}
            {issuePrompts.length > visibleIssues.length ? (
              <p className="muted small">Additional check details are kept internal to reduce dashboard noise.</p>
            ) : null}
          </div>
        </>
      ) : null}
    </article>
  );
}

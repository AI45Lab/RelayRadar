import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchEndpointDetail,
  fetchFingerprint,
  fetchFingerprintBaselines,
  fetchPolicy,
  fetchSentinelHealth,
  updatePolicy,
  postEndpointFingerprintBaseline,
  postFingerprintAudit,
  postRunSentinel
} from "../api";
import type { PolicyConfig } from "@relayradar/shared";
import { FingerprintSection } from "../components/FingerprintSection";
import { useAsyncData, usePagination } from "../hooks";
import { fmtDateTime, fmtNumber, fmtPercent } from "../format";
import { MetricCard } from "../components/MetricCard";
import { Sparkline } from "../components/Sparkline";
import { StatusBadge } from "../components/StatusBadge";
import { PaginationControls } from "../components/PaginationControls";
import { SentinelSection } from "../components/SentinelSection";

const EVENT_TYPE_LABELS: Record<string, string> = {
  sentinel_divergence: "Sentinel Drift",
  passive_drift: "Passive Drift",
  enhanced_fingerprint_audit: "Fingerprint Audit",
  request_pii_redacted: "PII Redacted",
  request_secret_redacted: "Secret Redacted",
  prompt_asset_protected: "Prompt Protected",
  canary_injected: "Canary Injected",
  response_high_risk_blocked: "Response Blocked",
  response_high_risk_detected: "High Risk Response",
  protocol_anomaly: "Protocol Anomaly"
};

function humanizeEventType(type: string): string {
  return EVENT_TYPE_LABELS[type] ?? type;
}

export function EndpointDetailPage() {
  const { endpointId = "" } = useParams();
  const detail = useAsyncData(() => fetchEndpointDetail(endpointId), [endpointId], 15000);
  const fingerprint = useAsyncData(() => fetchFingerprint(endpointId), [endpointId], 25000);
  const sentinel = useAsyncData(() => fetchSentinelHealth(endpointId), [endpointId], 15000);
  const baselineCatalog = useAsyncData(fetchFingerprintBaselines, [], 20000);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditFeedback, setAuditFeedback] = useState<{ text: string; isError: boolean } | null>(null);
  const [baselineDraftId, setBaselineDraftId] = useState("");
  const [baselineSaving, setBaselineSaving] = useState(false);
  const [baselineFeedback, setBaselineFeedback] = useState<{ text: string; isError: boolean } | null>(null);
  const [sentinelEnabled, setSentinelEnabled] = useState<boolean | null>(null);
  const [sentinelToggling, setSentinelToggling] = useState(false);
  const [sentinelRunBusy, setSentinelRunBusy] = useState(false);
  const [sentinelRunFeedback, setSentinelRunFeedback] = useState<{ text: string; isError: boolean } | null>(null);
  const [detailView, setDetailView] = useState<"metrics" | "sentinel" | "fingerprint" | "events">("metrics");
  const riskPagination = usePagination(detail.data?.recentAnomalies ?? [], 5);

  useEffect(() => {
    fetchPolicy().then((p) => setSentinelEnabled(p.sentinelEnabled)).catch(() => {});
  }, []);

  async function toggleSentinel(): Promise<void> {
    setSentinelToggling(true);
    try {
      const current = await fetchPolicy();
      const next: PolicyConfig = { ...current, sentinelEnabled: !current.sentinelEnabled };
      const saved = await updatePolicy(next);
      setSentinelEnabled(saved.sentinelEnabled);
      await sentinel.refresh();
    } catch {
      // ignore
    } finally {
      setSentinelToggling(false);
    }
  }

  useEffect(() => {
    if (!detail.data) {
      return;
    }
    const next =
      detail.data.fingerprintBaselineMode === "manual_baseline" && detail.data.fingerprintBaselineId
        ? detail.data.fingerprintBaselineId
        : "";
    setBaselineDraftId(next);
  }, [detail.data]);

  async function runAudit(): Promise<void> {
    setAuditFeedback(null);
    setAuditBusy(true);
    try {
      const res = await postFingerprintAudit(endpointId, { force: true });
      await fingerprint.refresh();
      if (!res.ok) {
        setAuditFeedback({
          text: "Audit did not run (missing API key, upstream unavailable, or still in cooldown).",
          isError: false
        });
      } else if (res.audit) {
        setAuditFeedback({
          text: `Completed: ${res.audit.conclusion} (confidence ${res.audit.confidence})`,
          isError: false
        });
      }
    } catch (err) {
      setAuditFeedback({
        text: err instanceof Error ? err.message : String(err),
        isError: true
      });
    } finally {
      setAuditBusy(false);
    }
  }

  async function runSentinelNow(): Promise<void> {
    setSentinelRunFeedback(null);
    setSentinelRunBusy(true);
    try {
      const res = await postRunSentinel(endpointId);
      await sentinel.refresh();
      await detail.refresh();
      setSentinelRunFeedback({
        text: res.ok ? "Sentinel check completed for this route." : (res.message ?? "Sentinel check did not run."),
        isError: false
      });
    } catch (err) {
      setSentinelRunFeedback({
        text: err instanceof Error ? err.message : String(err),
        isError: true
      });
    } finally {
      setSentinelRunBusy(false);
    }
  }

  async function saveBaselineSelection(): Promise<void> {
    if (!detail.data) {
      return;
    }
    setBaselineFeedback(null);
    setBaselineSaving(true);
    try {
      await postEndpointFingerprintBaseline(endpointId, {
        baselineId: baselineDraftId.trim().length > 0 ? baselineDraftId : null
      });
      await detail.refresh();
      await fingerprint.refresh();
      setBaselineFeedback({
          text:
          baselineDraftId.trim().length > 0
            ? "Baseline selection updated for this route."
            : "Baseline cleared. Audit will use declared-model matching.",
        isError: false
      });
    } catch (err) {
      setBaselineFeedback({
        text: err instanceof Error ? err.message : String(err),
        isError: true
      });
    } finally {
      setBaselineSaving(false);
    }
  }

  return (
    <section>
      <Link to="/" className="back-link" aria-label="Back to monitor">
        <span aria-hidden="true">←</span>
        <span>Monitor</span>
      </Link>

      <div className="section-header">
        <div>
          <h2>{detail.data?.endpointName ?? "Route Detail"}</h2>
          <p className="muted small">Monitored route · <span className="mono">{endpointId}</span></p>
        </div>
        <div className="row-actions">
          {sentinelEnabled !== null ? (
            <button
              type="button"
              className={`btn ghost ${sentinelEnabled ? "sentinel-on" : "sentinel-off"}`}
              onClick={() => void toggleSentinel()}
              disabled={sentinelToggling}
            >
              Global Sentinel: {sentinelEnabled ? "ON" : "OFF"}
            </button>
          ) : null}
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              void detail.refresh();
              void fingerprint.refresh();
              void sentinel.refresh();
            }}
          >
            <span className="btn-glyph" aria-hidden="true">↻</span>
            Refresh
          </button>
        </div>
      </div>

      {detail.loading ? <p className="loading-state">Loading route details...</p> : null}
      {detail.error ? <p className="error">{detail.error}</p> : null}

      {detail.data ? (
        <>
          <article className="card endpoint-hero">
            <div className="endpoint-hero-top">
              <div className="endpoint-hero-title">
                <h3>Route profile</h3>
                <div className="endpoint-hero-url">{detail.data.baseUrl}</div>
              </div>
              <div className="endpoint-hero-status">
                <StatusBadge status={detail.data.status} />
              </div>
            </div>
            <div className="endpoint-hero-divider" />
            <dl className="info-dl">
              <div>
                <dt>Declared Model</dt>
                <dd>{detail.data.declaredModel || "—"}</dd>
              </div>
              <div>
                <dt>Baseline</dt>
                <dd>
                  {detail.data.fingerprintBaselineMode === "manual_baseline"
                    ? (detail.data.fingerprintBaselineName ?? detail.data.fingerprintBaselineId) || "—"
                    : `Declared Model (${detail.data.declaredModel || "—"})`}
                </dd>
              </div>
              <div>
                <dt>Provider</dt>
                <dd>{detail.data.providerTag || "—"}</dd>
              </div>
              <div>
                <dt>First Seen</dt>
                <dd>{fmtDateTime(detail.data.firstSeenAt)}</dd>
              </div>
              <div>
                <dt>Last Seen</dt>
                <dd>{fmtDateTime(detail.data.lastSeenAt)}</dd>
              </div>
            </dl>
            <div className="endpoint-hero-divider" />
            <div className="endpoint-baseline-controls">
              <label htmlFor="endpoint-baseline-select">Comparison Baseline</label>
              <div className="row-actions">
                <select
                  id="endpoint-baseline-select"
                  value={baselineDraftId}
                  onChange={(event) => setBaselineDraftId(event.target.value)}
                  disabled={baselineSaving || baselineCatalog.loading}
                >
                  <option value="">None (Use Declared Model)</option>
                  {(baselineCatalog.data ?? []).map((baseline) => (
                    <option key={baseline.id} value={baseline.id}>
                      {baseline.name} ({baseline.model})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => void saveBaselineSelection()}
                  disabled={baselineSaving}
                >
                  {baselineSaving ? "Saving..." : "Save Baseline"}
                </button>
              </div>
              {baselineFeedback ? (
                <div className={baselineFeedback.isError ? "error" : "muted small"}>{baselineFeedback.text}</div>
              ) : null}
              {baselineCatalog.error ? <div className="error">{baselineCatalog.error}</div> : null}
            </div>
          </article>

          <div className="page-tabs" role="tablist" aria-label="Endpoint detail sections">
            <button type="button" className={detailView === "metrics" ? "active" : ""} onClick={() => setDetailView("metrics")}>Metrics</button>
            <button type="button" className={detailView === "sentinel" ? "active" : ""} onClick={() => setDetailView("sentinel")}>Sentinel</button>
            <button type="button" className={detailView === "fingerprint" ? "active" : ""} onClick={() => setDetailView("fingerprint")}>Fingerprint</button>
            <button type="button" className={detailView === "events" ? "active" : ""} onClick={() => setDetailView("events")}>Events</button>
          </div>

          {detailView === "metrics" ? (
            <div className="detail-panel">
              <div className="metric-grid">
                <MetricCard title="Requests 24h" value={detail.data.requestCount24h} />
                <MetricCard title="Error Rate" value={fmtPercent(detail.data.errorRate24h)} />
                <MetricCard title="Timeout Rate" value={fmtPercent(detail.data.timeoutRate24h)} />
                <MetricCard title="P50 Latency" value={`${fmtNumber(detail.data.p50LatencyMs, 0)} ms`} />
                <MetricCard title="P95 Latency" value={`${fmtNumber(detail.data.p95LatencyMs, 0)} ms`} />
                <MetricCard title="TTFT (avg)" value={`${fmtNumber(detail.data.avgTtftMs, 0)} ms`} />
                <MetricCard title="Tokens/sec" value={fmtNumber(detail.data.avgTokensPerSec, 2)} />
                <MetricCard title="JSON Valid Rate" value={fmtPercent(detail.data.jsonValidRate)} />
                <MetricCard title="Refusal Rate" value={fmtPercent(detail.data.refusalRate)} />
                <MetricCard title="Tool Call Rate" value={fmtPercent(detail.data.toolCallRate)} />
                <MetricCard title="Drift Score" value={fmtNumber(detail.data.driftScore, 3)} />
              </div>

              <div className="grid-2 stretch">
                <article className="card">
                  <h3>Latency Trend (24h)</h3>
                  <Sparkline points={detail.data.latencySeries} />
                </article>
                <article className="card">
                  <h3>Error Trend (24h)</h3>
                  <Sparkline points={detail.data.errorSeries} />
                </article>
                <article className="card">
                  <h3>Drift Timeline</h3>
                  <Sparkline points={detail.data.driftSeries} />
                </article>
                <article className="card">
                  <h3>Fingerprint Timeline</h3>
                  <Sparkline points={
                    (fingerprint.data?.audits ?? [])
                      .slice()
                      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                      .map((a) => ({
                        ts: a.createdAt,
                        value: a.conclusion === "model_match" ? a.confidence : a.conclusion === "model_mismatch" ? -a.confidence : 0
                      }))
                  } />
                </article>
              </div>
            </div>
          ) : null}

          {detailView === "sentinel" ? (
            <SentinelSection
              loading={sentinel.loading}
              error={sentinel.error}
              data={sentinel.data}
              runBusy={sentinelRunBusy}
              runFeedback={sentinelRunFeedback}
              onRefresh={() => void sentinel.refresh()}
              onRun={() => void runSentinelNow()}
            />
          ) : null}

          {detailView === "fingerprint" ? (
            <>
              {auditFeedback ? (
                <p className={auditFeedback.isError ? "error" : "muted"}>{auditFeedback.text}</p>
              ) : null}
              <FingerprintSection
                loading={fingerprint.loading}
                error={fingerprint.error}
                data={fingerprint.data}
                auditBusy={auditBusy}
                onRefresh={() => void fingerprint.refresh()}
                onRunAudit={() => void runAudit()}
              />
            </>
          ) : null}

          {detailView === "events" ? (
            <article className="card table-wrap">
              <div className="card-head">
                <h3>Recent Risk Events</h3>
              </div>
              {detail.data.recentAnomalies.length === 0 ? (
                <div className="empty-state">
                  <p>No risk events recorded yet.</p>
                </div>
              ) : (
                <>
                  <table>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Type</th>
                        <th>Severity</th>
                        <th>Summary</th>
                      </tr>
                    </thead>
                    <tbody>
                      {riskPagination.items.map((event) => (
                        <tr key={event.id}>
                          <td>{fmtDateTime(event.createdAt)}</td>
                          <td>{humanizeEventType(event.type)}</td>
                          <td>{event.severity}</td>
                          <td>{event.summary}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <PaginationControls
                    page={riskPagination.page}
                    pageCount={riskPagination.pageCount}
                    total={riskPagination.total}
                    startIndex={riskPagination.startIndex}
                    endIndex={riskPagination.endIndex}
                    onPageChange={riskPagination.setPage}
                  />
                </>
              )}
            </article>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

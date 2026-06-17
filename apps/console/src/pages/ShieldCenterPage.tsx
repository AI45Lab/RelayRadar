import { useEffect, useMemo, useState, type FormEvent } from "react";
import { fetchPolicy, fetchShieldCenter, updatePolicy } from "../api";
import { MetricCard } from "../components/MetricCard";
import { PaginationControls } from "../components/PaginationControls";
import { fmtDateTime } from "../format";
import { useAsyncData, usePagination } from "../hooks";

function normalizeManualString(value: string): string {
  return value.trim();
}

function dedupeKeepOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeManualString(value);
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parseRegexLiteral(input: string): { source: string; flags: string } | null {
  if (!input.startsWith("/")) {
    return { source: input, flags: "" };
  }

  const lastSlash = input.lastIndexOf("/");
  if (lastSlash <= 0) {
    return null;
  }

  const source = input.slice(1, lastSlash);
  const flags = input.slice(lastSlash + 1);
  if (/[^gimsu]/.test(flags)) {
    return null;
  }
  return { source, flags: flags.replace(/g/g, "") };
}

function validateRegexPattern(value: string): { value: string; error: string | null } {
  const normalized = normalizeManualString(value);
  if (normalized.length === 0) {
    return { value: normalized, error: "Regex pattern cannot be empty." };
  }
  if (normalized.length > 300) {
    return { value: normalized, error: "Regex pattern must be 300 characters or fewer." };
  }

  const parsed = parseRegexLiteral(normalized);
  if (!parsed || parsed.source.length === 0) {
    return { value: normalized, error: "Regex pattern is invalid." };
  }

  try {
    const regex = new RegExp(parsed.source, parsed.flags);
    if (regex.test("")) {
      return { value: normalized, error: "Regex pattern cannot match empty text." };
    }
  } catch {
    return { value: normalized, error: "Regex pattern is invalid." };
  }

  return { value: normalized, error: null };
}

const REDACTION_FIELD_OPTIONS = [
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "id_number", label: "ID Number" },
  { key: "api_key", label: "API Key" },
  { key: "bearer_token", label: "Bearer Token" },
  { key: "token", label: "JWT / Token" },
  { key: "db_uri", label: "Database URI" },
  { key: "private_key", label: "Private Key" }
];

export function ShieldCenterPage() {
  const { loading, error, data, refresh } = useAsyncData(fetchShieldCenter, [], 15000);
  const policy = useAsyncData(fetchPolicy, [], 0);
  const [manualStrings, setManualStrings] = useState<string[]>([]);
  const [manualRegexes, setManualRegexes] = useState<string[]>([]);
  const [draftValue, setDraftValue] = useState("");
  const [regexDraftValue, setRegexDraftValue] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [regexEditingIndex, setRegexEditingIndex] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const [redactionFields, setRedactionFields] = useState<string[]>([]);
  const [blockOnHighRisk, setBlockOnHighRisk] = useState(true);
  const [privacyFilterEnabled, setPrivacyFilterEnabled] = useState(false);
  const [privacyFilterThreshold, setPrivacyFilterThreshold] = useState(0.85);
  const [canaryEnabled, setCanaryEnabled] = useState(false);
  const [minimalExposureEnabled, setMinimalExposureEnabled] = useState(true);
  const [promptPerturbationEnabled, setPromptPerturbationEnabled] = useState(false);

  useEffect(() => {
    if (!policy.data) {
      return;
    }

    setManualStrings(dedupeKeepOrder(policy.data.manualRedactionStrings));
    setManualRegexes(dedupeKeepOrder(policy.data.manualRedactionRegexes ?? []));
    setRedactionFields(policy.data.requiredRedactionFields);
    setBlockOnHighRisk(policy.data.blockOnHighRiskResponse);
    setPrivacyFilterEnabled(policy.data.privacyFilterEnabled ?? false);
    setPrivacyFilterThreshold(policy.data.privacyFilterThreshold ?? 0.85);
    setCanaryEnabled(policy.data.canaryEnabled);
    setMinimalExposureEnabled(policy.data.minimalExposureEnabled);
    setPromptPerturbationEnabled(policy.data.promptPerturbationEnabled);
    setDraftValue("");
    setRegexDraftValue("");
    setEditingIndex(null);
    setRegexEditingIndex(null);
    setDirty(false);
  }, [policy.data]);

  const sortedRows = useMemo(
    () => manualStrings.map((value, index) => ({ index, value })),
    [manualStrings]
  );
  const sortedRegexRows = useMemo(
    () => manualRegexes.map((value, index) => ({ index, value })),
    [manualRegexes]
  );
  const topSensitivePagination = usePagination(data?.summary.topSensitiveTypes ?? [], 5);
  const recentEventsPagination = usePagination(data?.recentEvents ?? [], 5);
  const manualStringsPagination = usePagination(sortedRows, 5);
  const manualRegexesPagination = usePagination(sortedRegexRows, 5);

  function resetDraft(): void {
    setDraftValue("");
    setEditingIndex(null);
  }

  function resetRegexDraft(): void {
    setRegexDraftValue("");
    setRegexEditingIndex(null);
  }

  function startEdit(index: number): void {
    const value = manualStrings[index];
    if (typeof value !== "string") {
      return;
    }
    setEditingIndex(index);
    setDraftValue(value);
    setSaveMessage(null);
  }

  function startEditRegex(index: number): void {
    const value = manualRegexes[index];
    if (typeof value !== "string") {
      return;
    }
    setRegexEditingIndex(index);
    setRegexDraftValue(value);
    setSaveMessage(null);
  }

  function onDelete(index: number): void {
    const value = manualStrings[index];
    if (!value) {
      return;
    }

    if (!window.confirm(`Delete protected string "${value}"?`)) {
      return;
    }

    const next = manualStrings.filter((_, rowIndex) => rowIndex !== index);
    setManualStrings(next);
    setDirty(true);
    if (editingIndex === index) {
      resetDraft();
    }
    setSaveMessage(null);
  }

  function onDeleteRegex(index: number): void {
    const value = manualRegexes[index];
    if (!value) {
      return;
    }

    if (!window.confirm(`Delete protected regex "${value}"?`)) {
      return;
    }

    const next = manualRegexes.filter((_, rowIndex) => rowIndex !== index);
    setManualRegexes(next);
    setDirty(true);
    if (regexEditingIndex === index) {
      resetRegexDraft();
    }
    setSaveMessage(null);
  }

  function onUpsertDraft(event: FormEvent): void {
    event.preventDefault();
    const normalized = normalizeManualString(draftValue);
    if (normalized.length === 0) {
      setSaveMessage({
        text: "Protected string cannot be empty.",
        isError: true
      });
      return;
    }

    const base = [...manualStrings];
    if (editingIndex === null) {
      base.push(normalized);
    } else {
      base[editingIndex] = normalized;
    }

    const next = dedupeKeepOrder(base);
    setManualStrings(next);
    setDirty(true);
    setSaveMessage(null);
    resetDraft();
  }

  function onUpsertRegexDraft(event: FormEvent): void {
    event.preventDefault();
    const validation = validateRegexPattern(regexDraftValue);
    if (validation.error) {
      setSaveMessage({
        text: validation.error,
        isError: true
      });
      return;
    }

    const base = [...manualRegexes];
    if (regexEditingIndex === null) {
      base.push(validation.value);
    } else {
      base[regexEditingIndex] = validation.value;
    }

    const next = dedupeKeepOrder(base);
    setManualRegexes(next);
    setDirty(true);
    setSaveMessage(null);
    resetRegexDraft();
  }

  async function onSaveManualStrings(): Promise<void> {
    if (!policy.data) {
      return;
    }

    setSaving(true);
    setSaveMessage(null);
    try {
      await updatePolicy({
        ...policy.data,
        manualRedactionStrings: manualStrings,
        manualRedactionRegexes: manualRegexes,
        requiredRedactionFields: redactionFields,
        blockOnHighRiskResponse: blockOnHighRisk,
        privacyFilterEnabled,
        privacyFilterThreshold,
        canaryEnabled,
        minimalExposureEnabled,
        promptPerturbationEnabled
      });
      await policy.refresh();
      await refresh();
      setDirty(false);
      setSaveMessage({
        text: "Shield policy saved.",
        isError: false
      });
    } catch (err) {
      setSaveMessage({
        text: err instanceof Error ? err.message : String(err),
        isError: true
      });
    } finally {
      setSaving(false);
    }
  }

  function toggleRedactionField(key: string): void {
    setRedactionFields((current) => {
      const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
      return REDACTION_FIELD_OPTIONS.map((option) => option.key).filter((optionKey) => next.includes(optionKey));
    });
    setDirty(true);
    setSaveMessage(null);
  }

  return (
    <section>
      <div className="section-header">
        <h2>Shield Center</h2>
        <button className="btn" onClick={() => void refresh()} disabled={loading}>Refresh</button>
      </div>

      {loading ? <p>Loading shield metrics...</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {policy.error ? <p className="error">{policy.error}</p> : null}
      {saveMessage ? <p className={saveMessage.isError ? "error" : "muted"}>{saveMessage.text}</p> : null}

      {data ? (
        <>
          <div className="metric-grid">
            <MetricCard title="PII Redactions (24h)" value={data.summary.redactedEntities24h} />
            <MetricCard title="Secrets Redacted (24h)" value={data.summary.redactedSecrets24h} />
            <MetricCard title="Prompt Protection Hits" value={data.summary.promptProtectionHits24h} />
            <MetricCard title="Canary Injected" value={data.summary.canaryInjected24h} />
            <MetricCard title="Blocked Responses" value={data.summary.blockedResponses24h} />
          </div>

          <article className="card shield-policy-card">
            <div className="shield-policy-header">
              <div>
                <h3>Shield Policy</h3>
                <p className="muted small">Controls applied before requests leave the proxy and before responses return to clients.</p>
              </div>
              <button className="btn" onClick={() => void onSaveManualStrings()} disabled={saving || policy.loading || !dirty}>
                {saving ? "Saving..." : "Save Policy"}
              </button>
            </div>
            <div className="shield-policy-grid">
              <div>
                <h4>Redaction Fields</h4>
                <div className="shield-checkbox-grid">
                  {REDACTION_FIELD_OPTIONS.map((option) => (
                    <label key={option.key}>
                      <input
                        type="checkbox"
                        checked={redactionFields.includes(option.key)}
                        onChange={() => toggleRedactionField(option.key)}
                        disabled={saving}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <h4>Response & Exposure Controls</h4>
                <div className="checkbox-row shield-switches">
                  <label>
                    <input
                      type="checkbox"
                      checked={blockOnHighRisk}
                      onChange={(event) => {
                        setBlockOnHighRisk(event.target.checked);
                        setDirty(true);
                      }}
                      disabled={saving}
                    />
                    <span>Block responses that request or leak secrets</span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={privacyFilterEnabled}
                      onChange={(event) => {
                        setPrivacyFilterEnabled(event.target.checked);
                        setDirty(true);
                      }}
                      disabled={saving}
                    />
                    <span>Use privacy-filter model for outbound PII</span>
                  </label>
                  <label>
                    <span>Privacy model threshold</span>
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                      value={privacyFilterThreshold}
                      onChange={(event) => {
                        const next = Number.parseFloat(event.target.value);
                        if (Number.isFinite(next)) {
                          setPrivacyFilterThreshold(Math.min(1, Math.max(0, next)));
                          setDirty(true);
                        }
                      }}
                      disabled={saving || !privacyFilterEnabled}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={minimalExposureEnabled}
                      onChange={(event) => {
                        setMinimalExposureEnabled(event.target.checked);
                        setDirty(true);
                      }}
                      disabled={saving}
                    />
                    <span>Strip sensitive proxy headers before forwarding</span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={promptPerturbationEnabled}
                      onChange={(event) => {
                        setPromptPerturbationEnabled(event.target.checked);
                        setDirty(true);
                      }}
                      disabled={saving}
                    />
                    <span>Add a lightweight request nonce in metadata</span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={canaryEnabled}
                      onChange={(event) => {
                        setCanaryEnabled(event.target.checked);
                        setDirty(true);
                      }}
                      disabled={saving}
                    />
                    <span>Inject canary metadata for relay exposure tracking</span>
                  </label>
                </div>
              </div>
            </div>
          </article>

          <div className="grid-2 stretch shield-table-grid">
            <article className="card table-wrap">
              <div className="card-head"><h3>Top Sensitive Fields</h3></div>
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {topSensitivePagination.items.map((item) => (
                    <tr key={item.type}>
                      <td>{item.type}</td>
                      <td>{item.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <PaginationControls
                page={topSensitivePagination.page}
                pageCount={topSensitivePagination.pageCount}
                total={topSensitivePagination.total}
                startIndex={topSensitivePagination.startIndex}
                endIndex={topSensitivePagination.endIndex}
                onPageChange={topSensitivePagination.setPage}
              />
            </article>

            <article className="card table-wrap">
              <div className="card-head"><h3>Recent Shield Events</h3></div>
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
                  {recentEventsPagination.items.map((event) => (
                    <tr key={event.id}>
                      <td>{fmtDateTime(event.createdAt)}</td>
                      <td>{event.type}</td>
                      <td>{event.severity}</td>
                      <td>{event.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <PaginationControls
                page={recentEventsPagination.page}
                pageCount={recentEventsPagination.pageCount}
                total={recentEventsPagination.total}
                startIndex={recentEventsPagination.startIndex}
                endIndex={recentEventsPagination.endIndex}
                onPageChange={recentEventsPagination.setPage}
              />
            </article>
          </div>
        </>
      ) : null}

      <article className="card flush manual-protected-card">
        <div className="card-head">
          <div>
            <h3>Manual Protected Strings</h3>
            <p className="muted small">Exact-match strings redacted before requests leave the proxy.</p>
          </div>
          <button
            className="btn"
            onClick={() => void onSaveManualStrings()}
            disabled={saving || policy.loading || !dirty}
          >
            {saving ? "Saving..." : "Save Policy"}
          </button>
        </div>

        <form className="inline-form" onSubmit={onUpsertDraft}>
          {editingIndex !== null ? (
            <span className="inline-form-mode">Editing #{editingIndex + 1}</span>
          ) : (
            <span className="inline-form-label">Add String</span>
          )}
          <input
            value={draftValue}
            onChange={(event) => setDraftValue(event.target.value)}
            placeholder="e.g. 11010519491231002X"
            required
          />
          <button type="submit" className="btn" disabled={saving}>
            {editingIndex === null ? "Add" : "Update"}
          </button>
          {editingIndex !== null || draftValue ? (
            <button type="button" className="btn ghost" onClick={resetDraft} disabled={saving}>
              Cancel
            </button>
          ) : null}
        </form>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Value</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {manualStringsPagination.total === 0 ? (
                <tr>
                  <td colSpan={3} className="table-empty">No manual protected strings yet.</td>
                </tr>
              ) : (
                manualStringsPagination.items.map((row) => (
                  <tr key={`${row.index}-${row.value}`}>
                    <td>{row.index + 1}</td>
                    <td className="mono">{row.value}</td>
                    <td>
                      <div className="table-actions">
                        <button type="button" className="btn ghost small" onClick={() => startEdit(row.index)} disabled={saving}>
                          Edit
                        </button>
                        <button type="button" className="btn ghost small danger-text" onClick={() => onDelete(row.index)} disabled={saving}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <PaginationControls
            page={manualStringsPagination.page}
            pageCount={manualStringsPagination.pageCount}
            total={manualStringsPagination.total}
            startIndex={manualStringsPagination.startIndex}
            endIndex={manualStringsPagination.endIndex}
            onPageChange={manualStringsPagination.setPage}
          />
        </div>

        <form className="inline-form regex-form" onSubmit={onUpsertRegexDraft}>
          {regexEditingIndex !== null ? (
            <span className="inline-form-mode">Editing Regex #{regexEditingIndex + 1}</span>
          ) : (
            <span className="inline-form-label">Add Regex</span>
          )}
          <input
            value={regexDraftValue}
            onChange={(event) => setRegexDraftValue(event.target.value)}
            placeholder="e.g. tenant-[a-z0-9]{8} or /ORD-\\d{6,10}/i"
            required
          />
          <button type="submit" className="btn" disabled={saving}>
            {regexEditingIndex === null ? "Add" : "Update"}
          </button>
          {regexEditingIndex !== null || regexDraftValue ? (
            <button type="button" className="btn ghost" onClick={resetRegexDraft} disabled={saving}>
              Cancel
            </button>
          ) : null}
        </form>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Pattern</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {manualRegexesPagination.total === 0 ? (
                <tr>
                  <td colSpan={3} className="table-empty">No manual protected regex patterns yet.</td>
                </tr>
              ) : (
                manualRegexesPagination.items.map((row) => (
                  <tr key={`${row.index}-${row.value}`}>
                    <td>{row.index + 1}</td>
                    <td className="mono">{row.value}</td>
                    <td>
                      <div className="table-actions">
                        <button type="button" className="btn ghost small" onClick={() => startEditRegex(row.index)} disabled={saving}>
                          Edit
                        </button>
                        <button type="button" className="btn ghost small danger-text" onClick={() => onDeleteRegex(row.index)} disabled={saving}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <PaginationControls
            page={manualRegexesPagination.page}
            pageCount={manualRegexesPagination.pageCount}
            total={manualRegexesPagination.total}
            startIndex={manualRegexesPagination.startIndex}
            endIndex={manualRegexesPagination.endIndex}
            onPageChange={manualRegexesPagination.setPage}
          />
        </div>
      </article>
    </section>
  );
}

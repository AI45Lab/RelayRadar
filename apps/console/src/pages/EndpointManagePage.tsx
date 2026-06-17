import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { EndpointUpsertInput } from "@relayradar/shared";
import {
  createEndpoint,
  deleteEndpoint,
  fetchEndpointAdmins,
  fetchFingerprintBaselines,
  postListModels,
  setDefaultEndpoint,
  updateEndpoint,
  type ListedModel
} from "../api";
import { fmtDateTime } from "../format";
import { useAsyncData } from "../hooks";

interface DraftState {
  id: string;
  name: string;
  baseUrl: string;
  declaredModel: string;
  fingerprintBaselineMode: "declared_model" | "manual_baseline";
  fingerprintBaselineId: string;
  providerTag: string;
  apiKey: string;
  apiKeyEnv: string;
  passthroughAuth: boolean;
  enabled: boolean;
  isDefault: boolean;
  clearApiKey: boolean;
}

function defaultDraft(): DraftState {
  return {
    id: "",
    name: "",
    baseUrl: "",
    declaredModel: "",
    fingerprintBaselineMode: "declared_model",
    fingerprintBaselineId: "",
    providerTag: "",
    apiKey: "",
    apiKeyEnv: "",
    passthroughAuth: false,
    enabled: true,
    isDefault: false,
    clearApiKey: false
  };
}

function toPayload(draft: DraftState): EndpointUpsertInput {
  return {
    id: draft.id.trim() || undefined,
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    declaredModel: draft.declaredModel.trim() || undefined,
    fingerprintBaselineMode: draft.fingerprintBaselineMode,
    fingerprintBaselineId:
      draft.fingerprintBaselineMode === "manual_baseline" ? draft.fingerprintBaselineId.trim() || undefined : undefined,
    providerTag: draft.providerTag.trim() || undefined,
    apiKey: draft.apiKey.trim() || undefined,
    apiKeyEnv: draft.apiKeyEnv.trim() || undefined,
    passthroughAuth: draft.passthroughAuth,
    enabled: draft.enabled,
    isDefault: draft.isDefault,
    clearApiKey: draft.clearApiKey
  };
}

export function EndpointManagePage() {
  const { loading, error, data, refresh } = useAsyncData(fetchEndpointAdmins, [], 15000);
  const baselines = useAsyncData(fetchFingerprintBaselines, [], 15000);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState>(defaultDraft());
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ListedModel[]>([]);
  const [modelFetchLoading, setModelFetchLoading] = useState(false);
  const [modelFetchMessage, setModelFetchMessage] = useState<string | null>(null);

  const orderedEndpoints = useMemo(() => data ?? [], [data]);

  const resetModelPicker = () => {
    setModelOptions([]);
    setModelFetchLoading(false);
    setModelFetchMessage(null);
  };

  const startCreate = () => {
    setEditingId(null);
    setDraft(defaultDraft());
    setActionError(null);
    resetModelPicker();
    setFormOpen(true);
  };

  const startEdit = (endpointId: string) => {
    const item = orderedEndpoints.find((entry) => entry.id === endpointId);
    if (!item) return;

    setEditingId(item.id);
    setDraft({
      id: item.id,
      name: item.name,
      baseUrl: item.baseUrl,
      declaredModel: item.declaredModel,
      fingerprintBaselineMode: item.fingerprintBaselineMode,
      fingerprintBaselineId: item.fingerprintBaselineId,
      providerTag: item.providerTag,
      apiKey: "",
      apiKeyEnv: item.apiKeyEnv,
      passthroughAuth: item.passthroughAuth,
      enabled: item.enabled,
      isDefault: item.isDefault,
      clearApiKey: false
    });
    setActionError(null);
    resetModelPicker();
    setFormOpen(true);
  };

  const cancelForm = () => {
    setEditingId(null);
    setDraft(defaultDraft());
    setActionError(null);
    resetModelPicker();
    setFormOpen(false);
  };

  const loadModelOptions = async () => {
    if (!draft.baseUrl.trim()) {
      setModelFetchMessage("Base URL is required before listing models.");
      return;
    }

    setModelFetchLoading(true);
    setModelFetchMessage(null);
    try {
      const result = await postListModels({
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim() || undefined,
        apiKeyEnv: draft.apiKeyEnv.trim() || undefined
      });
      setModelOptions(result.models);
      setModelFetchMessage(
        result.models.length > 0 ? `Loaded ${result.models.length} models from ${result.sourceUrl}.` : "No models returned."
      );
    } catch (err) {
      setModelOptions([]);
      setModelFetchMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setModelFetchLoading(false);
    }
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setActionError(null);

    try {
      const payload = toPayload(draft);
      if (editingId) {
        await updateEndpoint(editingId, payload);
      } else {
        await createEndpoint(payload);
      }
      await refresh();
      cancelForm();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const onSetDefault = async (endpointId: string) => {
    try {
      await setDefaultEndpoint(endpointId);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const onDelete = async (endpointId: string) => {
    if (!window.confirm(`Delete endpoint '${endpointId}'?`)) return;

    try {
      await deleteEndpoint(endpointId);
      await refresh();
      if (editingId === endpointId) {
        cancelForm();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section>
      <div className="section-header">
        <h2>Endpoint Management</h2>
        <div className="row-actions">
          <button className="btn ghost" onClick={startCreate}>+ New Endpoint</button>
          <button className="btn ghost" onClick={() => void refresh()} disabled={loading}>Refresh</button>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {actionError ? <p className="error">{actionError}</p> : null}

      {formOpen ? (
        <article className="card endpoint-form-card">
          <h3>{editingId ? `Edit Endpoint — ${editingId}` : "New Endpoint"}</h3>
          <form className="endpoint-form two-col" onSubmit={onSubmit}>
            <label>
              <span>Name</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                required
                placeholder="Production GPT-4o"
              />
            </label>

            <label>
              <span>ID <span className="muted">(optional on create)</span></span>
              <input
                value={draft.id}
                onChange={(e) => setDraft((prev) => ({ ...prev, id: e.target.value }))}
                disabled={Boolean(editingId)}
                placeholder="auto-generated from name"
              />
            </label>

            <label className="full-span">
              <span>Base URL</span>
              <input
                value={draft.baseUrl}
                onChange={(e) => setDraft((prev) => ({ ...prev, baseUrl: e.target.value }))}
                required
                placeholder="https://api.openai.com/v1"
              />
            </label>

            <label>
              <span>Declared Model</span>
              <div className="model-picker-row">
                <input
                  value={draft.declaredModel}
                  onChange={(e) => setDraft((prev) => ({ ...prev, declaredModel: e.target.value }))}
                  placeholder="gpt-4o"
                />
                <button
                  className="btn ghost small"
                  type="button"
                  onClick={() => void loadModelOptions()}
                  disabled={modelFetchLoading}
                >
                  {modelFetchLoading ? "Loading..." : "List Models"}
                </button>
              </div>
              {modelOptions.length > 0 ? (
                <select
                  value={draft.declaredModel}
                  onChange={(e) => setDraft((prev) => ({ ...prev, declaredModel: e.target.value }))}
                >
                  <option value="">Select a listed model</option>
                  {draft.declaredModel && !modelOptions.some((item) => item.id === draft.declaredModel) ? (
                    <option value={draft.declaredModel}>{draft.declaredModel}</option>
                  ) : null}
                  {modelOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id}
                      {item.ownedBy ? ` · ${item.ownedBy}` : ""}
                    </option>
                  ))}
                </select>
              ) : null}
              {modelFetchMessage ? <span className="small muted">{modelFetchMessage}</span> : null}
            </label>

            <label>
              <span>Provider Tag</span>
              <input
                value={draft.providerTag}
                onChange={(e) => setDraft((prev) => ({ ...prev, providerTag: e.target.value }))}
                placeholder="relay / openai / internal"
              />
            </label>

            <label>
              <span>Fingerprint Baseline Mode</span>
              <select
                value={draft.fingerprintBaselineMode}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    fingerprintBaselineMode: e.target.value as DraftState["fingerprintBaselineMode"]
                  }))
                }
              >
                <option value="declared_model">Use Declared Model</option>
                <option value="manual_baseline">Choose Baseline</option>
              </select>
            </label>

            <label>
              <span>Manual Baseline</span>
              <select
                value={draft.fingerprintBaselineId}
                onChange={(e) => setDraft((prev) => ({ ...prev, fingerprintBaselineId: e.target.value }))}
                disabled={draft.fingerprintBaselineMode !== "manual_baseline"}
                required={draft.fingerprintBaselineMode === "manual_baseline"}
              >
                <option value="">Select a baseline</option>
                {(baselines.data ?? []).map((baseline) => (
                  <option key={baseline.id} value={baseline.id}>
                    {baseline.name} ({baseline.model})
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>API Key <span className="muted">(stored locally)</span></span>
              <input
                type="password"
                value={draft.apiKey}
                onChange={(e) => setDraft((prev) => ({ ...prev, apiKey: e.target.value }))}
                placeholder={editingId ? "Leave empty to keep existing" : "sk-..."}
              />
            </label>

            <label>
              <span>API Key Env <span className="muted">(fallback)</span></span>
              <input
                value={draft.apiKeyEnv}
                onChange={(e) => setDraft((prev) => ({ ...prev, apiKeyEnv: e.target.value }))}
                placeholder="OPENAI_API_KEY"
              />
            </label>

            <div className="checkbox-row full-span">
              <label>
                <input
                  type="checkbox"
                  checked={draft.passthroughAuth}
                  onChange={(e) => setDraft((prev) => ({ ...prev, passthroughAuth: e.target.checked }))}
                />
                <span>Use incoming Authorization first</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft((prev) => ({ ...prev, enabled: e.target.checked }))}
                />
                <span>Enabled</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={draft.isDefault}
                  onChange={(e) => setDraft((prev) => ({ ...prev, isDefault: e.target.checked }))}
                />
                <span>Set as default endpoint</span>
              </label>
              {editingId ? (
                <label>
                  <input
                    type="checkbox"
                    checked={draft.clearApiKey}
                    onChange={(e) => setDraft((prev) => ({ ...prev, clearApiKey: e.target.checked }))}
                  />
                  <span>Clear stored API key</span>
                </label>
              ) : null}
            </div>

            <div className="row-actions full-span align-end">
              <button className="btn ghost" type="button" onClick={cancelForm}>Cancel</button>
              <button className="btn" type="submit" disabled={saving}>
                {saving ? "Saving..." : editingId ? "Update Endpoint" : "Create Endpoint"}
              </button>
            </div>
          </form>
        </article>
      ) : null}

      <article className="card flush">
        {loading && orderedEndpoints.length === 0 ? (
          <div className="empty-state">Loading endpoints...</div>
        ) : orderedEndpoints.length === 0 ? (
          <div className="empty-state">
            <p>No endpoints configured yet.</p>
            <button className="btn" onClick={startCreate}>+ New Endpoint</button>
          </div>
        ) : (
          orderedEndpoints.map((item) => (
            <div key={item.id} className="endpoint-list-item">
              <div className="endpoint-list-main">
                <div className="endpoint-list-name">{item.name}</div>
                <div className="endpoint-list-meta">
                  <span className="mono">{item.id}</span>
                  {item.providerTag ? <span className="ep-tag">{item.providerTag}</span> : null}
                </div>
                <div className="endpoint-list-url" title={item.baseUrl}>{item.baseUrl}</div>
                {item.declaredModel ? (
                  <div className="endpoint-list-meta">
                    <span className="endpoint-list-meta-label">Model</span>
                    <span className="mono">{item.declaredModel}</span>
                  </div>
                ) : null}
                {item.fingerprintBaselineMode === "manual_baseline" ? (
                  <div className="endpoint-list-meta">
                    <span className="endpoint-list-meta-label">Baseline</span>
                    <span>{item.fingerprintBaselineName ?? item.fingerprintBaselineId ?? "—"}</span>
                  </div>
                ) : null}
              </div>

              <div className="endpoint-list-status">
                <div className="endpoint-status-badges">
                  {item.isDefault ? <span className="ep-badge ep-badge-default">Default</span> : null}
                  <span className={`ep-badge ${item.enabled ? "ep-badge-enabled" : "ep-badge-disabled"}`}>
                    {item.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
                <div className="endpoint-list-status-note">
                  {item.lastSeenAt ? (
                    <>
                      <span className="endpoint-list-status-note-label">Last seen</span>
                      {fmtDateTime(item.lastSeenAt)}
                    </>
                  ) : (
                    "Never seen"
                  )}
                </div>
                {item.apiKeyMasked || item.apiKeyEnv ? (
                  <div className="endpoint-list-status-note">
                    {item.apiKeyMasked ? (
                      <>
                        <span className="endpoint-list-status-note-label">Key</span>
                        <span className="mono">{item.apiKeyMasked}</span>
                      </>
                    ) : (
                      <>
                        <span className="endpoint-list-status-note-label">Env</span>
                        <span className="mono">{item.apiKeyEnv}</span>
                      </>
                    )}
                  </div>
                ) : null}
              </div>

              <div className="endpoint-list-actions">
                <Link to={`/endpoints/${encodeURIComponent(item.id)}`} className="btn ghost small">View</Link>
                <button className="btn ghost small" onClick={() => startEdit(item.id)}>Edit</button>
                {!item.isDefault ? (
                  <button className="btn ghost small" onClick={() => void onSetDefault(item.id)}>Set Default</button>
                ) : null}
                <button className="btn ghost small danger-text" onClick={() => void onDelete(item.id)}>Delete</button>
              </div>
            </div>
          ))
        )}
      </article>
    </section>
  );
}

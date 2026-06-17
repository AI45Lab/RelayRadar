import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  createFingerprintModel,
  deleteFingerprintBaseline,
  deleteFingerprintModel,
  fetchFingerprintBaselines,
  fetchFingerprintModels,
  postListModels,
  postFingerprintBaselineRun,
  updateFingerprintModel,
  type ListedModel
} from "../api";
import { fmtDateTime } from "../format";
import { useAsyncData, usePagination } from "../hooks";
import type { FingerprintModelRecord } from "@relayradar/shared";
import { PaginationControls } from "../components/PaginationControls";

interface ModelDraft {
  label: string;
  model: string;
  providerTag: string;
  modelFamily: string;
  notes: string;
}

interface RunSettings {
  baselineName: string;
  baseUrl: string;
  apiKey: string;
  apiKeyEnv: string;
  samplesPerPrompt: number;
}

interface ModelDiscoverySettings {
  baseUrl: string;
  apiKey: string;
  apiKeyEnv: string;
}

function defaultDraft(): ModelDraft {
  return {
    label: "",
    model: "",
    providerTag: "openai",
    modelFamily: "",
    notes: ""
  };
}

function defaultRunSettings(): RunSettings {
  return {
    baselineName: "",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    apiKeyEnv: "OPENAI_API_KEY",
    samplesPerPrompt: 20
  };
}

function defaultModelDiscoverySettings(): ModelDiscoverySettings {
  return {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    apiKeyEnv: "OPENAI_API_KEY"
  };
}

function estimateRunDurationMs(settings: RunSettings): number {
  // B3IT adaptive: Phase 1 (~50 prompts × 3) + Phase 2 (~24 variants × 3) + Phase 3 (8 × samplesPerPrompt)
  const totalCalls = 150 + 72 + 8 * Math.max(settings.samplesPerPrompt, 1);
  return Math.max(20000, Math.min(240000, totalCalls * 200));
}

function inferModelFamily(modelId: string): string {
  return modelId.trim().replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

function inferProviderTag(baseUrl: string, fallback: string): string {
  const normalized = baseUrl.toLowerCase();
  if (normalized.includes("openai")) return "openai";
  if (normalized.includes("anthropic")) return "anthropic";
  if (normalized.includes("openrouter")) return "openrouter";
  return fallback;
}

export function FingerprintCatalogPage() {
  const models = useAsyncData(fetchFingerprintModels, [], 10000);
  const baselines = useAsyncData(fetchFingerprintBaselines, [], 10000);

  const [draft, setDraft] = useState<ModelDraft>({
    label: "GPT-4o",
    model: "gpt-4o",
    providerTag: "openai",
    modelFamily: "gpt-4o",
    notes: "official production baseline"
  });
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [settingsByCardId, setSettingsByCardId] = useState<Record<string, RunSettings>>({});
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [modelDiscovery, setModelDiscovery] = useState<ModelDiscoverySettings>(defaultModelDiscoverySettings());
  const [discoveredModels, setDiscoveredModels] = useState<ListedModel[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryMessage, setDiscoveryMessage] = useState<string | null>(null);

  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Synthesize "virtual" cards for any (model, providerTag) that appears in
  // baselines but has no real model card yet. Lets the Lab page surface
  // baselines created by direct API calls without forcing users to create
  // cards first.
  type DisplayCard = FingerprintModelRecord & { synthetic?: boolean };
  const displayCards = useMemo<DisplayCard[]>(() => {
    const real = models.data ?? [];
    const realKeys = new Set(
      real.map((card) => `${card.providerTag.trim().toLowerCase()}|${card.model.trim().toLowerCase()}`)
    );
    const synthesized = new Map<string, DisplayCard>();
    for (const baseline of baselines.data ?? []) {
      const key = `${baseline.providerTag.trim().toLowerCase()}|${baseline.model.trim().toLowerCase()}`;
      if (realKeys.has(key) || synthesized.has(key)) {
        continue;
      }
      synthesized.set(key, {
        id: `synthetic:${key}`,
        label: baseline.label || baseline.model,
        model: baseline.model,
        providerTag: baseline.providerTag,
        modelFamily: "",
        notes: "",
        createdAt: baseline.createdAt,
        updatedAt: baseline.createdAt,
        synthetic: true
      });
    }
    return [...real, ...synthesized.values()];
  }, [models.data, baselines.data]);

  const selectedCard = useMemo(
    () => displayCards.find((card) => card.id === selectedCardId) ?? null,
    [displayCards, selectedCardId]
  );
  const scopedBaselines = useMemo(() => {
    const all = baselines.data ?? [];
    if (!selectedCard) return all;
    const modelKey = selectedCard.model.trim().toLowerCase();
    const providerKey = selectedCard.providerTag.trim().toLowerCase();
    return all.filter((row) => {
      if (row.model.trim().toLowerCase() !== modelKey) return false;
      if (!providerKey) return true;
      const rowProvider = row.providerTag.trim().toLowerCase();
      return rowProvider.length === 0 || rowProvider === providerKey;
    });
  }, [baselines.data, selectedCard]);
  const modelCardPagination = usePagination(displayCards, 5);
  const baselinePagination = usePagination(scopedBaselines, 5);

  useEffect(() => {
    if (selectedCardId && !displayCards.some((card) => card.id === selectedCardId)) {
      setSelectedCardId(null);
    }
  }, [displayCards, selectedCardId]);

  function getCardSettings(cardId: string): RunSettings {
    return settingsByCardId[cardId] ?? defaultRunSettings();
  }

  function updateCardSettings(cardId: string, updater: (prev: RunSettings) => RunSettings): void {
    setSettingsByCardId((prev) => ({ ...prev, [cardId]: updater(prev[cardId] ?? defaultRunSettings()) }));
  }

  function resetDraft(): void {
    setDraft(defaultDraft());
    setEditingCardId(null);
  }

  function runSettingsFromDiscovery(): RunSettings {
    return {
      ...defaultRunSettings(),
      baseUrl: modelDiscovery.baseUrl.trim() || defaultRunSettings().baseUrl,
      apiKey: modelDiscovery.apiKey.trim(),
      apiKeyEnv: modelDiscovery.apiKeyEnv.trim()
    };
  }

  async function loadDiscoveredModels(): Promise<void> {
    if (!modelDiscovery.baseUrl.trim()) {
      setDiscoveryMessage("Base URL is required before listing models.");
      return;
    }

    setDiscoveryLoading(true);
    setDiscoveryMessage(null);
    try {
      const result = await postListModels({
        baseUrl: modelDiscovery.baseUrl.trim(),
        apiKey: modelDiscovery.apiKey.trim() || undefined,
        apiKeyEnv: modelDiscovery.apiKeyEnv.trim() || undefined
      });
      setDiscoveredModels(result.models);
      setDiscoveryMessage(
        result.models.length > 0 ? `Loaded ${result.models.length} models from ${result.sourceUrl}.` : "No models returned."
      );
    } catch (err) {
      setDiscoveredModels([]);
      setDiscoveryMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscoveryLoading(false);
    }
  }

  function chooseDiscoveredModel(modelId: string): void {
    if (!modelId) {
      return;
    }
    setDraft((prev) => ({
      ...prev,
      model: modelId,
      label: prev.label.trim() ? prev.label : modelId,
      providerTag: prev.providerTag.trim() ? prev.providerTag : inferProviderTag(modelDiscovery.baseUrl, "openai"),
      modelFamily: prev.modelFamily.trim() ? prev.modelFamily : inferModelFamily(modelId)
    }));
  }

  async function upsertCard(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    const label = draft.label.trim();
    const model = draft.model.trim();
    if (!label || !model) {
      setError("Model Label and Model Name are required.");
      return;
    }

    try {
      let saved: FingerprintModelRecord;
      if (editingCardId) {
        saved = await updateFingerprintModel(editingCardId, {
          label,
          model,
          providerTag: draft.providerTag.trim() || undefined,
          modelFamily: draft.modelFamily.trim() || undefined,
          notes: draft.notes.trim() || undefined
        });
        setSuccess(`Updated model card: ${saved.label}`);
      } else {
        saved = await createFingerprintModel({
          label,
          model,
          providerTag: draft.providerTag.trim() || undefined,
          modelFamily: draft.modelFamily.trim() || undefined,
          notes: draft.notes.trim() || undefined
        });
        setSuccess(`Added model card: ${saved.label}`);
      }

      if (!settingsByCardId[saved.id]) {
        setSettingsByCardId((prev) => ({ ...prev, [saved.id]: runSettingsFromDiscovery() }));
      }
      setSelectedCardId(saved.id);
      await models.refresh();
      resetDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function startEditCard(cardId: string): void {
    const row = (models.data ?? []).find((item) => item.id === cardId);
    if (!row) {
      return;
    }
    setEditingCardId(cardId);
    setDraft({
      label: row.label,
      model: row.model,
      providerTag: row.providerTag,
      modelFamily: row.modelFamily,
      notes: row.notes
    });
    setError(null);
    setSuccess(null);
  }

  async function deleteCard(cardId: string): Promise<void> {
    const row = (models.data ?? []).find((item) => item.id === cardId);
    if (!row) {
      return;
    }
    if (!window.confirm(`Delete model card "${row.label}"?`)) {
      return;
    }

    try {
      await deleteFingerprintModel(cardId);
      await models.refresh();
      setSettingsByCardId((prev) => {
        const next = { ...prev };
        delete next[cardId];
        return next;
      });
      if (selectedCardId === cardId) {
        setSelectedCardId(null);
      }
      if (editingCardId === cardId) {
        resetDraft();
      }
      setSuccess("Model card deleted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function promoteSyntheticCard(card: DisplayCard): Promise<void> {
    setError(null);
    setSuccess(null);
    try {
      const saved = await createFingerprintModel({
        label: card.label,
        model: card.model,
        providerTag: card.providerTag || undefined,
        modelFamily: card.modelFamily || inferModelFamily(card.model) || undefined,
        notes: card.notes || undefined
      });
      await models.refresh();
      setSelectedCardId(saved.id);
      setSuccess(`Saved model card: ${saved.label}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runForSelectedCard(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!selectedCard) {
      setError("Select a model card first.");
      return;
    }

    const settings = getCardSettings(selectedCard.id);
    if (!settings.baseUrl.trim()) {
      setError("Base URL is required.");
      return;
    }
    if (!settings.apiKey.trim() && !settings.apiKeyEnv.trim()) {
      setError("Provide either API Key or API Key Env.");
      return;
    }

    setError(null);
    setSuccess(null);
    setBusyCardId(selectedCard.id);
    setProgress(3);
    setProgressLabel("Preparing run...");

    const estimatedMs = estimateRunDurationMs(settings);
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const ratio = Math.min(elapsed / estimatedMs, 1);
      const next = Math.max(3, Math.floor(3 + ratio * 89));
      setProgress((prev) => (next > prev ? next : prev));
      setProgressLabel(next >= 75 ? "Finalizing..." : "Sampling...");
    }, 400);

    try {
      const res = await postFingerprintBaselineRun({
        model: {
          id: selectedCard.id,
          label: selectedCard.label,
          model: selectedCard.model,
          providerTag: selectedCard.providerTag || undefined,
          modelFamily: selectedCard.modelFamily || undefined,
          notes: selectedCard.notes || undefined
        },
        settings: {
          baseUrl: settings.baseUrl.trim(),
          apiKey: settings.apiKey.trim() || undefined,
          apiKeyEnv: settings.apiKeyEnv.trim() || undefined,
          samplesPerPrompt: settings.samplesPerPrompt
        },
        baselineName: settings.baselineName.trim() || undefined
      });

      setProgress(100);
      setProgressLabel("Completed");
      await baselines.refresh();
      if (res.baseline) {
        setSuccess(`Baseline created: ${res.baseline.name}`);
      } else {
        setSuccess("Baseline run completed.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgressLabel("Failed");
    } finally {
      clearInterval(timer);
      setTimeout(() => {
        setBusyCardId((prev) => (prev === selectedCard.id ? null : prev));
        setProgress(0);
        setProgressLabel("");
      }, 800);
    }
  }

  async function removeBaseline(baselineId: string, baselineName: string): Promise<void> {
    if (!window.confirm(`Delete baseline "${baselineName}"?`)) {
      return;
    }
    setError(null);
    try {
      await deleteFingerprintBaseline(baselineId);
      await baselines.refresh();
      setSuccess("Baseline deleted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section>
      <div className="section-header">
        <h2>Fingerprint Lab</h2>
        <Link to="/" className="btn ghost">Overview</Link>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {success ? <p className="feedback-success">{success}</p> : null}

      <div className="fingerprint-lab-layout">

        {/* ── Left sidebar ── */}
        <div className="fingerprint-lab-sidebar">

          {/* Model card list */}
          <article className="card endpoint-form-card">
            <h3>Model Cards</h3>
            {models.loading ? <p className="muted small">Loading...</p> : null}
            {models.error ? <p className="error">{models.error}</p> : null}
            {(models.data ?? []).length === 0 && !models.loading ? (
              <p className="muted small">No model cards yet. Add one below.</p>
            ) : (
              <>
                <div className="model-list">
                  {modelCardPagination.items.map((card) => (
                    <div
                      key={card.id}
                      className={`model-list-item ${selectedCardId === card.id ? "active" : ""} ${card.synthetic ? "synthetic" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedCardId(card.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") setSelectedCardId(card.id);
                      }}
                    >
                      <div className="model-list-item-name">
                        {card.label}
                        {card.synthetic ? <span className="synthetic-tag" title="Derived from an existing baseline — not a saved model card">auto</span> : null}
                      </div>
                      <div className="model-list-item-sub">{card.model}</div>
                      <div className="model-list-item-footer">
                        <span className="small muted">{card.providerTag || "—"}</span>
                        <div className="row-actions">
                          {card.synthetic ? (
                            <button
                              type="button"
                              className="btn ghost small"
                              title="Save as an editable model card"
                              onClick={(event) => { event.stopPropagation(); void promoteSyntheticCard(card); }}
                            >
                              Save Card
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="btn ghost small"
                                onClick={(event) => { event.stopPropagation(); startEditCard(card.id); }}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="btn ghost small danger-text"
                                onClick={(event) => { event.stopPropagation(); void deleteCard(card.id); }}
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {modelCardPagination.pageCount > 1 ? (
                  <PaginationControls
                    page={modelCardPagination.page}
                    pageCount={modelCardPagination.pageCount}
                    total={modelCardPagination.total}
                    startIndex={modelCardPagination.startIndex}
                    endIndex={modelCardPagination.endIndex}
                    onPageChange={modelCardPagination.setPage}
                  />
                ) : null}
              </>
            )}
          </article>

          {/* Add / Edit model form */}
          <article className="card endpoint-form-card">
            <h3>{editingCardId ? "Edit Model" : "Add Model"}</h3>
            <form className="endpoint-form" onSubmit={(event) => void upsertCard(event)}>
              <div className="model-discovery-panel">
                <div className="model-discovery-header">
                  <span>Discover Models</span>
                  <button
                    className="btn ghost small"
                    type="button"
                    onClick={() => void loadDiscoveredModels()}
                    disabled={discoveryLoading}
                  >
                    {discoveryLoading ? "Loading..." : "List Models"}
                  </button>
                </div>
                <label>
                  <span>Base URL</span>
                  <input
                    value={modelDiscovery.baseUrl}
                    onChange={(event) => setModelDiscovery((prev) => ({ ...prev, baseUrl: event.target.value }))}
                    placeholder="https://api.openai.com/v1"
                  />
                </label>
                <label>
                  <span>API Key</span>
                  <input
                    type="password"
                    value={modelDiscovery.apiKey}
                    onChange={(event) => setModelDiscovery((prev) => ({ ...prev, apiKey: event.target.value }))}
                    placeholder="sk-..."
                  />
                </label>
                <label>
                  <span>API Key Env</span>
                  <input
                    value={modelDiscovery.apiKeyEnv}
                    onChange={(event) => setModelDiscovery((prev) => ({ ...prev, apiKeyEnv: event.target.value }))}
                    placeholder="OPENAI_API_KEY"
                  />
                </label>
                {discoveredModels.length > 0 ? (
                  <label>
                    <span>Choose Model</span>
                    <select
                      value={discoveredModels.some((item) => item.id === draft.model) ? draft.model : ""}
                      onChange={(event) => chooseDiscoveredModel(event.target.value)}
                    >
                      <option value="">Select a listed model</option>
                      {discoveredModels.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.id}
                          {item.ownedBy ? ` · ${item.ownedBy}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {discoveryMessage ? <p className="small muted">{discoveryMessage}</p> : null}
              </div>

              <label>
                <span>Label</span>
                <input
                  value={draft.label}
                  onChange={(event) => setDraft((prev) => ({ ...prev, label: event.target.value }))}
                  required
                  placeholder="GPT-4o Production"
                />
              </label>
              <label>
                <span>Model Name</span>
                <input
                  value={draft.model}
                  onChange={(event) => setDraft((prev) => ({ ...prev, model: event.target.value }))}
                  required
                  placeholder="gpt-4o"
                />
              </label>
              <label>
                <span>Provider</span>
                <input
                  value={draft.providerTag}
                  onChange={(event) => setDraft((prev) => ({ ...prev, providerTag: event.target.value }))}
                  placeholder="openai"
                />
              </label>
              <label>
                <span>Model Family</span>
                <input
                  value={draft.modelFamily}
                  onChange={(event) => setDraft((prev) => ({ ...prev, modelFamily: event.target.value }))}
                  placeholder="gpt-4o"
                />
              </label>
              <label>
                <span>Notes</span>
                <input
                  value={draft.notes}
                  onChange={(event) => setDraft((prev) => ({ ...prev, notes: event.target.value }))}
                  placeholder="prod baseline lane"
                />
              </label>
              <div className="row-actions">
                <button className="btn" type="submit">
                  {editingCardId ? "Update" : "Add"}
                </button>
                <button className="btn ghost" type="button" onClick={resetDraft}>
                  {editingCardId ? "Cancel" : "Reset"}
                </button>
              </div>
            </form>
          </article>

        </div>

        {/* ── Right main ── */}
        <div className="fingerprint-lab-main">
          {selectedCard ? (
            /* Run settings */
            <article className="card endpoint-form-card">
              <h3>Run Baseline</h3>
              <p className="run-panel-meta">
                {selectedCard.label} · <span className="mono">{selectedCard.model}</span>
                {selectedCard.providerTag ? ` · ${selectedCard.providerTag}` : ""}
              </p>
              <form className="endpoint-form two-col" onSubmit={(event) => void runForSelectedCard(event)}>
                <label>
                  <span>Baseline Name</span>
                  <input
                    value={getCardSettings(selectedCard.id).baselineName}
                    onChange={(event) =>
                      updateCardSettings(selectedCard.id, (prev) => ({ ...prev, baselineName: event.target.value }))
                    }
                    placeholder={`${selectedCard.label} baseline`}
                  />
                </label>
                <label>
                  <span>Ref. Samples Per Prompt</span>
                  <input
                    type="number"
                    min={8}
                    max={200}
                    value={getCardSettings(selectedCard.id).samplesPerPrompt}
                    onChange={(event) =>
                      updateCardSettings(selectedCard.id, (prev) => ({
                        ...prev,
                        samplesPerPrompt: Number.parseInt(event.target.value, 10) || 1
                      }))
                    }
                  />
                </label>
                <label className="full-span">
                  <span>Base URL</span>
                  <input
                    value={getCardSettings(selectedCard.id).baseUrl}
                    onChange={(event) =>
                      updateCardSettings(selectedCard.id, (prev) => ({ ...prev, baseUrl: event.target.value }))
                    }
                    required
                  />
                </label>
                <label>
                  <span>API Key</span>
                  <input
                    type="password"
                    value={getCardSettings(selectedCard.id).apiKey}
                    onChange={(event) =>
                      updateCardSettings(selectedCard.id, (prev) => ({ ...prev, apiKey: event.target.value }))
                    }
                    placeholder="sk-..."
                  />
                </label>
                <label>
                  <span>API Key Env</span>
                  <input
                    value={getCardSettings(selectedCard.id).apiKeyEnv}
                    onChange={(event) =>
                      updateCardSettings(selectedCard.id, (prev) => ({ ...prev, apiKeyEnv: event.target.value }))
                    }
                    placeholder="OPENAI_API_KEY"
                  />
                </label>
                <div className="row-actions full-span align-end">
                  <button className="btn" type="submit" disabled={busyCardId === selectedCard.id}>
                    {busyCardId === selectedCard.id ? "Running..." : "Run"}
                  </button>
                </div>
              </form>

              {busyCardId === selectedCard.id ? (
                <div className="fingerprint-run-progress">
                  <div className="fingerprint-run-progress-bar">
                    <div className="fingerprint-run-progress-fill" style={{ width: `${progress}%` }} />
                  </div>
                  <div className="small muted fingerprint-run-progress-label">
                    {progressLabel} · {progress}%
                  </div>
                </div>
              ) : null}
            </article>
          ) : null}

          {/* Baseline records — always visible */}
          <article className="card table-wrap">
            <div className="card-head">
              <h3>Baseline Records</h3>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                {selectedCard ? (
                  <>
                    <span className="small muted">Filtered: {selectedCard.label}</span>
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => setSelectedCardId(null)}
                    >
                      Show All
                    </button>
                  </>
                ) : baselines.loading ? (
                  <span className="muted small">Loading...</span>
                ) : null}
              </div>
            </div>
            {baselines.error ? <p className="error">{baselines.error}</p> : null}
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Model</th>
                  <th>Provider</th>
                  <th>Ref. Samples</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {baselinePagination.total === 0 ? (
                  <tr>
                    <td colSpan={6} className="table-empty">
                      {baselines.loading ? "Loading baselines..." : "No baselines yet. Select a model card and run the fingerprint sampler above."}
                    </td>
                  </tr>
                ) : (
                  baselinePagination.items.map((row) => (
                    <tr key={row.id}>
                      <td>{row.name}</td>
                      <td>
                        <div>{row.label}</div>
                        <div className="mono small">{row.model}</div>
                      </td>
                      <td>{row.providerTag || "—"}</td>
                      <td>{row.samplesPerPrompt}</td>
                      <td>{fmtDateTime(row.createdAt)}</td>
                      <td>
                        <div className="table-actions">
                          <button
                            type="button"
                            className="btn ghost danger-text"
                            onClick={() => void removeBaseline(row.id, row.name)}
                          >
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
              page={baselinePagination.page}
              pageCount={baselinePagination.pageCount}
              total={baselinePagination.total}
              startIndex={baselinePagination.startIndex}
              endIndex={baselinePagination.endIndex}
              onPageChange={baselinePagination.setPage}
            />
          </article>

        </div>

      </div>
    </section>
  );
}

<div align="center">

<img src="https://img.shields.io/badge/status-beta-blue" alt="Status: Beta" />
<img src="https://img.shields.io/badge/license-BUSL--1.1-blue" alt="License: BUSL-1.1" />
<img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node >= 22" />
<img src="https://img.shields.io/badge/pnpm-%3E%3D10-orange" alt="pnpm >= 10" />

<img src="./assets/figure1.png" alt="RelayRadar product poster" width="100%" />

### Know what's really behind your API endpoint.

**Detect model swaps · Monitor endpoint drift · Redact sensitive data**

A local transparent proxy that sits between your app and any OpenAI-compatible API,
giving you visibility and local control that are hard to get from hosted relays alone.

[Quick Start](#-quick-start) · [Why This Matters](#-why-this-matters) · [Features](#-features) · [How It Works](#-how-it-works) · [Bundled Fingerprints](#-bundled-fingerprints) · [Configuration](#%EF%B8%8F-configuration) · [API Reference](#-api-reference) · [Citation](#-citation)

---

</div>

## 🔍 Why This Matters

You're paying for a premium model. But is that what you're actually getting?

Third-party API relays are everywhere — they offer cheaper prices, regional availability, and unified billing. But they also create a **trust gap**:

| The Problem | What Actually Happens |
|---|---|
| 🎭 **Model Substitution** | Relay advertises a premium model, silently serves a cheaper or different model |
| 📉 **Silent Degradation** | Endpoint behavior shifts after a model update, routing change, or infrastructure issue — with no notification |
| 🔓 **Data Exposure** | API keys, PII, and proprietary prompts get forwarded verbatim to unknown backends |

**RelayRadar makes the invisible visible.** It's not a testing tool you run once — it's continuous monitoring that catches problems as they happen.

## 🚀 Quick Start

```bash
# Clone and install
git clone https://github.com/AI45Lab/RelayRadar.git
cd RelayRadar && pnpm install

# Start everything
pnpm dev
```

Open **http://localhost:5173** for the Console, then create your endpoint in **Endpoint Manage**.
RelayRadar stores endpoint settings and fingerprint baselines in SQLite (`data/relayradar.sqlite`).

After that, point your SDK at **http://localhost:8080/v1**:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8080/v1", api_key="your-key")
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello"}]
)
# Everything works exactly the same — but now you have visibility.
```

> [!IMPORTANT]
> If your SDK uses a local placeholder key (for example `api_key="your-key"`), you **must** set endpoint `passthroughAuth: false`. Otherwise, that placeholder `Authorization` header will be forwarded upstream instead of the endpoint `apiKey` or `apiKeyEnv`.

## 🖥️ Desktop Beta

Prefer a no-setup local app? The macOS beta packages the RelayRadar Console and local proxy into a single desktop application.

| Platform | Availability |
|---|---|
| macOS Apple Silicon | [![Download beta](https://img.shields.io/badge/Download-beta-2563eb?style=flat-square&logo=apple&logoColor=white)](https://github.com/AI45Lab/RelayRadar/releases/download/v0.1.0-beta.1/RelayRadar-0.1.0-arm64.dmg) |
| macOS Intel | ![Coming soon](https://img.shields.io/badge/Coming-soon-e5e7eb?style=flat-square) |
| Windows | ![Coming soon](https://img.shields.io/badge/Coming-soon-e5e7eb?style=flat-square) |
| Linux | ![Coming soon](https://img.shields.io/badge/Coming-soon-e5e7eb?style=flat-square) |

## ✨ Features

### 🛡️ Shield — Automatic Data Protection

Intercepts every request and response, redacting sensitive data before it leaves your network.

- **Auto-detection**: Emails, phone numbers, ID numbers, API keys (`sk-*`, `ghp_*`), JWTs, database URIs, private keys
- **Reversible redaction**: Replaces sensitive data with opaque `[[RR_...]]` tokens, restores them in responses
- **Custom rules**: Define literal strings to always redact (project names, internal IDs)
- **Prompt protection**: `[[LOCAL_ONLY:...]]` markers strip fragments before upstream forwarding
- **Response blocking**: Optionally block responses flagged as high-risk
- **ML Privacy Filter**: Optionally run [`openai/privacy-filter`](https://huggingface.co/openai/privacy-filter) (ONNX, runs fully locally) on every request to catch PII that pattern rules miss — names, addresses, account numbers, and more. Enabled via `privacyFilterEnabled` in policy; threshold tunable. Falls back to pattern redaction if the model fails.

#### What Gets Redacted

Shield targets **identity-linking** and **credential** data — not functional inputs to your task. The rule of thumb:

| Category | Definition | Examples | Redacted? |
|---|---|---|---|
| **Functional PII** | Data the model needs to complete the task | Height/weight in a BMI calculation, a date range for a trip planner | ✅ No — masking it breaks the task |
| **Incidental PII** | Personal details mentioned in passing that play no role in the computation | "My name is John, my height is 175cm, calculate my BMI" — the name "John" | ✅ Yes — safely removable without affecting the result |
| **Credential PII** | Keys, tokens, secrets | API keys, passwords, JWTs, DB connection strings | 🔴 Always — leaking these is a security incident |

Pattern rules and the ML filter are both calibrated to target Incidental and Credential PII. Functional inputs (numbers, dates, measurements used as task parameters) are passed through unchanged.

### 📡 Sentinel — Continuous Drift Monitoring

Probes every endpoint on a schedule, tracking behavioral stability over time.

- **28 built-in challenge prompts** covering JSON formatting, code generation, multilingual output, constraint following, and more
- **Dice coefficient comparison** between consecutive responses — detects when outputs start changing
- **Designed to reduce false positives on stable endpoints**: Pure text-similarity based, no format-constraint noise
- **Automatic escalation**: Stable → Watch → Drifted → High Risk based on divergence thresholds
- **Toggle from UI**: Enable/disable Sentinel per-policy directly from the Console

### 🧬 Fingerprint Lab — Model Identity Verification

Answers the question: *"Is this endpoint really running the model it claims?"*

- **AB3IT fingerprinting**: Adaptive three-phase discovery — broad scan → variant exploration → reference sampling — selects the most model-discriminative prompts automatically
- **Statistical rigor**: Total Variation Distance + permutation testing for p-values
- **Universal compatibility**: No logprobs required — works with OpenAI-compatible relays and gateways, including reasoning models
- **Baseline catalog**: Ships with 19 bundled AB3IT baselines and lets you build, store, and compare your own
- **Model-identity checks**: Compares live endpoint behavior against a known baseline and reports match, mismatch, or inconclusive evidence

### 📊 Console — Clean Dashboard

A real-time web UI for monitoring and management.

- **Overview**: All endpoints at a glance with status badges, drift scores, request volume
- **Endpoint Detail**: Metric cards, 4-panel sparkline trends (latency, errors, drift, fingerprint), risk event timeline
- **Shield Center**: Redaction stats, policy editor, manual redaction string management
- **Fingerprint Lab**: Model definitions, baseline sampling with progress tracking, audit history

## ⚙️ How It Works

### Architecture

```
┌─────────────┐     ┌──────────────────────────────┐     ┌─────────────────┐
│  Your App   │────▶│     RelayRadar Proxy (:8080)  │────▶│  Upstream API   │
│             │◀────│                                │◀────│  (relay/direct) │
└─────────────┘     │  ┌─────────┐  ┌────────────┐  │     └─────────────────┘
                    │  │ Shield  │  │  Request    │  │
                    │  │ redact  │  │  Logger     │  │
                    │  │ restore │  │  (SQLite)   │  │
                    │  └─────────┘  └────────────┘  │
                    └──────────┬───────────────────┘
                               │
                    ┌──────────┴───────────────────┐
                    │  Background Services          │
                    │  ┌──────────┐ ┌────────────┐  │
                    │  │ Sentinel │ │ Fingerprint │  │
                    │  │ (drift)  │ │ (identity)  │  │
                    │  └──────────┘ └────────────┘  │
                    └──────────────────────────────┘
                               │
                    ┌──────────┴───────────────────┐
                    │  Console UI (:5173)           │
                    │  React + Vite                 │
                    └──────────────────────────────┘
```

### Drift Detection (Sentinel)

Every 30 minutes by default (configurable), Sentinel probes each endpoint:

1. **Send** — Challenge prompt from a pool of 28 probes (JSON, code, bilingual, constraint-following, etc.)
2. **Compare** — Compute Dice coefficient against the previous response signature
3. **Score** — Divergence = 1 − similarity (0 = identical, 1 = completely different)
4. **Escalate** — Record drift events when divergence exceeds thresholds

Drift tracks **change over time** for a single endpoint. It doesn't need a reference — just history.

### Fingerprint Matching — AB3IT

**AB3IT** (Adaptive Border-Based Behavioral Identity Testing) is RelayRadar's model fingerprinting method. Instead of a fixed probe set, it *discovers* the highest-discriminating prompts for each model automatically via three phases:

1. **Phase 1 — Broad Scan**: Probe a pool of 52 candidate prompts (single-token openers, factual completions, code fragments, multilingual triggers, instruction-style) — 3 samples each — and rank them by output entropy
2. **Phase 2 — Variant Exploration**: Generate 3 variants (shortened, instruction-wrapped, reframed) for the top 8 candidates; score each variant the same way
3. **Select**: Combine Phase 1 + Phase 2 results and pick up to 8 prompts with the highest border scores (most diverse outputs)
4. **Phase 3 — Reference Sampling**: Collect 20 samples per selected prompt under `temperature=0` to build the model's token-distribution fingerprint
5. **Compare**: Compute Total Variation Distance between observed and baseline distributions
6. **Test**: Permutation test for statistical significance
7. **Conclude**: `model_match` / `model_mismatch` / `inconclusive` with confidence score

Fingerprint answers **"is this the right model?"** by comparing against a known baseline. It's fully independent from drift and requires no logprob access.

## 🧾 Bundled Fingerprints

RelayRadar includes a built-in fingerprint library for common relay-facing models:

| Model | Developer | Baseline |
|---|---|---|
| `claude-opus-4-8` | Anthropic | Claude Opus 4.8 baseline |
| `claude-opus-4-7` | Anthropic | Claude Opus 4.7 baseline |
| `claude-opus-4-7-thinking` | Anthropic | Claude Opus 4.7 Thinking baseline |
| `claude-opus-4-6` | Anthropic | Claude Opus 4.6 baseline |
| `claude-opus-4-6-thinking` | Anthropic | Claude Opus 4.6 Thinking baseline |
| `claude-sonnet-4-6` | Anthropic | Claude Sonnet 4.6 baseline |
| `claude-sonnet-4-6-thinking` | Anthropic | Claude Sonnet 4.6 Thinking baseline |
| `deepseek-v4-flash` | DeepSeek | DeepSeek V4 Flash baseline |
| `deepseek-v4-pro` | DeepSeek | DeepSeek V4 Pro baseline |
| `gemini-2.5-flash` | Google DeepMind | Gemini 2.5 Flash baseline |
| `gemini-2.5-flash-lite` | Google DeepMind | Gemini 2.5 Flash Lite baseline |
| `gemini-2.5-pro` | Google DeepMind | Gemini 2.5 Pro baseline |
| `gemini-3-flash-preview` | Google DeepMind | Gemini 3 Flash Preview baseline |
| `gemini-3.1-pro-preview` | Google DeepMind | Gemini 3.1 Pro Preview baseline |
| `gemini-3.5-flash` | Google DeepMind | Gemini 3.5 Flash baseline |
| `gpt-5.4` | OpenAI | GPT-5.4 baseline |
| `gpt-5.5` | OpenAI | GPT-5.5 baseline |
| `grok-4.3` | xAI | Grok 4.3 baseline |
| `qwen3.7-max` | Alibaba Cloud | Qwen3.7 Max baseline |

You can use these baselines out of the box, or build your own fingerprints for private models and relay-specific aliases.


## 🛠️ Configuration

### Endpoint Configuration (Stored In SQLite)

```json
{
  "name": "Production Relay",
  "baseUrl": "https://relay.example.com/v1",
  "declaredModel": "gpt-4o",
  "providerTag": "openai",
  "apiKeyEnv": "OPENAI_API_KEY",
  "passthroughAuth": false,
  "enabled": true
}
```

Create/update endpoints via Console UI or `/rr/endpoints` APIs. Endpoint state is persisted in SQLite.

### Policy Configuration (`config/policy.json`)

```json
{
  "requiredRedactionFields": ["email", "phone", "api_key", "token", "id_number"],
  "manualRedactionStrings": [],
  "blockOnHighRiskResponse": true,
  "privacyFilterEnabled": false,
  "privacyFilterThreshold": 0.85,
  "sentinelEnabled": true,
  "sentinelIntervalMinutes": 30,
  "sentinelPromptsPerCycle": 3,
  "fingerprintAuditEnabled": true,
  "fingerprintAuditDriftThreshold": 0.72,
  "fingerprintAuditCooldownMinutes": 5
}
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `RELAYRADAR_PORT` | `8080` | Proxy port |
| `RELAYRADAR_ADMIN_TOKEN` | — | Admin API auth token |
| `RELAYRADAR_ADMIN_CORS_ORIGIN` | `*` | Console CORS origin |
| `VITE_ADMIN_TOKEN` | — | Console-side auth token |
| `RELAYRADAR_PRIVACY_FILTER_MODEL` | `openai/privacy-filter` | HuggingFace model ID for ML privacy filter |
| `RELAYRADAR_PRIVACY_FILTER_DTYPE` | `q4` | ONNX quantization dtype (`q4`, `fp32`, `fp16`, etc.) |
| `RELAYRADAR_PRIVACY_FILTER_DEVICE` | — | Inference device (`cpu`, `cuda`, `webgpu`) |

## 📖 API Reference

### Proxy Routes (Drop-in OpenAI compatible)

```
POST /v1/chat/completions    # Chat (streaming & non-streaming)
POST /v1/responses           # Responses API
GET  /v1/models              # List models
```

### Admin Routes (`/rr/*`)

<details>
<summary><strong>Health & Overview</strong></summary>

```
GET  /rr/health              # Health check
GET  /rr/overview            # All endpoints with status and metrics
POST /rr/models/list         # Discover upstream OpenAI-compatible models
```
</details>

<details>
<summary><strong>Endpoint Management</strong></summary>

```
GET    /rr/endpoints              # List endpoints
POST   /rr/endpoints              # Create endpoint
PUT    /rr/endpoints/:id          # Update endpoint
DELETE /rr/endpoints/:id          # Delete endpoint
POST   /rr/endpoints/:id/default  # Set default
POST   /rr/endpoints/:id/fingerprint-baseline # Set comparison baseline
GET    /rr/endpoints/:id          # Detail with metrics
```
</details>

<details>
<summary><strong>Fingerprint Lab</strong></summary>

```
GET  /rr/fingerprint/:id           # Portrait + audit history
POST /rr/fingerprint/:id/audit     # Trigger audit
GET  /rr/fingerprint/baselines     # List baselines
POST /rr/fingerprint/baselines/run # Build new baseline
POST /rr/fingerprint/baselines/:id/preferred # Mark preferred baseline
DELETE /rr/fingerprint/baselines/:id # Delete baseline
GET  /rr/fingerprint/models        # List model definitions
POST /rr/fingerprint/models        # Create model definition
PUT  /rr/fingerprint/models/:id    # Update model definition
DELETE /rr/fingerprint/models/:id  # Delete model definition
POST /rr/fingerprint/catalog/build # Batch catalog build
```
</details>

<details>
<summary><strong>Shield, Policy & Events</strong></summary>

```
GET  /rr/shield          # Shield statistics
GET  /rr/events          # Risk event log (?endpointId=&limit=)
GET  /rr/policy          # Current policy
PUT  /rr/policy          # Update policy
POST /rr/reload          # Reload policy config from disk
GET  /rr/sentinel/:id    # Endpoint sentinel history
POST /rr/sentinel/run    # Manual sentinel cycle
POST /rr/sentinel/:id/run # Manual sentinel run for one endpoint
```
</details>

## 📁 Project Structure

```
relayradar/
├── assets/                # README images and brand assets
├── apps/
│   ├── proxy/             # TypeScript + Fastify + SQLite
│   │   └── src/
│   │       ├── proxy/     # OpenAI-compatible request handling
│   │       ├── shield/    # Redaction engine
│   │       ├── sentinel/  # Drift probes
│   │       ├── fingerprint/ # AB3IT model identity
│   │       └── admin/     # Management API
│   └── console/           # React 19 + Vite 7
│       └── src/
│           ├── pages/     # 5 page components
│           └── components/  # Reusable UI
├── packages/
│   └── shared/            # TypeScript types
├── config/                # endpoints.json, policy.json
└── data/                  # Built-in fingerprint catalog and local runtime data
```

## 🧪 Tech Stack

| Component | Technology |
|---|---|
| Proxy Server | TypeScript, Fastify |
| Database | SQLite (zero-config, local) |
| Console | React 19, Vite 7, React Router 7 |
| ML Privacy Filter | `@huggingface/transformers` (ONNX, runs locally) |
| Monorepo | pnpm workspaces |
| Type Safety | Shared TypeScript package |

**No extra observability infrastructure required.** No Prometheus, no Redis, no cloud database. You only need the upstream LLM endpoint and credentials you want RelayRadar to monitor.

## 📚 Citation

If you use RelayRadar in research or public reports, please cite:

```bibtex
@software{relayradar2026,
  title = {RelayRadar: Towards Transparent and Trustworthy Black-Box LLM Service Access},
  author = {{Shanghai Artificial Intelligence Laboratory}},
  year = {2026},
  url = {https://github.com/AI45Lab/RelayRadar}
}
```

## 📄 License

BUSL-1.1 — source-available for non-production use. See [LICENSE](./LICENSE) for details.

---

<div align="center">

**RelayRadar** is built for anyone who routes LLM traffic through third-party services and needs to trust but verify.

If this is useful to you, give it a ⭐

</div>

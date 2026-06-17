import type { ProbeExpectation } from "@relayradar/shared";

/** 内置指纹挑战集：用于 Sentinel 周期巡检与主动审计，不对外提供题库 CRUD。 */
export interface SentinelPrompt {
  id: string;
  title: string;
  capability: string;
  prompt: string;
  expectJson: boolean;
  /** 基线说明：哪些模型易对/易错、或易输出固定话术（仅供人读，不参与自动判分） */
  notes: string;
  sortOrder: number;
  expectation: ProbeExpectation;
  expectationSummary: string;
}

export const SENTINEL_PROMPTS: SentinelPrompt[] = [
  {
    id: "json_strict_v1",
    title: "严格 JSON 形态",
    capability: "strict_json",
    prompt:
      "Return ONLY valid JSON object with fields {\"region\":\"APAC\",\"score\":87,\"ok\":true}. No markdown.",
    expectJson: true,
    notes: "强约束 JSON；换后端时常出现 markdown 包裹或字段漂移，适合作为指纹锚点。",
    sortOrder: 10,
    expectation: {
      mode: "json_required_keys",
      requiredKeys: ["region", "score", "ok"]
    },
    expectationSummary: "Must be strict JSON object and include keys: region, score, ok"
  },
  {
    id: "tool_trigger_v1",
    title: "工具调用决策",
    capability: "tool_call",
    prompt:
      "You can call function get_weather(city). Decide whether to call tool for city=Shanghai. If no tool call, explain why in one sentence.",
    expectJson: false,
    notes: "是否发起 tool_calls、结构差异在多家实现间区别明显。",
    sortOrder: 20,
    expectation: { mode: "none" },
    expectationSummary: "No strict textual expectation (use behavior drift and tool-call fields)"
  },
  {
    id: "bilingual_format_v1",
    title: "中英双行格式",
    capability: "bilingual_format",
    prompt: "Output exactly 2 bullet lines. First line in Chinese, second in English. Topic: endpoint stability.",
    expectJson: false,
    notes: "考察是否遵守条数与语言顺序；易暴露「套话」或格式松懈。",
    sortOrder: 30,
    expectation: {
      mode: "bullet_lines",
      exact: 2
    },
    expectationSummary: "Must return exactly 2 bullet lines"
  },
  {
    id: "refusal_boundary_v1",
    title: "安全说明语气",
    capability: "refusal_style",
    prompt: "Explain why sharing API keys publicly is unsafe. Keep tone concise and practical.",
    expectJson: false,
    notes: "不同系列模型的拒绝/说教模板差异大，可聚类对比。",
    sortOrder: 40,
    expectation: {
      mode: "contains_all",
      values: ["api", "key"]
    },
    expectationSummary: "Should explicitly mention API key risk"
  },
  {
    id: "fact_short_v1",
    title: "极短事实问答",
    capability: "short_fact",
    prompt: "What is HTTP 429 typically used for? Answer in <= 12 words.",
    expectJson: false,
    notes: "长度与措辞约束；廉价模型常超长或跑题。",
    sortOrder: 50,
    expectation: {
      mode: "word_count",
      max: 12
    },
    expectationSummary: "Answer length must be at most 12 words"
  },
  {
    id: "structured_rewrite_v1",
    title: "文本转 JSON",
    capability: "structured_rewrite",
    prompt: "Rewrite: 'Service got slower and failed more today.' as JSON with fields summary,risk,action.",
    expectJson: true,
    notes: "自然语言→结构化；与 json_strict 互补。",
    sortOrder: 60,
    expectation: {
      mode: "json_required_keys",
      requiredKeys: ["summary", "risk", "action"]
    },
    expectationSummary: "Must be JSON object with keys: summary, risk, action"
  },
  {
    id: "code_gen_v1",
    title: "短代码生成",
    capability: "code_generation",
    prompt: "Write a TypeScript function sleep(ms:number):Promise<void> in <= 6 lines.",
    expectJson: false,
    notes: "语法与风格指纹；部分路由会明显简化或混入其他语言习惯。",
    sortOrder: 70,
    expectation: {
      mode: "contains_all",
      values: ["function", "sleep", "Promise<void>"]
    },
    expectationSummary: "Should include a TypeScript sleep function signature"
  },
  {
    id: "long_constraint_short_answer_v1",
    title: "九词约束",
    capability: "constraint_following_short",
    prompt: "Answer with exactly 9 words: why should we rotate API keys regularly?",
    expectJson: false,
    notes: "词数硬约束；易暴露指令跟随能力变化。",
    sortOrder: 80,
    expectation: {
      mode: "word_count",
      exact: 9
    },
    expectationSummary: "Answer must contain exactly 9 words"
  },
  {
    id: "short_constraint_long_answer_v1",
    title: "段落长度约束",
    capability: "constraint_following_long",
    prompt: "In 5-7 sentences, describe how to reduce prompt leakage through relays.",
    expectJson: false,
    notes: "句数区间；降级模型常缩短或合并句。",
    sortOrder: 90,
    expectation: {
      mode: "sentence_count",
      min: 5,
      max: 7
    },
    expectationSummary: "Answer should be between 5 and 7 sentences"
  },
  {
    id: "stream_probe_v1",
    title: "步骤列举（流式友好）",
    capability: "stream_behavior",
    prompt: "Provide three numbered steps for measuring TTFT in streaming APIs.",
    expectJson: false,
    notes: "编号与条数；与流式 chunk 行为一起看更有信号。",
    sortOrder: 100,
    expectation: {
      mode: "numbered_steps",
      exact: 3
    },
    expectationSummary: "Should return exactly 3 numbered steps"
  },
  {
    id: "error_probe_v1",
    title: "错误恢复话术",
    capability: "error_trigger_probe",
    prompt: "If I ask for malformed JSON, how do you recover safely? 2 sentences.",
    expectJson: false,
    notes: "句数+主题；不同训练数据下模板分化。",
    sortOrder: 110,
    expectation: {
      mode: "sentence_count",
      exact: 2
    },
    expectationSummary: "Answer should contain exactly 2 sentences"
  },
  {
    id: "template_consistency_v1",
    title: "固定模板前缀",
    capability: "template_consistency",
    prompt: "Respond as '[RISK=<low|medium|high>] <single sentence advice>' for 'timeout spikes'.",
    expectJson: false,
    notes: "前缀格式强约束；适合抓「特殊固定输出」模式。",
    sortOrder: 120,
    expectation: {
      mode: "regex",
      pattern: "^\\[RISK=(low|medium|high)\\]\\s+.+$",
      flags: "i"
    },
    expectationSummary: "Must match format: [RISK=<level>] <single sentence advice>"
  },
  {
    id: "numeric_only_v1",
    title: "仅输出数字",
    capability: "numeric_only",
    prompt: "What is 17 * 24? Reply with only the digits of the answer, no other characters.",
    expectJson: false,
    notes: "极简格式；易在替换为弱模型时出现解释性废话。",
    sortOrder: 130,
    expectation: {
      mode: "exact_text",
      value: "408",
      caseSensitive: true
    },
    expectationSummary: "Output must be exactly: 408"
  },
  {
    id: "exact_echo_v1",
    title: "逐字复述标记",
    capability: "exact_echo",
    prompt:
      "Your entire reply must be exactly this single line and nothing else: RELAYRADAR_PROBE_TOKEN_9f2a",
    expectJson: false,
    notes: "应高度稳定；若常加引号/换行/道歉，可作为替换或降级旁证。",
    sortOrder: 140,
    expectation: {
      mode: "exact_text",
      value: "RELAYRADAR_PROBE_TOKEN_9f2a",
      caseSensitive: true
    },
    expectationSummary: "Output must match token exactly with no extra content"
  },
  {
    id: "yes_no_boundary_v1",
    title: "是否二选一",
    capability: "yes_no",
    prompt: "Is an empty JSON object {} valid JSON? Answer with exactly Yes or No.",
    expectJson: false,
    notes: "边界定义题；不同系列对「严格 JSON」口径不一。",
    sortOrder: 150,
    expectation: {
      mode: "one_of",
      values: ["Yes", "No"],
      caseSensitive: false
    },
    expectationSummary: "Output must be exactly one of: Yes / No"
  },
  {
    id: "self_desc_short_v1",
    title: "身份简述（短）",
    capability: "self_description",
    prompt: "What are you? Answer in at most 8 words, no punctuation beyond a period if needed.",
    expectJson: false,
    notes: "部分线路会固定套话或暴露与声明模型不符的自我描述，仅作基线记录勿过度解读。",
    sortOrder: 160,
    expectation: {
      mode: "word_count",
      max: 8
    },
    expectationSummary: "Answer length must be at most 8 words"
  },
  {
    id: "math_numeric_v1",
    title: "多步算术（仅数字）",
    capability: "math_numeric",
    prompt: "Compute ((58 * 17) - 203). Reply with digits only.",
    expectJson: false,
    notes: "确定性算术题，适合快速发现输出污染或格式漂移。",
    sortOrder: 170,
    expectation: {
      mode: "exact_text",
      value: "783",
      caseSensitive: true
    },
    expectationSummary: "Output must be exactly: 783"
  },
  {
    id: "label_choice_v1",
    title: "标签三选一",
    capability: "classification_label",
    prompt:
      "Classify this incident severity for API operations: 'P95 latency +220% for 18 minutes, no data loss'. Reply with exactly one label: LOW, MEDIUM, HIGH.",
    expectJson: false,
    notes: "单标签约束，适合观测模型在边界样本上的决策稳定性。",
    sortOrder: 180,
    expectation: {
      mode: "one_of",
      values: ["LOW", "MEDIUM", "HIGH"],
      caseSensitive: false
    },
    expectationSummary: "Output must be exactly one of: LOW / MEDIUM / HIGH"
  },
  {
    id: "json_extract_v1",
    title: "实体抽取 JSON",
    capability: "entity_extraction_json",
    prompt:
      "Extract from: 'On 2026-01-09, Alice from Orion Labs approved ticket T-4827.' Return JSON object with keys person,organization,date,ticket.",
    expectJson: true,
    notes: "结构化抽取对 schema 服从敏感，可用于替换/降级旁证。",
    sortOrder: 190,
    expectation: {
      mode: "json_required_keys",
      requiredKeys: ["person", "organization", "date", "ticket"]
    },
    expectationSummary: "Must be JSON object with keys: person, organization, date, ticket"
  },
  {
    id: "keywords_ops_v1",
    title: "运维关键词覆盖",
    capability: "ops_keywords",
    prompt: "In one sentence, explain why request retries need exponential backoff and jitter.",
    expectJson: false,
    notes: "关键词覆盖可检测知识退化与模板空洞化。",
    sortOrder: 200,
    expectation: {
      mode: "contains_all",
      values: ["backoff", "jitter"]
    },
    expectationSummary: "Should include both keywords: backoff, jitter"
  },
  {
    id: "sentence_exact3_v1",
    title: "三句约束",
    capability: "sentence_constraint",
    prompt: "Give exactly 3 sentences on how to reduce prompt leakage through relays.",
    expectJson: false,
    notes: "句数硬约束，常在弱模型或路由变化时首先失真。",
    sortOrder: 210,
    expectation: {
      mode: "sentence_count",
      exact: 3
    },
    expectationSummary: "Answer should contain exactly 3 sentences"
  },
  {
    id: "bullet4_v1",
    title: "四条要点",
    capability: "bullet_constraint",
    prompt: "Return exactly 4 bullet points about safeguarding API keys in CI/CD.",
    expectJson: false,
    notes: "条目数约束 + 主题约束，成本低但稳定性信号强。",
    sortOrder: 220,
    expectation: {
      mode: "bullet_lines",
      exact: 4
    },
    expectationSummary: "Must return exactly 4 bullet lines"
  },
  {
    id: "steps5_v1",
    title: "五步流程",
    capability: "numbered_procedure",
    prompt: "Provide exactly 5 numbered steps to debug intermittent 502 errors in a relay chain.",
    expectJson: false,
    notes: "编号步骤约束可观察格式服从与思路完整度。",
    sortOrder: 230,
    expectation: {
      mode: "numbered_steps",
      exact: 5
    },
    expectationSummary: "Should return exactly 5 numbered steps"
  },
  {
    id: "prefix_template_v1",
    title: "前缀模板",
    capability: "template_prefix",
    prompt: "Reply in this format only: 'RISK: <LOW|MEDIUM|HIGH> | ACTION: <short action>' for 'secret found in logs'.",
    expectJson: false,
    notes: "固定模板用于追踪输出结构稳定性与风格突变。",
    sortOrder: 240,
    expectation: {
      mode: "regex",
      pattern: "^RISK:\\s*(LOW|MEDIUM|HIGH)\\s*\\|\\s*ACTION:\\s*.+$",
      flags: "i"
    },
    expectationSummary: "Must match: RISK: <level> | ACTION: <action>"
  },
  {
    id: "json_boolean_v1",
    title: "布尔 JSON",
    capability: "boolean_json",
    prompt: "Return JSON object {\"needs_rotation\":true,\"reason\":\"token age > 90d\"}. No markdown.",
    expectJson: true,
    notes: "简单 schema + 布尔值，适合与 strict_json 形成双锚点。",
    sortOrder: 250,
    expectation: {
      mode: "json_required_keys",
      requiredKeys: ["needs_rotation", "reason"]
    },
    expectationSummary: "Must be JSON object with keys: needs_rotation, reason"
  },
  {
    id: "regex_ticket_v1",
    title: "工单号格式",
    capability: "regex_format",
    prompt: "Generate one plausible incident ticket id in format INC-YYYYMMDD-XXXX (X is uppercase letter or digit).",
    expectJson: false,
    notes: "格式规则可快速识别文本生成器替换或提示模板污染。",
    sortOrder: 260,
    expectation: {
      mode: "regex",
      pattern: "^INC-\\d{8}-[A-Z0-9]{4}$"
    },
    expectationSummary: "Must match regex: ^INC-\\d{8}-[A-Z0-9]{4}$"
  },
  {
    id: "one_word_v1",
    title: "单词输出",
    capability: "single_word",
    prompt: "Answer with exactly one word: safest default for unknown endpoint behavior?",
    expectJson: false,
    notes: "超短输出约束可捕捉冗余话术与模板注入。",
    sortOrder: 270,
    expectation: {
      mode: "word_count",
      exact: 1
    },
    expectationSummary: "Answer must contain exactly 1 word"
  },
  {
    id: "yes_no_secrets_v1",
    title: "敏感信息是否上传",
    capability: "binary_policy",
    prompt: "Should production .env files ever be pasted into prompts? Reply with exactly Yes or No.",
    expectJson: false,
    notes: "基础安全边界问法，适合长期稳定追踪。",
    sortOrder: 280,
    expectation: {
      mode: "one_of",
      values: ["Yes", "No"],
      caseSensitive: false
    },
    expectationSummary: "Output must be exactly one of: Yes / No"
  }
];

const promptById = new Map(SENTINEL_PROMPTS.map((item) => [item.id, item]));

export function getSentinelPromptById(promptId: string): SentinelPrompt | null {
  return promptById.get(promptId) ?? null;
}

export function getDefaultAuditPrompt(): SentinelPrompt | null {
  return promptById.get("json_strict_v1") ?? SENTINEL_PROMPTS[0] ?? null;
}

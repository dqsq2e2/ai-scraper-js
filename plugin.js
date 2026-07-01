"use strict";

const DEFAULT_SYSTEM_PROMPT = [
  "你是 Ting Reader 的有声书元数据选择器。",
  "你会收到原始书名、本地或音频提取出的元数据、普通刮削器候选结果，以及系统按存储库配置合并出的参考结果。",
  "你的任务是从候选结果中选择最可信的字段，必要时结合原始书名和音频元数据判断，不要凭空编造。",
  "只返回 JSON 对象，不要 Markdown，不要代码块。",
  "JSON 字段：title, author, narrator, cover_url, intro, tags, explicit, abridged, chapter_titles。",
  "tags 和 chapter_titles 必须是字符串数组；explicit 和 abridged 必须是布尔值；未知字段用空字符串、空数组或 null。",
  "如果输入包含 chapter_candidates 且要求 AI 清洗章节名，必须返回 chapter_titles，并与 chapter_candidates 顺序和数量一致。",
  "chapter_titles 只表示章节模板里的 {chapter_title} 占位符值，不是最终展示标题。",
  "不要在 chapter_titles 中应用章节模板，不要添加书名，也不要添加章节号、集数、回数、话数前缀；章节号由 Ting Reader 根据模板统一生成。",
  "清洗章节名时移除平台广告、文件后缀、重复书名、主播/版权噪声和多余符号，保留有意义的小标题；无法判断时返回去掉文件后缀后的原始 title。"
].join("\n");

const DEFAULT_TITLE_CLEANUP_PROMPT = [
  "你是 Ting Reader 的有声书搜索书名清洗器。",
  "你只负责把原始书名清洗成用于搜索普通刮削器的纯净书名。",
  "只返回 JSON 对象，不要 Markdown，不要代码块。",
  "JSON 字段只能包含 title。",
  "清洗时移除文件后缀、平台广告、合集、完结、有声书、多人播、高音质、作者主播版权噪声和多余符号。",
  "不要改成另一部书，不要返回作者、主播、副标题、章节名或其他元数据；不确定时返回去噪后的原始书名。"
].join("\n");

const DEFAULT_CHAPTER_TITLE_CLEANUP_PROMPT = [
  "你是 Ting Reader 的有声书章节名清洗器。",
  "你只负责清洗输入的章节候选名，并保持顺序和数量完全一致。",
  "只返回 JSON 对象，不要 Markdown，不要代码块。",
  "JSON 字段只能包含 chapter_titles，且必须是字符串数组。",
  "chapter_titles 只表示章节模板里的 {chapter_title} 占位符值，不是最终展示标题。",
  "不要在 chapter_titles 中应用章节模板，不要添加书名，也不要添加章节号、集数、回数、话数前缀；章节号由 Ting Reader 根据模板统一生成。",
  "清洗章节名时移除平台广告、文件后缀、重复书名、主播/版权噪声和多余符号，保留有意义的小标题；无法判断时返回去掉文件后缀后的原始 title。"
].join("\n");

async function search(args) {
  const config = readConfig();
  const fallback = buildFallbackItem(args, config);

  if (args?.title_cleanup === true) {
    return cleanSearchTitle(args, config, fallback);
  }

  const allChapterCandidates =
    config.chapterTitleCleanup === "ai"
      ? normalizeChapterCandidates(args?.scanner_context?.chapters)
      : [];

  if (!config.apiKey) {
    Ting?.log?.warn?.("AI Metadata Scraper api_key is empty; returning merged scraper metadata.");
    return toSearchResult(fallback, args);
  }

  try {
    const firstChapterBatch = allChapterCandidates.slice(0, config.maxChapterTitles);
    const input = buildModelInput(args, config, fallback, firstChapterBatch, allChapterCandidates.length);
    const parsed = await callChatCompletion(input, config, config.systemPrompt || DEFAULT_SYSTEM_PROMPT);
    const item = normalizeAiMetadata(parsed, fallback, config);

    if (allChapterCandidates.length > 0) {
      item.chapter_titles = await cleanChapterTitlesInBatches(
        args,
        config,
        fallback,
        item,
        allChapterCandidates,
        parsed
      );
    }

    return toSearchResult(item, args);
  } catch (error) {
    Ting?.log?.warn?.(`AI metadata selection failed: ${error}`);
    return toSearchResult(fallback, args);
  }
}

async function cleanSearchTitle(args, config, fallback) {
  if (!config.apiKey) {
    Ting?.log?.warn?.("AI Metadata Scraper api_key is empty; returning original title for title cleanup.");
    return toSearchResult(fallback, args);
  }

  try {
    const input = buildTitleCleanupInput(args, fallback);
    const parsed = await callChatCompletion(input, config, config.titleCleanupPrompt || DEFAULT_TITLE_CLEANUP_PROMPT);
    const title = normalizeCleanTitle(parsed?.title, fallback.title);
    return toSearchResult(pruneEmpty({ ...fallback, title }), args);
  } catch (error) {
    Ting?.log?.warn?.(`AI title cleanup failed: ${error}`);
    return toSearchResult(fallback, args);
  }
}

function readConfig() {
  const config = Ting?.config || {};
  return {
    endpoint: normalizeEndpoint(stringValue(config.api_base_url, "https://api.openai.com/v1/chat/completions")),
    apiKey: stringValue(config.api_key, ""),
    model: stringValue(config.model, "gpt-4.1-mini"),
    temperature: numberValue(config.temperature, 0.1, 0, 1),
    maxCandidates: integerValue(config.max_candidates, 8, 1, 20),
    maxChapterTitles: integerValue(config.max_chapter_titles, 200, 1, 1000),
    chapterTitleCleanup: stringValue(config.chapter_title_cleanup, "clean"),
    chapterTemplate: resolveChapterTemplate(config),
    systemPrompt: stringValue(config.system_prompt, ""),
    titleCleanupPrompt: stringValue(config.title_cleanup_prompt, ""),
    chapterTitleCleanupPrompt: stringValue(config.chapter_title_cleanup_prompt, "")
  };
}

function normalizeEndpoint(value) {
  const endpoint = value.trim().replace(/\/+$/, "");
  if (!endpoint) return "https://api.openai.com/v1/chat/completions";
  if (endpoint.endsWith("/chat/completions")) return endpoint;
  if (endpoint.endsWith("/v1")) return `${endpoint}/chat/completions`;
  return `${endpoint}/v1/chat/completions`;
}

function resolveChapterTemplate(config) {
  const format = stringValue(config.chapter_title_format, "chapter-title");
  let template;
  if (format === "book-chapter-title") {
    template = "{book_title}-{chapter_number}-{chapter_title}";
  } else if (format === "chapter-number-title") {
    template = "{chapter_number}-{chapter_title}";
  } else if (format === "custom") {
    template = stringValue(
      config.custom_chapter_title_template,
      "{book_title}-{chapter_number}-{chapter_title}"
    );
  } else {
    template = "{chapter_title}";
  }

  const cleanup = stringValue(config.chapter_title_cleanup, "clean");
  if (cleanup === "preserve" && !template.toLowerCase().startsWith("raw:")) {
    return `raw:${template}`;
  }
  return template;
}

function buildModelInput(args, config, fallback, chapterCandidates, totalChapterCandidates) {
  const candidates = Array.isArray(args?.candidates) ? args.candidates : [];
  const scannerContext = { ...(args?.scanner_context || {}) };
  delete scannerContext.chapters;

  return {
    instruction: "Select the best audiobook metadata fields from candidates. Return JSON only.",
    original_query: args?.query || args?.title || "",
    scraper_query: args?.scraper_query || args?.search_query || args?.query || args?.title || "",
    scanner_context: scannerContext,
    chapter_candidates: chapterCandidates,
    chapter_batch: {
      start_index: chapterCandidates.length ? 1 : 0,
      count: chapterCandidates.length,
      total: totalChapterCandidates
    },
    merged_metadata: args?.merged_metadata || fallback,
    candidates: candidates.slice(0, config.maxCandidates),
    output_rules: {
      do_not_invent: true,
      return_fields: ["title", "author", "narrator", "cover_url", "intro", "tags", "explicit", "abridged", "chapter_titles"],
      keep_cover_url_from_candidates: true,
      tags_as_array: true,
      chapter_title_cleanup: config.chapterTitleCleanup,
      chapter_title_template_is_configured_by_plugin: config.chapterTemplate,
      chapter_title_cleanup_is_configured_by_plugin: true,
      chapter_titles_same_order_as_chapter_candidates: config.chapterTitleCleanup === "ai",
      chapter_titles_count: chapterCandidates.length,
      chapter_titles_are_chapter_title_placeholder_values: true,
      do_not_apply_chapter_title_template_in_chapter_titles: true,
      template_will_be_applied_by_ting_reader: config.chapterTemplate,
      exclude_book_title_and_chapter_number_from_chapter_titles: true
    }
  };
}

function buildTitleCleanupInput(args, fallback) {
  const scannerContext = { ...(args?.scanner_context || {}) };
  delete scannerContext.chapters;

  return {
    instruction: "Clean this audiobook title before searching ordinary scraper plugins. Return JSON only.",
    title_cleanup: true,
    original_query: args?.query || args?.title || fallback.title || "",
    scanner_context: scannerContext,
    current_metadata: scannerContext.current_metadata || {},
    output_rules: {
      do_not_invent: true,
      return_fields: ["title"],
      title_is_only_for_scraper_search: true,
      remove_file_extension_and_noise: true,
      keep_core_book_title_only: true,
      do_not_return_author_narrator_subtitle_or_chapters: true
    }
  };
}

function buildChapterCleanupInput(args, config, fallback, selectedMetadata, chapterCandidates, offset, totalCount) {
  return {
    instruction: "Clean only these audiobook chapter titles. Return JSON only.",
    original_query: args?.query || args?.title || "",
    selected_metadata: {
      title: firstText(selectedMetadata.title, fallback.title),
      author: firstText(selectedMetadata.author, fallback.author),
      narrator: firstOptionalText(selectedMetadata.narrator, fallback.narrator)
    },
    chapter_candidates: chapterCandidates,
    chapter_batch: {
      start_index: offset + 1,
      count: chapterCandidates.length,
      total: totalCount
    },
    output_rules: {
      do_not_invent: true,
      return_fields: ["chapter_titles"],
      chapter_title_cleanup: "ai",
      chapter_titles_same_order_as_chapter_candidates: true,
      chapter_titles_count: chapterCandidates.length,
      chapter_titles_are_chapter_title_placeholder_values: true,
      do_not_apply_chapter_title_template_in_chapter_titles: true,
      template_will_be_applied_by_ting_reader: config.chapterTemplate,
      exclude_book_title_and_chapter_number_from_chapter_titles: true
    }
  };
}

function buildFallbackItem(args, config) {
  const merged = args?.merged_metadata || {};
  const scanner = args?.scanner_context || {};
  const current = scanner?.current_metadata || {};
  const query = args?.query || args?.title || current?.title || merged?.title || "Unknown Book";

  const item = {
    id: `ai:${stableId(query)}`,
    title: firstText(merged.title, current.title, query),
    author: firstText(merged.author, current.author, "Unknown"),
    narrator: firstOptionalText(merged.narrator, current.narrator),
    cover_url: firstOptionalText(merged.cover_url, current.cover_url),
    intro: firstText(merged.intro, merged.description, current.description, ""),
    tags: normalizeTags(merged.tags ?? current.tags),
    explicit: Boolean(merged.explicit || current.explicit),
    abridged: Boolean(merged.abridged || current.abridged),
    chapter_title_template: config.chapterTemplate,
    chapter_titles: []
  };

  return pruneEmpty(item);
}

function normalizeAiMetadata(raw, fallback, config) {
  const item = {
    id: fallback.id,
    title: firstText(raw.title, fallback.title),
    author: firstText(raw.author, fallback.author, "Unknown"),
    narrator: firstOptionalText(raw.narrator, fallback.narrator),
    cover_url: firstOptionalText(raw.cover_url, raw.cover, fallback.cover_url),
    intro: firstText(raw.intro, raw.description, fallback.intro, ""),
    tags: normalizeTags(raw.tags).length ? normalizeTags(raw.tags) : fallback.tags,
    explicit: booleanValue(raw.explicit, fallback.explicit),
    abridged: booleanValue(raw.abridged, fallback.abridged),
    chapter_title_template: config.chapterTemplate,
    chapter_titles: []
  };

  return pruneEmpty(item);
}

async function callChatCompletion(input, config, systemPrompt) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: JSON.stringify(input, null, 2) }
  ];

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature,
      response_format: { type: "json_object" }
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `AI request failed with status ${response.status}`);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(payload?.error?.message || "AI response does not contain message content");
  }

  return parseJsonObject(content);
}

async function cleanChapterTitlesInBatches(args, config, fallback, selectedMetadata, allChapterCandidates, firstParsed) {
  const titles = new Array(allChapterCandidates.length).fill("");
  fillChapterTitleBatch(titles, 0, firstParsed?.chapter_titles, Math.min(config.maxChapterTitles, allChapterCandidates.length));

  if (allChapterCandidates.length <= config.maxChapterTitles) {
    return titles;
  }

  const totalBatches = Math.ceil(allChapterCandidates.length / config.maxChapterTitles);
  Ting?.log?.info?.(
    `AI chapter title cleanup will run in ${totalBatches} batches (${allChapterCandidates.length} chapters, ${config.maxChapterTitles} per batch).`
  );

  for (let offset = config.maxChapterTitles; offset < allChapterCandidates.length; offset += config.maxChapterTitles) {
    const batch = allChapterCandidates.slice(offset, offset + config.maxChapterTitles);
    const batchNumber = Math.floor(offset / config.maxChapterTitles) + 1;

    try {
      const input = buildChapterCleanupInput(
        args,
        config,
        fallback,
        selectedMetadata,
        batch,
        offset,
        allChapterCandidates.length
      );
      const parsed = await callChatCompletion(
        input,
        config,
        config.chapterTitleCleanupPrompt || DEFAULT_CHAPTER_TITLE_CLEANUP_PROMPT
      );
      fillChapterTitleBatch(titles, offset, parsed?.chapter_titles, batch.length);
    } catch (error) {
      Ting?.log?.warn?.(`AI chapter title cleanup batch ${batchNumber}/${totalBatches} failed: ${error}`);
    }
  }

  return titles;
}

function fillChapterTitleBatch(target, offset, rawTitles, batchSize) {
  const titles = normalizeChapterTitles(rawTitles, batchSize);
  for (let index = 0; index < batchSize; index += 1) {
    target[offset + index] = titles[index] || "";
  }
}

function toSearchResult(item, args) {
  return {
    items: [item],
    total: 1,
    page: Number(args?.page || 1),
    page_size: Number(args?.page_size || 1)
  };
}

function parseJsonObject(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("empty AI response");

  try {
    return JSON.parse(trimmed);
  } catch (_) {
    const withoutFence = trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    try {
      return JSON.parse(withoutFence);
    } catch (_) {
      const start = withoutFence.indexOf("{");
      const end = withoutFence.lastIndexOf("}");
      if (start >= 0 && end > start) {
        return JSON.parse(withoutFence.slice(start, end + 1));
      }
      throw new Error("AI response is not valid JSON");
    }
  }
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstOptionalText(...values) {
  const text = firstText(...values);
  return text || null;
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  if (typeof value === "string") {
    return value
      .split(/[，,;；|/]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  return [];
}

function normalizeChapterCandidates(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index) => {
      const source = item && typeof item === "object" ? item : {};
      const filename = firstText(source.filename, source.name, source.path, "");
      const title = firstText(source.title, source.stem, filename);

      return {
        index: Number(source.index) || index + 1,
        filename,
        title
      };
    })
    .filter((item) => item.title || item.filename);
}

function normalizeChapterTitles(value, maxCount) {
  if (!Array.isArray(value)) return [];

  return value
    .slice(0, maxCount)
    .map((title) => (typeof title === "string" ? title.trim() : ""));
}

function normalizeCleanTitle(value, fallback) {
  const title = firstText(value, fallback);
  return title.replace(/\s+/g, " ").trim();
}

function booleanValue(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) return true;
    if (["false", "no", "0"].includes(normalized)) return false;
  }
  return Boolean(fallback);
}

function pruneEmpty(item) {
  const result = { ...item };
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined) delete result[key];
    if (value === null && !["narrator", "cover_url"].includes(key)) delete result[key];
  }
  if (!Array.isArray(result.tags)) result.tags = [];
  if (!Array.isArray(result.chapter_titles)) result.chapter_titles = [];
  return result;
}

function stableId(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function stringValue(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function integerValue(value, fallback, min, max) {
  return Math.round(numberValue(value, fallback, min, max));
}

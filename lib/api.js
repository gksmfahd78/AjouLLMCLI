
function createHeaders(apiKey, includeJson = true) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (includeJson) headers["Content-Type"] = "application/json";
  return headers;
}

function ensureApiKey(config) {
  if (!config.apiKey) {
    throw new Error("Missing API key. Use `ajoullm config set apiKey <key>` or set AJOULLM_API_KEY.");
  }
}

function getRequestTimeoutMs() {
  const raw = process.env.AJOULLM_REQUEST_TIMEOUT_MS;
  if (!raw) return 120000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 120000;
  return Math.trunc(parsed);
}

function withTimeoutSignal(signal, timeoutMs = getRequestTimeoutMs()) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const cleanup = () => clearTimeout(timer);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return { signal: controller.signal, cleanup, didTimeout: () => timedOut };
}

async function requestJson(url, options) {
  const timed = withTimeoutSignal(options?.signal);
  try {
    const response = await fetch(url, { ...options, signal: timed.signal });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      const raw = data.error?.message || data.detail || data.raw || response.statusText;
      const detail = typeof raw === "string" ? raw : JSON.stringify(raw).slice(0, 300);
      throw new Error(`API request failed (${response.status}): ${detail}`);
    }
    return data;
  } catch (error) {
    if (timed.didTimeout()) {
      throw new Error(`API request timed out after ${getRequestTimeoutMs()}ms`);
    }
    throw error;
  } finally {
    timed.cleanup();
  }
}

function extractContent(message) {
  if (typeof message === "string") return { text: message, thinking: "" };
  if (Array.isArray(message)) {
    let text = "";
    let thinking = "";
    for (const item of message) {
      if (item?.type === "thinking") thinking += item.thinking || "";
      else if (item?.type === "text") text += item.text || "";
      else if (typeof item === "string") text += item;
      else if (typeof item?.text === "string") text += item.text;
    }
    return { text: text.trim(), thinking: thinking.trim() };
  }
  return { text: "", thinking: "" };
}

const INTERNAL_REVIEW_MODEL = "gpt-5.4-nano";
const INTERNAL_REVIEW_PROMPT = [
  "You are an internal answer reviewer.",
  "Review the user's task and identify the checks needed before the final answer.",
  "Focus on unsupported claims, contradictions, missing context, uncertainty, and required output format.",
  "If this is a code or repository task, require grounding in the provided files or explicitly note missing file context.",
  "If this is a general knowledge task, require uncertainty to be stated instead of guessing.",
  "Do not solve the task in full and do not write hidden chain-of-thought.",
  "Return a concise checklist for the final model."
].join(" ");
const FINAL_REASONING_PROMPT = [
  "Use the internal review guidance to answer carefully.",
  "Reason internally before answering, but do not reveal hidden chain-of-thought or scratchpad reasoning.",
  "Return only the final answer.",
  "State uncertainty explicitly when the available information is insufficient.",
  "Follow any requested output format exactly."
].join(" ");

function allowReviewFallback(config) {
  return config.reviewFallback === true || ["1", "true", "yes", "on"].includes(String(process.env.AJOULLM_REVIEW_FALLBACK || "").toLowerCase());
}

function buildInternalReviewPrompt(context) {
  const isCodeTask = /\b(code|repo|repository|file|bug|fix|test|build|function|class|api|cli|readme|tui|config|npm|node|javascript|typescript)\b/i.test(context);
  const domainRule = isCodeTask
    ? "Treat this as a code/repository task. Prefer evidence from supplied file content, commands, or project context. Flag any claim that is not grounded in that context."
    : "Treat this as a general answer task. Flag facts that may require external verification, current information, or source attribution.";
  return `${INTERNAL_REVIEW_PROMPT} ${domainRule}`;
}

function buildMessages(systemPrompt, history, prompt, reviewGuidance = "") {
  const messages = [];
  messages.push({ role: "system", content: FINAL_REASONING_PROMPT });
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  if (Array.isArray(history) && history.length > 0) messages.push(...history);
  if (reviewGuidance) messages.push({ role: "system", content: `Internal review guidance:\n${reviewGuidance}` });
  messages.push({ role: "user", content: prompt });
  return messages;
}

function buildReviewMessages(systemPrompt, history, prompt) {
  const context = [
    systemPrompt ? `System prompt:\n${systemPrompt}` : "",
    Array.isArray(history) && history.length > 0
      ? `Recent conversation:\n${history.slice(-8).map((m) => `${m.role}: ${String(m.content).slice(0, 1000)}`).join("\n")}`
      : "",
    `User task:\n${prompt}`
  ].filter(Boolean).join("\n\n");
  return [
    { role: "system", content: buildInternalReviewPrompt(context) },
    { role: "user", content: context }
  ];
}

function buildReviewMessagesFromMessages(messages) {
  const context = (Array.isArray(messages) ? messages : []).slice(-12).map((message) => {
    const content = typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content || message.tool_calls || "").slice(0, 1500);
    return `${message.role || "unknown"}: ${content.slice(0, 1500)}`;
  }).join("\n");
  return [
    { role: "system", content: buildInternalReviewPrompt(context) },
    { role: "user", content: `Conversation/task to review:\n${context}` }
  ];
}

async function requestInternalReview(config, messages, signal) {
  try {
    const data = await requestJson(`${config.baseUrl}/chat/completions/`, {
      method: "POST",
      headers: createHeaders(config.apiKey),
      body: JSON.stringify({
        model: INTERNAL_REVIEW_MODEL,
        messages,
        temperature: 0,
        top_p: 1,
        max_tokens: Math.min(Math.max(config.maxTokens || 2048, 512), 1024),
        stream: false
      }),
      signal
    });
    const { text } = extractContent(data.choices?.[0]?.message?.content);
    return text;
  } catch (error) {
    throw new Error(`Internal review failed with ${INTERNAL_REVIEW_MODEL}: ${error.message || String(error)}`);
  }
}

async function buildInternalReview(config, history, prompt, signal) {
  try {
    return await requestInternalReview(config, buildReviewMessages(config.systemPrompt, history, prompt), signal);
  } catch (error) {
    if (!allowReviewFallback(config)) throw error;
    return `Internal review was unavailable (${error.message || String(error)}). Answer conservatively, state uncertainty, and avoid unsupported claims.`;
  }
}

async function buildInternalReviewFromMessages(config, messages, signal) {
  try {
    return await requestInternalReview(config, buildReviewMessagesFromMessages(messages), signal);
  } catch (error) {
    if (!allowReviewFallback(config)) throw error;
    return `Internal review was unavailable (${error.message || String(error)}). Continue conservatively, inspect evidence before editing, and avoid unsupported claims.`;
  }
}

function buildRequestBody(config, history, prompt, stream, reviewGuidance = "") {
  const body = {
    model: config.model,
    messages: buildMessages(config.systemPrompt, history, prompt, reviewGuidance),
    temperature: config.temperature,
    top_p: config.topP,
    max_tokens: config.maxTokens,
    stream
  };
  return body;
}

async function streamChat(config, history, prompt) {
  const reviewGuidance = await buildInternalReview(config, history, prompt);
  const timed = withTimeoutSignal();
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions/`, {
      method: "POST",
      headers: createHeaders(config.apiKey),
      body: JSON.stringify(buildRequestBody(config, history, prompt, true, reviewGuidance)),
      signal: timed.signal
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new Error(`Streaming request failed (${response.status}): ${text || response.statusText}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const event of events) {
        for (const line of event.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") {
            process.stdout.write("\n");
            return fullText.trim();
          }
          try {
            const parsed = JSON.parse(payload);
            const token = parsed.choices?.[0]?.delta?.content;
            if (token) { fullText += token; process.stdout.write(token); }
          } catch {}
        }
      }
    }
    process.stdout.write("\n");
    return fullText.trim();
  } catch (error) {
    if (timed.didTimeout()) throw new Error(`Streaming request timed out after ${getRequestTimeoutMs()}ms`);
    throw error;
  } finally {
    timed.cleanup();
  }
}

async function streamChatTui(config, history, prompt, onToken, signal) {
  const reviewGuidance = await buildInternalReview(config, history, prompt, signal);
  const timed = withTimeoutSignal(signal);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions/`, {
      method: "POST",
      headers: createHeaders(config.apiKey),
      body: JSON.stringify(buildRequestBody(config, history, prompt, true, reviewGuidance)),
      signal: timed.signal
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new Error(`Streaming request failed (${response.status}): ${text || response.statusText}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const event of events) {
        for (const line of event.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") return fullText.trim();
          try {
            const parsed = JSON.parse(payload);
            const token = parsed.choices?.[0]?.delta?.content;
            if (token) { fullText += token; onToken(fullText); }
          } catch {}
        }
      }
    }
    return fullText.trim();
  } catch (error) {
    if (timed.didTimeout()) throw new Error(`Streaming request timed out after ${getRequestTimeoutMs()}ms`);
    throw error;
  } finally {
    timed.cleanup();
  }
}

async function runChatOnce(config, prompt, history = []) {
  ensureApiKey(config);
  if (config.stream) {
    const text = await streamChat(config, history, prompt);
    return { text };
  }
  const reviewGuidance = await buildInternalReview(config, history, prompt);
  const data = await requestJson(`${config.baseUrl}/chat/completions/`, {
    method: "POST",
    headers: createHeaders(config.apiKey),
    body: JSON.stringify(buildRequestBody(config, history, prompt, false, reviewGuidance))
  });
  const { text, thinking } = extractContent(data.choices?.[0]?.message?.content);
  return { text, thinking, raw: data };
}

async function fetchCredits(config) {
  ensureApiKey(config);
  return requestJson(`${config.baseUrl}/credits/`, {
    method: "GET",
    headers: createHeaders(config.apiKey, false)
  });
}

function formatCredits(data) {
  if (data == null) return "(unknown)";
  const total = data.total || data;
  if (total.remaining != null && total.quota != null) return `${total.remaining} / ${total.quota}`;
  return JSON.stringify(data);
}

module.exports = {
  createHeaders, ensureApiKey, requestJson, extractContent,
  INTERNAL_REVIEW_MODEL, INTERNAL_REVIEW_PROMPT, FINAL_REASONING_PROMPT,
  getRequestTimeoutMs, withTimeoutSignal,
  allowReviewFallback, buildInternalReviewPrompt, buildMessages, buildReviewMessages, buildReviewMessagesFromMessages,
  buildInternalReview, buildInternalReviewFromMessages, buildRequestBody,
  streamChat, streamChatTui, runChatOnce,
  fetchCredits, formatCredits
};

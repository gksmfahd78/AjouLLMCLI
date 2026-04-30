const fs = require("fs");
const { CONFIG_PATH, CONFIG_KEYS, DEFAULT_CONFIG } = require("./paths");
const { INTERNAL_REVIEW_MODEL, allowReviewFallback } = require("./api");
const { fail } = require("./utils");
const { loadJsonFile } = require("./workspace");

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  fail(`Invalid boolean value: ${value}`);
}

function parseNumber(value, key) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`Invalid numeric value for ${key}: ${value}`);
  return parsed;
}

function normalizeConfigValue(key, value) {
  if (key === "temperature" || key === "topP") return parseNumber(value, key);
  if (key === "maxTokens") return Math.trunc(parseNumber(value, key));
  if (key === "stream" || key === "reviewFallback") return parseBoolean(value);
  return value;
}

function redactConfig(config) {
  const next = {};
  for (const key of CONFIG_KEYS) {
    if (config[key] !== undefined) next[key] = config[key];
  }
  if (config.reviewModel !== undefined) next.reviewModel = config.reviewModel;
  if (config.reviewFallback !== undefined) next.reviewFallback = config.reviewFallback;
  if (next.apiKey) next.apiKey = `${next.apiKey.slice(0, 6)}...`;
  return next;
}

function loadConfig() {
  return loadJsonFile(CONFIG_PATH, {});
}

function saveConfig(config) {
  const next = {};
  for (const key of CONFIG_KEYS) {
    if (config[key] !== undefined) next[key] = config[key];
  }
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function deleteConfig() {
  if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
}

function getRuntimeConfig() {
  const fileConfig = loadConfig();
  const config = {
    apiKey: process.env.AJOULLM_API_KEY || fileConfig.apiKey,
    model: process.env.AJOULLM_MODEL || fileConfig.model || DEFAULT_CONFIG.model,
    baseUrl: process.env.AJOULLM_BASE_URL || fileConfig.baseUrl || DEFAULT_CONFIG.baseUrl,
    systemPrompt: process.env.AJOULLM_SYSTEM_PROMPT || fileConfig.systemPrompt || DEFAULT_CONFIG.systemPrompt,
    temperature: process.env.AJOULLM_TEMPERATURE ? parseNumber(process.env.AJOULLM_TEMPERATURE, "temperature") : (fileConfig.temperature ?? DEFAULT_CONFIG.temperature),
    topP: process.env.AJOULLM_TOP_P ? parseNumber(process.env.AJOULLM_TOP_P, "topP") : (fileConfig.topP ?? DEFAULT_CONFIG.topP),
    maxTokens: process.env.AJOULLM_MAX_TOKENS ? Math.trunc(parseNumber(process.env.AJOULLM_MAX_TOKENS, "maxTokens")) : (fileConfig.maxTokens ?? DEFAULT_CONFIG.maxTokens),
    stream: process.env.AJOULLM_STREAM ? parseBoolean(process.env.AJOULLM_STREAM) : (fileConfig.stream ?? DEFAULT_CONFIG.stream)
  };
  return {
    ...config,
    reviewModel: process.env.AJOULLM_REVIEW_MODEL || fileConfig.reviewModel || INTERNAL_REVIEW_MODEL,
    reviewFallback: allowReviewFallback(fileConfig)
  };
}

module.exports = {
  parseBoolean, parseNumber, normalizeConfigValue, redactConfig,
  loadConfig, saveConfig, deleteConfig, getRuntimeConfig
};

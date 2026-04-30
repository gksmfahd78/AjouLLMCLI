const path = require("path");

const DEFAULT_BASE_URL = "https://factchat-cloud.mindlogic.ai/v1/gateway";
const DEFAULT_MODEL = "gpt-5.4-nano";
const UTILITY_MODEL = "gpt-5.4-nano";
const DEFAULT_CONFIG = {
  model: DEFAULT_MODEL,
  baseUrl: DEFAULT_BASE_URL,
  systemPrompt: "",
  temperature: 0.3,
  topP: 1,
  maxTokens: 2048,
  stream: false
};
const CONFIG_PATH = path.join(process.cwd(), ".ajoullmrc.json");
const CACHE_DIR = path.join(process.cwd(), ".ajoullm");
const CACHE_PATH = path.join(CACHE_DIR, "project-context.json");
const AGENT_SESSION_PATH = path.join(CACHE_DIR, "agent-session.json");
const TUI_SESSION_PATH = path.join(CACHE_DIR, "tui-session.json");
const IMAGE_FILE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const CONFIG_KEYS = ["apiKey", "model", "baseUrl", "systemPrompt", "temperature", "topP", "maxTokens", "stream", "reviewModel", "reviewFallback"];
const KNOWN_COMMANDS = new Set(["config", "chat", "models", "credits", "interactive", "code", "agent", "help", "--help"]);
const TEXT_FILE_EXTENSIONS = new Set([
  ".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx", ".json", ".md", ".txt", ".yml", ".yaml",
  ".java", ".kt", ".kts", ".py", ".rb", ".go", ".rs", ".cs", ".php", ".swift", ".html",
  ".css", ".scss", ".sass", ".less", ".xml", ".sql", ".sh", ".ps1", ".bat", ".cmd", ".toml",
  ".ini", ".cfg", ".conf", ".env", ".dockerfile"
]);
const PROJECT_FILE_CACHE_TTL_MS = 1500;
const SLASH_COMMANDS = ["mode", "model", "system", "stream", "apikey", "credits", "status", "models", "compact", "init", "export", "undo", "clear", "exit", "help"];

module.exports = {
  DEFAULT_BASE_URL, DEFAULT_MODEL, UTILITY_MODEL, DEFAULT_CONFIG,
  CONFIG_PATH, CACHE_DIR, CACHE_PATH, AGENT_SESSION_PATH, TUI_SESSION_PATH,
  CONFIG_KEYS, KNOWN_COMMANDS, TEXT_FILE_EXTENSIONS, IMAGE_FILE_EXTENSIONS, PROJECT_FILE_CACHE_TTL_MS, SLASH_COMMANDS
};

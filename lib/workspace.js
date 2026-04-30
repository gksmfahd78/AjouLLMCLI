const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const { CACHE_DIR, CACHE_PATH, AGENT_SESSION_PATH, TEXT_FILE_EXTENSIONS, IMAGE_FILE_EXTENSIONS, PROJECT_FILE_CACHE_TTL_MS } = require("./paths");
const { fail } = require("./utils");

const PROJECT_FILE_CACHE = { cwd: "", files: null, expiresAt: 0 };

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function loadJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJsonFile(filePath, value) {
  ensureCacheDir();
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function loadCache() {
  return loadJsonFile(CACHE_PATH, {
    version: 1,
    updatedAt: null,
    root: process.cwd(),
    files: {},
    scans: {}
  });
}

function saveCache(cache) {
  saveJsonFile(CACHE_PATH, cache);
}

function loadAgentSession() {
  return loadJsonFile(AGENT_SESSION_PATH, null);
}

function saveAgentSession(session) {
  saveJsonFile(AGENT_SESSION_PATH, session);
}

function safeCommand(command, args) {
  try {
    return childProcess.execFileSync(command, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return "";
  }
}

function decodeBuffer(buf) {
  if (!buf) return "";
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length === 0) return "";
  const utf8 = b.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("euc-kr").decode(b);
  } catch {
    return utf8;
  }
}

function runShellCommand(command) {
  const shellCommand = process.platform === "win32" ? `chcp 65001>nul & ${command}` : command;
  try {
    const buf = childProcess.execSync(shellCommand, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { ok: true, stdout: decodeBuffer(buf) };
  } catch (error) {
    return {
      ok: false,
      stdout: decodeBuffer(error.stdout),
      stderr: error.stderr ? decodeBuffer(error.stderr) : error.message
    };
  }
}

function invalidateProjectFileCache() {
  PROJECT_FILE_CACHE.cwd = "";
  PROJECT_FILE_CACHE.files = null;
  PROJECT_FILE_CACHE.expiresAt = 0;
}

function listProjectFiles(options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const cwd = process.cwd();
  if (!forceRefresh && PROJECT_FILE_CACHE.cwd === cwd && PROJECT_FILE_CACHE.files && PROJECT_FILE_CACHE.expiresAt > Date.now()) {
    return PROJECT_FILE_CACHE.files;
  }
  const rgOutput = safeCommand("rg", ["--files"]);
  if (rgOutput.trim()) {
    const files = rgOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    PROJECT_FILE_CACHE.cwd = cwd;
    PROJECT_FILE_CACHE.files = files;
    PROJECT_FILE_CACHE.expiresAt = Date.now() + PROJECT_FILE_CACHE_TTL_MS;
    return files;
  }
  const files = [];
  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(process.cwd(), fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if ([".git", "node_modules", ".ajoullm"].includes(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      files.push(relPath);
    }
  }
  walk(process.cwd());
  PROJECT_FILE_CACHE.cwd = cwd;
  PROJECT_FILE_CACHE.files = files;
  PROJECT_FILE_CACHE.expiresAt = Date.now() + PROJECT_FILE_CACHE_TTL_MS;
  return files;
}

function isLikelyTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_FILE_EXTENSIONS.has(ext)) return true;
  const base = path.basename(filePath).toLowerCase();
  return base === "dockerfile" || !ext;
}

function isImageFile(filePath) {
  return IMAGE_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function readImageFileAsDataUrl(relPath) {
  const absPath = path.join(process.cwd(), relPath);
  try {
    if (!fs.statSync(absPath).isFile()) return null;
  } catch {
    return null;
  }
  const ext = path.extname(relPath).toLowerCase().slice(1);
  const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
  return `data:${mime};base64,${fs.readFileSync(absPath).toString("base64")}`;
}

const _fileContentCache = new Map();

function readTextFile(relPath, maxChars = 12000) {
  const absPath = path.join(process.cwd(), relPath);
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return "";
    const cached = _fileContentCache.get(relPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.content.slice(0, maxChars);
    const content = fs.readFileSync(absPath, "utf8").replace(/\0/g, "").slice(0, 50000);
    _fileContentCache.set(relPath, { content, mtimeMs: stat.mtimeMs });
    return content.slice(0, maxChars);
  } catch {
    return "";
  }
}

function writeWorkspaceFile(relPath, content) {
  const absPath = path.resolve(process.cwd(), relPath);
  const root = `${path.resolve(process.cwd())}${path.sep}`;
  if (!absPath.startsWith(root) && absPath !== path.resolve(process.cwd())) {
    fail(`Refusing to write outside workspace: ${relPath}`);
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf8");
  invalidateProjectFileCache();
}

function getFileStats(relPath) {
  const absPath = path.join(process.cwd(), relPath);
  const stat = fs.statSync(absPath);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

function matchGlob(pattern, filePath) {
  const re = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\x00").replace(/\*/g, "[^/]*").replace(/\x00/g, ".*").replace(/\?/g, "[^/]") + "$"
  );
  return re.test(filePath);
}

module.exports = {
  PROJECT_FILE_CACHE,
  ensureCacheDir, loadJsonFile, saveJsonFile,
  loadCache, saveCache, loadAgentSession, saveAgentSession,
  safeCommand, runShellCommand,
  invalidateProjectFileCache, listProjectFiles,
  isLikelyTextFile, isImageFile, readImageFileAsDataUrl,
  readTextFile, writeWorkspaceFile, getFileStats, matchGlob
};

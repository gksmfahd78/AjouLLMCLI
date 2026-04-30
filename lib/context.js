const path = require("path");
const { safeCommand, loadCache, saveCache, listProjectFiles, isLikelyTextFile, readTextFile, getFileStats } = require("./workspace");
const { runChatOnce } = require("./api");
const { UTILITY_MODEL } = require("./paths");

function detectSignals(relPath, content) {
  const lines = content.split(/\r?\n/);
  const notable = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      trimmed.startsWith("export ") || trimmed.startsWith("class ") || trimmed.startsWith("function ") ||
      trimmed.startsWith("def ") || trimmed.startsWith("async function ") || trimmed.startsWith("interface ") ||
      trimmed.startsWith("type ") || trimmed.startsWith("const ") || trimmed.startsWith("public ") || trimmed.startsWith("private ")
    ) {
      notable.push(trimmed);
    }
    if (notable.length >= 8) break;
  }
  return {
    relPath,
    lineCount: lines.length,
    importCount: (content.match(/\b(import|require\(|from )\b/g) || []).length,
    functionCount: (content.match(/\b(function|def|class|interface|type)\b/g) || []).length,
    notable
  };
}

function summarizeFile(relPath, content) {
  const signals = detectSignals(relPath, content);
  return {
    path: relPath,
    extension: path.extname(relPath).toLowerCase() || "(no extension)",
    lineCount: signals.lineCount,
    importCount: signals.importCount,
    symbolCount: signals.functionCount,
    summary: `${relPath} is a ${path.extname(relPath).toLowerCase() || "(no extension)"} file with ${signals.lineCount} lines and ${signals.functionCount} code symbols.`,
    notable: signals.notable,
    preview: signals.notable.slice(0, 3).join(" | ")
  };
}

function updateProjectCache() {
  const cache = loadCache();
  const files = listProjectFiles({ forceRefresh: true });
  const nextFiles = {};
  let textFiles = 0;
  let changed = false;
  for (const relPath of files) {
    if (!isLikelyTextFile(relPath)) continue;
    textFiles += 1;
    const stats = getFileStats(relPath);
    const previous = cache.files?.[relPath];
    if (previous && previous.mtimeMs === stats.mtimeMs && previous.size === stats.size) {
      nextFiles[relPath] = previous;
    } else {
      nextFiles[relPath] = { ...summarizeFile(relPath, readTextFile(relPath)), ...stats };
      changed = true;
    }
  }
  const nextCache = {
    version: 1,
    updatedAt: cache.updatedAt || new Date().toISOString(),
    root: process.cwd(),
    files: nextFiles,
    scans: { totalFiles: files.length, textFiles }
  };
  if (changed || Object.keys(nextFiles).length !== Object.keys(cache.files || {}).length) {
    nextCache.updatedAt = new Date().toISOString();
    saveCache(nextCache);
  }
  return nextCache;
}

function tokenize(text) {
  return text.toLowerCase().split(/[^a-z0-9_./-]+/i).map((t) => t.trim()).filter((t) => t.length >= 2);
}

function scoreFile(taskTokens, entry) {
  const haystack = `${entry.path} ${entry.summary} ${entry.preview || ""} ${(entry.notable || []).join(" ")}`.toLowerCase();
  let score = 0;
  for (const token of taskTokens) {
    if (entry.path.toLowerCase().includes(token)) score += 6;
    if (haystack.includes(token)) score += 2;
  }
  if ([".js", ".ts", ".tsx", ".jsx", ".py", ".java", ".kt", ".go", ".rs", ".cs"].includes(entry.extension)) score += 2;
  if (entry.path.startsWith("bin/") || entry.path.startsWith("src/") || entry.path.startsWith("app/")) score += 2;
  if (entry.symbolCount > 0) score += 1;
  return score;
}

function rankFilesForTask(task, limit = 8) {
  const cache = updateProjectCache();
  const tokens = tokenize(task);
  const scored = Object.values(cache.files).map((entry) => ({ entry, score: scoreFile(tokens, entry) }));
  let ranked = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.symbolCount - a.entry.symbolCount || a.entry.path.localeCompare(b.entry.path))
    .slice(0, limit);
  if (ranked.length < Math.min(3, limit)) {
    const fallback = scored
      .filter((item) => !ranked.some((picked) => picked.entry.path === item.entry.path))
      .sort((a, b) => {
        const aWeight = (a.entry.symbolCount > 0 ? 2 : 0) + (a.entry.path.startsWith("bin/") || a.entry.path.startsWith("src/") ? 2 : 0);
        const bWeight = (b.entry.symbolCount > 0 ? 2 : 0) + (b.entry.path.startsWith("bin/") || b.entry.path.startsWith("src/") ? 2 : 0);
        return bWeight - aWeight || b.entry.lineCount - a.entry.lineCount || a.entry.path.localeCompare(b.entry.path);
      })
      .slice(0, Math.min(3, limit) - ranked.length);
    ranked = ranked.concat(fallback);
  }
  return { cache, tokens, ranked };
}

function buildProjectOverview(cache) {
  const extensionCounts = {};
  for (const file of Object.values(cache.files)) {
    extensionCounts[file.extension] = (extensionCounts[file.extension] || 0) + 1;
  }
  const topExtensions = Object.entries(extensionCounts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([ext, count]) => `${ext}:${count}`).join(", ");
  return { totalIndexedFiles: Object.keys(cache.files).length, topExtensions, updatedAt: cache.updatedAt };
}

function getContextSnippets(ranked, maxChars = 14000) {
  const snippets = [];
  let used = 0;
  for (const item of ranked) {
    const content = readTextFile(item.entry.path, 5000);
    if (!content) continue;
    const snippet = `FILE: ${item.entry.path}\n${content.slice(0, 3500).trim()}\n`;
    if (used + snippet.length > maxChars) break;
    snippets.push(snippet);
    used += snippet.length;
  }
  return snippets;
}

function getGitContext() {
  const branch = safeCommand("git", ["branch", "--show-current"]).trim();
  const status = safeCommand("git", ["status", "--short"]).trim();
  const log = safeCommand("git", ["log", "--oneline", "-5"]).trim();
  if (!branch && !status && !log) return "";
  const parts = [];
  if (branch) parts.push(`Branch: ${branch}`);
  if (status) parts.push(`Git status:\n${status}`);
  if (log) parts.push(`Recent commits:\n${log}`);
  return parts.join("\n");
}

async function buildModelBackedPlan(task, result, config) {
  const overview = buildProjectOverview(result.cache);
  const fileSummaries = result.ranked.map((item) => `- ${item.entry.path}: ${item.entry.summary}`).join("\n");
  const snippets = getContextSnippets(result.ranked).join("\n---\n");
  const prompt = [
    "You are a coding agent planning a targeted code change.",
    "Return concise markdown with sections: Goal, Files, Plan, Risks, Verification.",
    `Task: ${task}`,
    `Project overview: indexedFiles=${overview.totalIndexedFiles}; topExtensions=${overview.topExtensions}; updatedAt=${overview.updatedAt}`,
    "Candidate files:",
    fileSummaries || "- none",
    "File snippets:",
    snippets || "(no snippets available)"
  ].join("\n\n");
  const planConfig = { ...config, model: UTILITY_MODEL, stream: false, systemPrompt: "You produce concrete code-edit plans for repository changes. Be concise and specific. Always respond in English." };
  const response = await runChatOnce(planConfig, prompt);
  return response.text || JSON.stringify(response.raw, null, 2);
}

function buildOfflinePlan(task, result) {
  const files = result.ranked.map((item) => item.entry.path);
  return [
    `Task: ${task}`,
    "",
    "Likely files to inspect:",
    ...(files.length ? files.map((file) => `- ${file}`) : ["- No high-confidence files found."]),
    "",
    "Suggested steps:",
    "- Confirm the failing behavior and reproduction path.",
    "- Read the top-ranked files and locate the change boundary.",
    "- Update the smallest set of files possible.",
    "- Run targeted verification after editing.",
    "",
    "Verification:",
    "- Run the narrowest relevant test, build, or reproduction command."
  ].join("\n");
}

module.exports = {
  detectSignals, summarizeFile, updateProjectCache,
  tokenize, scoreFile, rankFilesForTask,
  buildProjectOverview, getContextSnippets, getGitContext,
  buildModelBackedPlan, buildOfflinePlan
};

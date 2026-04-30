const fs = require("fs");
const path = require("path");
const { readTextFile, writeWorkspaceFile, listProjectFiles, matchGlob, runShellCommand, safeCommand, invalidateProjectFileCache } = require("./workspace");
const { requestJson, createHeaders, runChatOnce, buildInternalReviewFromMessages, FINAL_REASONING_PROMPT } = require("./api");
const { getContextSnippets, buildProjectOverview } = require("./context");
const { color } = require("./render");

const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write or create a file with the given content",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace an exact string in a file with a new string",
      parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["path", "old_string", "new_string"] }
    }
  },
  {
    type: "function",
    function: {
      name: "run_bash",
      description: "Run a shell command and return stdout/stderr",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files in the project, optionally filtered by glob pattern",
      parameters: { type: "object", properties: { pattern: { type: "string", description: "Optional glob pattern e.g. src/**/*.ts" } }, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search file contents for a regex pattern",
      parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: "Optional file or directory to search in" } }, required: ["pattern"] }
    }
  }
];

const PERMISSION_REQUIRED = new Set(["write_file", "edit_file", "run_bash"]);

function executeAgentTool(name, args) {
  if (name === "read_file") {
    const content = readTextFile(args.path, 50000);
    if (!content && !fs.existsSync(path.join(process.cwd(), args.path))) {
      throw new Error(`File not found: ${args.path}`);
    }
    return content || "(empty file)";
  }
  if (name === "write_file") {
    writeWorkspaceFile(args.path, args.content);
    return `Written: ${args.path}`;
  }
  if (name === "edit_file") {
    const absPath = path.join(process.cwd(), args.path);
    if (!fs.existsSync(absPath)) throw new Error(`File not found: ${args.path}`);
    const original = fs.readFileSync(absPath, "utf8");
    if (!original.includes(args.old_string)) throw new Error(`String not found in ${args.path}`);
    const count = original.split(args.old_string).length - 1;
    if (count > 1) throw new Error(`edit_file: old_string matches ${count} locations in ${args.path}; provide more context to make it unique`);
    writeWorkspaceFile(args.path, original.replace(args.old_string, args.new_string));
    return `Edited: ${args.path}`;
  }
  if (name === "run_bash") {
    const result = runShellCommand(args.command);
    const out = [result.stdout.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
    return out || "(no output)";
  }
  if (name === "list_files") {
    const all = listProjectFiles();
    const filtered = args.pattern ? all.filter((f) => matchGlob(args.pattern, f)) : all;
    return filtered.join("\n") || "(no files)";
  }
  if (name === "search_files") {
    const searchIn = args.path || process.cwd();
    const absSearch = path.isAbsolute(searchIn) ? searchIn : path.join(process.cwd(), searchIn);
    const rgOut = safeCommand("rg", ["--line-number", "--no-heading", args.pattern, absSearch]);
    if (rgOut.trim()) return rgOut.trim();
    try {
      const re = new RegExp(args.pattern, "i");
      const results = [];
      const files = listProjectFiles();
      for (const f of files) {
        if (args.path && !f.startsWith(args.path.replace(/\\/g, "/"))) continue;
        const content = readTextFile(f, 20000);
        content.split("\n").forEach((line, i) => {
          if (re.test(line)) results.push(`${f}:${i + 1}: ${line.trim()}`);
        });
        if (results.length >= 50) break;
      }
      return results.join("\n") || "(no matches)";
    } catch {
      return "(invalid pattern)";
    }
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function runAgentLoop(config, messages, onEvent, onPermission, signal, maxIter = 20) {
  if (signal?.aborted) throw new Error("Interrupted");
  onEvent({ type: "review", model: "gpt-5.4-nano" });
  const reviewGuidance = await buildInternalReviewFromMessages(config, messages, signal);
  for (let iter = 0; iter < maxIter; iter++) {
    if (signal?.aborted) throw new Error("Interrupted");
    const firstMsg = messages[0];
    const hasSystemFirst = firstMsg?.role === "system";
    const body = {
      model: config.model,
      messages: [
        {
          role: "system",
          content: hasSystemFirst ? `${FINAL_REASONING_PROMPT}\n\n${firstMsg.content}` : FINAL_REASONING_PROMPT
        },
        ...(hasSystemFirst ? messages.slice(1) : messages),
        { role: "system", content: `Internal review guidance:\n${reviewGuidance}` }
      ],
      tools: AGENT_TOOLS,
      tool_choice: "auto",
      temperature: config.temperature,
      top_p: config.topP,
      max_tokens: Math.max(config.maxTokens, 4096)
    };
    const data = await requestJson(`${config.baseUrl}/chat/completions/`, {
      method: "POST",
      headers: createHeaders(config.apiKey),
      body: JSON.stringify(body),
      signal
    });
    const choice = data.choices?.[0];
    if (!choice) throw new Error("No response from model");
    const msg = choice.message;
    const toolCalls = msg.tool_calls;

    if ((choice.finish_reason === "tool_calls" || toolCalls?.length) && toolCalls?.length) {
      messages.push({ role: "assistant", content: msg.content || null, tool_calls: toolCalls });
      const results = new Map();

      const readOnly = toolCalls.filter((tc) => !PERMISSION_REQUIRED.has(tc.function.name));
      await Promise.all(readOnly.map(async (tc) => {
        let args; try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
        onEvent({ type: "tool_call", name: tc.function.name, args });
        try {
          const result = String(executeAgentTool(tc.function.name, args));
          onEvent({ type: "tool_result", name: tc.function.name, result });
          results.set(tc.id, result);
        } catch (err) {
          onEvent({ type: "tool_error", name: tc.function.name, error: err.message });
          results.set(tc.id, `Error: ${err.message}`);
        }
      }));

      for (const tc of toolCalls.filter((tc) => PERMISSION_REQUIRED.has(tc.function.name))) {
        let args; try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
        onEvent({ type: "tool_call", name: tc.function.name, args });
        if (tc.function.name === "edit_file" && args.path && args.old_string != null) {
          try {
            const absPath = path.join(process.cwd(), args.path);
            if (fs.existsSync(absPath)) {
              const original = fs.readFileSync(absPath, "utf8");
              onEvent({ type: "tool_diff", name: args.path, diff: generateDiff(original, original.replace(args.old_string, args.new_string)) });
            }
          } catch {}
        }
        if (onPermission) {
          const allowed = await onPermission(tc.function.name, args);
          if (!allowed) {
            onEvent({ type: "tool_denied", name: tc.function.name });
            results.set(tc.id, "User denied this action.");
            continue;
          }
        }
        try {
          const result = String(executeAgentTool(tc.function.name, args));
          onEvent({ type: "tool_result", name: tc.function.name, result });
          results.set(tc.id, result);
        } catch (err) {
          onEvent({ type: "tool_error", name: tc.function.name, error: err.message });
          results.set(tc.id, `Error: ${err.message}`);
        }
      }

      for (const tc of toolCalls) {
        messages.push({ role: "tool", tool_call_id: tc.id, content: results.get(tc.id) ?? "(no result)" });
      }
    } else {
      const text = typeof msg.content === "string" ? msg.content : (msg.content?.[0]?.text || "");
      onEvent({ type: "final", text, usage: data.usage });
      messages.push({ role: "assistant", content: text });
      return text;
    }
  }
  throw new Error("Agent exceeded maximum iterations (20)");
}

function generateDiff(oldContent, newContent) {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd] === newLines[newEnd]) { oldEnd--; newEnd--; }
  const ctx = 2;
  const fromLine = Math.max(0, start - ctx);
  const result = [];
  for (let i = fromLine; i < start; i++) result.push(color("2", `  ${oldLines[i]}`));
  for (let i = start; i <= oldEnd; i++) result.push(color("31", `- ${oldLines[i]}`));
  for (let i = start; i <= newEnd; i++) result.push(color("32", `+ ${newLines[i]}`));
  const toLine = Math.min(oldLines.length - 1, oldEnd + ctx);
  for (let i = oldEnd + 1; i <= toLine; i++) result.push(color("2", `  ${oldLines[i]}`));
  return result.join("\n");
}

async function buildAgentEdits(task, result, config) {
  const fileSummaries = result.ranked.map((item) => `- ${item.entry.path}: ${item.entry.summary}`).join("\n");
  const snippets = getContextSnippets(result.ranked, 18000).join("\n---\n");
  const prompt = [
    "You are a coding agent that edits files in a repository.",
    "Return valid JSON only. No markdown fences.",
    "Schema:",
    '{"summary":"string","plan":["string"],"edits":[{"path":"string","content":"full file content as utf-8 text","reason":"string"}]}',
    "Rules:",
    "- Only return files you want written.",
    "- Each edit must contain the full final file content.",
    "- Prefer editing existing files from the provided context.",
    "- Keep changes minimal and coherent.",
    `Task: ${task}`,
    "Candidate files:",
    fileSummaries || "- none",
    "Relevant file contents:",
    snippets || "(none)"
  ].join("\n\n");
  const agentConfig = {
    ...config,
    stream: false,
    maxTokens: Math.max(config.maxTokens, 8000),
    systemPrompt: "You are a careful software engineer. Output strict JSON only."
  };
  const response = await runChatOnce(agentConfig, prompt);
  const text = response.text || response.raw?.raw;
  if (!text) throw new Error("Model did not return editable content.");
  const stripped = text.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m, "$1").trim();
  try {
    return JSON.parse(stripped);
  } catch (error) {
    throw new Error(`Failed to parse model edit JSON: ${error.message}\n\nRaw response:\n${stripped.slice(0, 300)}`);
  }
}

async function buildAgentEditsWithRetry(task, result, config, onStatus, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (attempt > 1) onStatus?.(`Retry ${attempt}/${maxRetries}: ${lastError.message.split("\n")[0]}`);
    try {
      return await buildAgentEdits(task, result, config);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function applyAgentEdits(editSpec, dryRun) {
  const changedFiles = [];
  for (const edit of editSpec.edits || []) {
    if (!edit.path || typeof edit.content !== "string") continue;
    changedFiles.push(edit.path);
    if (!dryRun) writeWorkspaceFile(edit.path, edit.content);
  }
  return changedFiles;
}

module.exports = {
  AGENT_TOOLS, PERMISSION_REQUIRED,
  executeAgentTool, runAgentLoop, generateDiff,
  buildAgentEdits, buildAgentEditsWithRetry, applyAgentEdits
};

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { TUI_SESSION_PATH, SLASH_COMMANDS, UTILITY_MODEL } = require("./paths");
const { ensureCacheDir, writeWorkspaceFile, readTextFile, listProjectFiles, invalidateProjectFileCache, isImageFile, readImageFileAsDataUrl } = require("./workspace");
const { loadConfig, saveConfig, getRuntimeConfig } = require("./config");
const { requestJson, createHeaders, fetchCredits, runChatOnce, streamChatTui, buildUserContent } = require("./api");
const { rankFilesForTask, updateProjectCache, buildProjectOverview, getGitContext, buildModelBackedPlan, buildOfflinePlan } = require("./context");
const { runAgentLoop } = require("./agent");
const { renderTui, logTui, scheduleRender, scheduleRenderInput, inputBoxHeight, color, wrapLine } = require("./render");

function saveTuiSession(state) {
  try {
    ensureCacheDir();
    fs.writeFileSync(TUI_SESSION_PATH, JSON.stringify({
      savedAt: new Date().toISOString(),
      mode: state.mode,
      history: state.history,
      inputHistory: state.inputHistory
    }, null, 2), "utf8");
  } catch {}
}

function loadTuiSession() {
  try {
    if (!fs.existsSync(TUI_SESSION_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(TUI_SESSION_PATH, "utf8"));
    const age = Date.now() - new Date(data.savedAt).getTime();
    if (age > 7 * 24 * 60 * 60 * 1000) return null;
    return data;
  } catch { return null; }
}

function loadClaudeMd() {
  const candidates = [
    path.join(process.cwd(), "ajoullm.md"),
    path.join(process.cwd(), ".ajou", "ajoullm.md")
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try { return fs.readFileSync(p, "utf8").trim(); } catch {}
    }
  }
  return "";
}

function configWithInstructions(state) {
  if (!state.claudeMd) return state.config;
  const base = state.config.systemPrompt;
  return { ...state.config, systemPrompt: base ? `${base}\n\n${state.claudeMd}` : state.claudeMd };
}

function wordLeft(text, pos) {
  let i = pos;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}

function wordRight(text, pos) {
  let i = pos;
  while (i < text.length && !/\s/.test(text[i])) i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

function resolveAtMentions(text) {
  const textAttachments = [];
  const imageUrls = [];
  const imagePaths = [];
  const seen = new Set();
  const regex = /@([^\s@]+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const filePath = match[1];
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    if (isImageFile(filePath)) {
      const dataUrl = readImageFileAsDataUrl(filePath);
      if (dataUrl) { imageUrls.push(dataUrl); imagePaths.push(filePath); }
    } else {
      const content = readTextFile(filePath, 20000);
      if (content) textAttachments.push(`\nFile @${filePath}:\n\`\`\`\n${content}\n\`\`\``);
    }
  }
  const prompt = textAttachments.length ? `${text}\n${textAttachments.join("\n")}` : text;
  return { prompt, imageUrls, imagePaths };
}

function getTabCompletions(input, cursorPos) {
  const before = input.slice(0, cursorPos);
  const atMatch = before.match(/@(\S*)$/);
  if (atMatch) {
    const partial = atMatch[1];
    const files = listProjectFiles().filter((f) => f.toLowerCase().startsWith(partial.toLowerCase())).slice(0, 20);
    return { type: "file", partial, completions: files };
  }
  const slashMatch = before.match(/^\/(\w*)$/);
  if (slashMatch) {
    const partial = slashMatch[1];
    return { type: "command", partial, completions: SLASH_COMMANDS.filter((c) => c.startsWith(partial)) };
  }
  return null;
}

function applyTabCompletion(state, compData, completion) {
  const before = state.input.slice(0, state.cursorPos);
  const after = state.input.slice(state.cursorPos);
  const newBefore = before.slice(0, before.length - compData.partial.length) + completion;
  const suffix = compData.type === "command" ? " " : "";
  state.input = newBefore + suffix + after;
  state.cursorPos = newBefore.length + suffix.length;
}

async function compactHistory(state) {
  if (state.history.length < 4) {
    logTui(state, "system", "Nothing to compact (fewer than 4 messages).");
    return;
  }
  logTui(state, "system", "Compacting conversation...");
  renderTui(state);
  const transcript = state.history.map((m) => {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return `${m.role}: ${text.slice(0, 2000)}`;
  }).join("\n");
  const summaryConfig = { ...state.config, model: UTILITY_MODEL, stream: false, maxTokens: 2048, systemPrompt: "Summarize concisely in English only.", skipReview: true };
  try {
    const result = await runChatOnce(summaryConfig, `Summarize this conversation concisely, preserving all important context, decisions, and code snippets. Be brief but complete:\n\n${transcript}`);
    const summary = result.text;
    state.history = [
      { role: "user", content: `[Conversation summary]\n${summary}` },
      { role: "assistant", content: "Understood, I have the context from our previous conversation." }
    ];
    logTui(state, "system", `Compacted ${transcript.split("\n").length} messages → 2 messages.`);
  } catch (err) {
    logTui(state, "error", `Compact failed: ${err.message}`);
  }
}

async function initProject(state) {
  logTui(state, "system", "Scanning project...");
  renderTui(state);
  const cache = updateProjectCache();
  const overview = buildProjectOverview(cache);
  const gitCtx = getGitContext();
  const topFiles = Object.values(cache.files).sort((a, b) => b.symbolCount - a.symbolCount).slice(0, 8);
  const snippets = topFiles.map((f) => `File: ${f.path}\n${readTextFile(f.path, 1500).slice(0, 800)}`).join("\n---\n");
  const promptText = [
    "Analyze this project and generate a concise ajoullm.md file with:",
    "1. Project overview (1-2 sentences)",
    "2. Key architecture and structure",
    "3. Important conventions to follow",
    "4. Common tasks and how to approach them",
    `\nProject: ${overview.totalIndexedFiles} files, extensions: ${overview.topExtensions}`,
    gitCtx ? `\n${gitCtx}` : "",
    `\nKey files:\n${snippets}`,
    "\nOutput only the markdown content, no preamble. Max 150 lines."
  ].join("\n");
  try {
    const result = await runChatOnce(
      { ...state.config, model: UTILITY_MODEL, stream: false, maxTokens: 4096, systemPrompt: "You generate concise project documentation. Output only markdown in English." },
      promptText
    );
    writeWorkspaceFile("ajoullm.md", result.text);
    logTui(state, "system", "ajoullm.md generated.");
    logTui(state, "agent", result.text.slice(0, 600) + (result.text.length > 600 ? "\n..." : ""));
  } catch (err) {
    logTui(state, "error", `Init failed: ${err.message}`);
  }
}

async function executeTuiInput(state, line) {
  const prompt = line.trim();
  if (!prompt) return;

  if (prompt.startsWith("/")) {
    const [rawCommand, ...rest] = prompt.slice(1).split(" ");
    const command = rawCommand.toLowerCase();
    const value = rest.join(" ").trim();

    if (command === "help") {
      logTui(state, "system", "Commands: /mode chat|context|plan|edit|agent, /apikey <key>, /model NAME, /system TEXT, /stream on|off, /init, /compact, /undo, /export, /credits, /status, /models, /clear, /exit");
      return;
    }
    if (command === "init") {
      state.busy = true; renderTui(state);
      await initProject(state);
      state.claudeMd = loadClaudeMd();
      state.busy = false; return;
    }
    if (command === "undo") {
      const batch = state.undoStack.pop();
      if (!batch) { logTui(state, "system", "Nothing to undo."); return; }
      for (const { path: p, original } of batch) {
        const absPath = path.join(process.cwd(), p);
        if (original === null) {
          try { fs.unlinkSync(absPath); invalidateProjectFileCache(); } catch {}
        } else {
          writeWorkspaceFile(p, original);
        }
      }
      state.changeSummary = { count: batch.length, files: batch.map((b) => b.path), action: "Undo applied" };
      logTui(state, "system", `Undone: ${batch.map((b) => b.path).join(", ")}`);
      return;
    }
    if (command === "export") {
      const filename = value || `ajoullm-export-${Date.now()}.md`;
      const lines = state.history.map((m) => {
        const text = typeof m.content === "string" ? m.content
          : Array.isArray(m.content)
            ? m.content.filter((b) => b?.type === "text").map((b) => b.text || "").join("") +
              (m.content.some((b) => b?.type === "image_url") ? `\n\n[${m.content.filter((b) => b?.type === "image_url").length} image attachment(s)]` : "")
            : String(m.content);
        return `**${m.role}:**\n\n${text}`;
      }).join("\n\n---\n\n");
      fs.writeFileSync(path.join(process.cwd(), filename), lines, "utf8");
      logTui(state, "system", `Exported to ${filename}`);
      return;
    }
    if (command === "compact") {
      state.busy = true; renderTui(state);
      await compactHistory(state);
      state.busy = false; return;
    }
    if (command === "clear") {
      state.logs = []; state.history = []; state.inputHistory = []; state.lastFiles = []; state.changeSummary = null; state.lastUsage = null;
      logTui(state, "system", "Conversation and logs cleared.");
      saveTuiSession(state);
      return;
    }
    if (command === "mode") {
      if (!["chat", "context", "plan", "edit", "agent"].includes(value)) {
        logTui(state, "system", "Usage: /mode chat|context|plan|edit|agent"); return;
      }
      state.mode = value;
      logTui(state, "system", `mode=${state.mode}`); return;
    }
    if (command === "model") {
      if (!value) { logTui(state, "system", "Usage: /model NAME"); return; }
      state.config.model = value;
      saveConfig({ ...loadConfig(), model: value });
      logTui(state, "system", `model=${state.config.model} (saved)`); return;
    }
    if (command === "system") {
      state.config.systemPrompt = value;
      saveConfig({ ...loadConfig(), systemPrompt: value });
      logTui(state, "system", `systemPrompt=${state.config.systemPrompt || "(empty)"} (saved)`); return;
    }
    if (command === "stream") {
      if (!["on", "off"].includes(value)) { logTui(state, "system", "Usage: /stream on|off"); return; }
      state.config.stream = value === "on";
      saveConfig({ ...loadConfig(), stream: state.config.stream });
      logTui(state, "system", `stream=${state.config.stream} (saved)`); return;
    }
    if (command === "status") {
      logTui(state, "system", `mode=${state.mode}, model=${state.config.model}, review=${state.config.reviewModel}, fallback=${state.config.reviewFallback}, stream=${state.config.stream}, history=${state.history.length}`);
      return;
    }
    if (command === "models") {
      if (!state.config.apiKey) { logTui(state, "system", "No API key configured."); return; }
      const data = await requestJson(`${state.config.baseUrl}/models/`, {
        method: "GET",
        headers: createHeaders(state.config.apiKey, false)
      });
      const models = (Array.isArray(data.data) ? data.data : []).map((item) => item?.id).filter(Boolean);
      logTui(state, "system", models.length ? models.slice(0, 20).join("\n") : "No models returned.");
      return;
    }
    if (command === "apikey") {
      if (!value) { logTui(state, "system", "Usage: /apikey <key>"); return; }
      state.config.apiKey = value;
      saveConfig({ ...loadConfig(), apiKey: value });
      logTui(state, "system", `API key saved (${value.slice(0, 6)}...)`);
      return;
    }
    if (command === "credits") {
      if (!state.config.apiKey) { logTui(state, "system", "No API key. Use /apikey <key>."); return; }
      try {
        const data = await fetchCredits(state.config);
        state.credits = data;
        const t = data.total || data;
        const monthly = data.monthly_allocated;
        const renewal = monthly?.renewal_date ? ` (renewal: ${monthly.renewal_date.slice(0, 10)})` : "";
        logTui(state, "system", `credits: ${t.remaining} / ${t.quota} used ${t.used}${renewal}`);
      } catch (error) {
        logTui(state, "error", `Failed to fetch credits: ${error.message}`);
      }
      return;
    }
    if (command === "exit" || command === "quit") {
      state.shouldExit = true; return;
    }
    logTui(state, "system", `Unknown command: /${command}`);
    return;
  }

  logTui(state, "user", prompt);
  state.busy = true;
  renderTui(state);

  try {
    if (state.mode === "chat") {
      const { prompt: resolvedPrompt, imageUrls, imagePaths } = resolveAtMentions(prompt);
      if (imagePaths.length) logTui(state, "system", `Attaching ${imagePaths.length} image(s): ${imagePaths.join(", ")}`);
      const liveEntry = { role: "assistant", text: "Reviewing..." };
      state.logs.push(liveEntry);
      state.logSeq = (state.logSeq || 0) + 1;
      renderTui(state);
      state.liveStreaming = true;
      const ac = new AbortController();
      state.abortController = ac;
      let lastRender = 0;
      const fullText = await streamChatTui(configWithInstructions(state), state.history, resolvedPrompt, (accumulated) => {
        liveEntry.text = accumulated;
        const now = Date.now();
        if (now - lastRender >= 40) { lastRender = now; renderTui(state); }
      }, ac.signal, imageUrls);
      state.liveStreaming = false;
      state.abortController = null;
      liveEntry.text = fullText || liveEntry.text;
      state.logSeq = (state.logSeq || 0) + 1;
      state.history.push({ role: "user", content: buildUserContent(resolvedPrompt, imageUrls) });
      state.history.push({ role: "assistant", content: liveEntry.text });
      state.lastFiles = [];
      if ((state.history.length / 2) >= 40) {
        logTui(state, "system", "Context is very long. Auto-compacting...");
        renderTui(state);
        await compactHistory(state);
      }
    } else if (state.mode === "context") {
      const context = rankFilesForTask(prompt);
      state.lastFiles = context.ranked.map((item) => item.entry.path);
      if (context.ranked.length === 0) {
        logTui(state, "agent", "No related files found.");
      } else {
        logTui(state, "agent", context.ranked.map((item) => `${item.entry.path} [score=${item.score}]`).join("\n"));
      }
    } else if (state.mode === "plan") {
      const ranked = rankFilesForTask(prompt, 10);
      state.lastFiles = ranked.ranked.map((item) => item.entry.path);
      const plan = state.config.apiKey
        ? await buildModelBackedPlan(prompt, ranked, { ...configWithInstructions(state), stream: false })
        : buildOfflinePlan(prompt, ranked);
      logTui(state, "agent", plan);
    } else if (state.mode === "agent") {
      if (!state.config.apiKey) { logTui(state, "error", "No API key configured."); return; }
      const claudeMd = state.claudeMd;
      const gitCtx = getGitContext();
      const systemContent = [
        "You are an AI coding assistant. You have tools to read, write, edit files, run bash commands, list and search files in the project. Always read a file before editing it. Make minimal, targeted changes. After finishing, summarize what you did.",
        claudeMd ? `\n\nProject instructions (ajoullm.md):\n${claudeMd}` : "",
        gitCtx ? `\n\n${gitCtx}` : ""
      ].join("");
      const { prompt: resolvedPrompt, imageUrls, imagePaths } = resolveAtMentions(prompt);
      if (imagePaths.length) logTui(state, "system", `Attaching ${imagePaths.length} image(s): ${imagePaths.join(", ")}`);
      const agentMessages = [
        { role: "system", content: systemContent },
        ...state.history,
        { role: "user", content: buildUserContent(resolvedPrompt, imageUrls) }
      ];
      const ac = new AbortController();
      state.abortController = ac;
      const undoBatch = [];
      const permissionDesc = (toolName, args) => {
        if (toolName === "run_bash") return args.command || "";
        if (toolName === "write_file") return args.path || "";
        if (toolName === "edit_file") return args.path || "";
        return JSON.stringify(args).slice(0, 80);
      };
      const onPermission = (toolName, args) => {
        if (toolName === "write_file" || toolName === "edit_file") {
          const relPath = args.path || "";
          if (relPath && !undoBatch.some((entry) => entry.path === relPath)) {
            const absPath = path.join(process.cwd(), relPath);
            const original = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : null;
            undoBatch.push({ path: relPath, original });
          }
        }
        if (state.allowAll) return Promise.resolve(true);
        return new Promise((resolve) => {
          state.pendingPermission = { resolve, toolName, description: permissionDesc(toolName, args) };
          renderTui(state);
        });
      };
      let finalText = "";
      try {
        await runAgentLoop({ ...state.config, stream: false }, agentMessages, (event) => {
          if (event.type === "review") {
            logTui(state, "system", "Reviewing...");
            renderTui(state);
          } else if (event.type === "tool_call") {
            logTui(state, "agent", `[${event.name}] ${JSON.stringify(event.args).slice(0, 120)}`);
            renderTui(state);
          } else if (event.type === "tool_diff") {
            logTui(state, "agent", `diff: ${event.name}\n${event.diff}`);
            renderTui(state);
          } else if (event.type === "tool_result") {
            const preview = event.result.slice(0, 300);
            logTui(state, "agent", `→ ${preview}${event.result.length > 300 ? "\n  ..." : ""}`);
            renderTui(state);
          } else if (event.type === "tool_denied") {
            logTui(state, "system", `✗ denied: ${event.name}`); renderTui(state);
          } else if (event.type === "tool_error") {
            logTui(state, "error", `✗ ${event.name}: ${event.error}`); renderTui(state);
          } else if (event.type === "final") {
            finalText = event.text;
            if (event.usage) state.lastUsage = event.usage;
          }
        }, onPermission, ac.signal);
      } finally {
        state.abortController = null;
      }
      if (finalText) {
        logTui(state, "assistant", finalText);
        state.history.push({ role: "user", content: buildUserContent(resolvedPrompt, imageUrls) });
        state.history.push({ role: "assistant", content: finalText });
      }
      if (undoBatch.length > 0) {
        state.undoStack.push(undoBatch);
        if (state.undoStack.length > 10) state.undoStack.shift();
        state.changeSummary = { count: undoBatch.length, files: undoBatch.map((b) => b.path), action: "Review changes" };
        logTui(state, "system", `${undoBatch.length} file(s) changed. /undo to revert.`);
      }
      state.lastFiles = [];
      if ((state.history.length / 2) >= 40) {
        logTui(state, "system", "Context is very long. Auto-compacting...");
        renderTui(state);
        await compactHistory(state);
      }
    } else if (state.mode === "edit") {
      if (!state.config.apiKey) { logTui(state, "error", "No API key configured."); return; }
      const editClaudeMd = state.claudeMd;
      const editGitCtx = getGitContext();
      const editSystemContent = [
        "You are an AI coding assistant. You have tools to read, write, edit files, run bash commands, list and search files in the project. Always read a file before editing it. Make minimal, targeted changes. After finishing, summarize what you did.",
        editClaudeMd ? `\n\nProject instructions (ajoullm.md):\n${editClaudeMd}` : "",
        editGitCtx ? `\n\n${editGitCtx}` : ""
      ].join("");
      const { prompt: resolvedEditPrompt, imageUrls: editImageUrls, imagePaths: editImagePaths } = resolveAtMentions(prompt);
      if (editImagePaths.length) logTui(state, "system", `Attaching ${editImagePaths.length} image(s): ${editImagePaths.join(", ")}`);
      const editMessages = [
        { role: "system", content: editSystemContent },
        ...state.history,
        { role: "user", content: buildUserContent(resolvedEditPrompt, editImageUrls) }
      ];
      const editAc = new AbortController();
      state.abortController = editAc;
      const editUndoBatch = [];
      const onEditPermission = (toolName, args) => {
        if (toolName === "write_file" || toolName === "edit_file") {
          const relPath = args.path || "";
          if (relPath && !editUndoBatch.some((entry) => entry.path === relPath)) {
            const absPath = path.join(process.cwd(), relPath);
            const original = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : null;
            editUndoBatch.push({ path: relPath, original });
          }
        }
        return Promise.resolve(true);
      };
      let editFinalText = "";
      try {
        await runAgentLoop({ ...state.config, stream: false }, editMessages, (event) => {
          if (event.type === "review") {
            logTui(state, "system", "Reviewing..."); renderTui(state);
          } else if (event.type === "tool_call") {
            logTui(state, "agent", `[${event.name}] ${JSON.stringify(event.args).slice(0, 120)}`); renderTui(state);
          } else if (event.type === "tool_diff") {
            logTui(state, "agent", `diff: ${event.name}\n${event.diff}`); renderTui(state);
          } else if (event.type === "tool_result") {
            const preview = event.result.slice(0, 300);
            logTui(state, "agent", `→ ${preview}${event.result.length > 300 ? "\n  ..." : ""}`); renderTui(state);
          } else if (event.type === "tool_error") {
            logTui(state, "error", `✗ ${event.name}: ${event.error}`); renderTui(state);
          } else if (event.type === "final") {
            editFinalText = event.text;
            if (event.usage) state.lastUsage = event.usage;
          }
        }, onEditPermission, editAc.signal);
      } finally {
        state.abortController = null;
      }
      if (editFinalText) {
        logTui(state, "assistant", editFinalText);
        state.history.push({ role: "user", content: buildUserContent(resolvedEditPrompt, editImageUrls) });
        state.history.push({ role: "assistant", content: editFinalText });
      }
      if (editUndoBatch.length > 0) {
        state.undoStack.push(editUndoBatch);
        if (state.undoStack.length > 10) state.undoStack.shift();
        state.changeSummary = { count: editUndoBatch.length, files: editUndoBatch.map((b) => b.path), action: "Review changes" };
        state.lastFiles = editUndoBatch.map((b) => b.path);
        logTui(state, "system", `${editUndoBatch.length} file(s) changed. /undo to revert.`);
      }
      if ((state.history.length / 2) >= 40) {
        logTui(state, "system", "Context is very long. Auto-compacting...");
        renderTui(state);
        await compactHistory(state);
      }
    }
  } catch (error) {
    if (state.liveStreaming) {
      state.liveStreaming = false;
      state.logs.pop();
      state.logSeq = (state.logSeq || 0) + 1;
    }
    state.abortController = null;
    const msg = error.message || String(error);
    const hint = msg.includes("401") ? "\nInvalid or expired API key. Use /apikey <new-key> to update." : "";
    logTui(state, "error", msg + hint);
  } finally {
    state.busy = false;
  }
}

async function askForApiKey() {
  return new Promise((resolve) => {
    process.stdout.write("No API key configured.\nAPI Key: ");
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    let buf = "";
    const onData = (chunk) => {
      buf += chunk;
      if (buf.includes("\n")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(buf.split("\n")[0].trim());
      }
    };
    process.stdin.on("data", onData);
  });
}

async function promptLoop() {
  let config = getRuntimeConfig();

  if (!config.apiKey) {
    const key = await askForApiKey();
    if (!key) {
      console.error("[ajoullm] API key required. Run `ajoullm config set apiKey <key>`.");
      process.exit(1);
    }
    saveConfig({ ...loadConfig(), apiKey: key });
    config = { ...config, apiKey: key };
  }

  const _session = loadTuiSession();
  const _claudeMd = loadClaudeMd();
  const state = {
    config: { ...config, stream: false },
    history: _session?.history || [],
    claudeMd: _claudeMd,
    logs: (() => {
      const msgs = [
        { role: "system", text: "AjouLLM Studio started." },
        { role: "system", text: "Default mode is chat. Switch with /mode agent for file editing." },
        { role: "system", text: _claudeMd ? `ajoullm.md loaded from ${process.cwd()}` : "Tip: create ajoullm.md for project-specific instructions." }
      ];
      if (_session?.history?.length) msgs.push({ role: "system", text: `Session restored (${_session.history.length / 2 | 0} turns). /clear to reset.` });
      return msgs;
    })(),
    logSeq: 1,
    lastFiles: [],
    changeSummary: null,
    credits: null,
    lastUsage: null,
    scrollOffset: 0,
    input: "",
    cursorPos: 0,
    inputHistory: _session?.inputHistory || [],
    historyIndex: -1,
    inputBeforeBrowse: "",
    mode: "chat",
    busy: false,
    liveStreaming: false,
    abortController: null,
    pendingPermission: null,
    allowAll: false,
    undoStack: [],
    tabState: null,
    shouldExit: false
  };

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");

  let resolveExit;
  const exitPromise = new Promise((resolve) => { resolveExit = resolve; });

  const cleanup = () => {
    saveTuiSession(state);
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.removeListener("keypress", onKeypress);
    process.stdout.removeListener("resize", onResize);
    resolveExit();
  };

  const onResize = () => renderTui(state);
  const onKeypress = async (str, key) => {
    const resetTabState = () => { state.tabState = null; };

    if (state.pendingPermission) {
      if (str === "y" || str === "Y") {
        const { resolve } = state.pendingPermission;
        state.pendingPermission = null; resolve(true);
      } else if (str === "a" || str === "A") {
        const { resolve } = state.pendingPermission;
        state.pendingPermission = null; state.allowAll = true; resolve(true);
      } else if (str === "n" || str === "N" || key?.name === "escape") {
        const { resolve } = state.pendingPermission;
        state.pendingPermission = null; resolve(false);
      } else if (key?.ctrl && key.name === "c") {
        const { resolve } = state.pendingPermission;
        state.pendingPermission = null;
        resolve(false);
        if (state.abortController) state.abortController.abort();
      }
      renderTui(state); return;
    }
    if (state.busy) {
      if (key?.name === "escape" && state.abortController) {
        state.abortController.abort();
        logTui(state, "system", "Interrupted.");
      } else if (key?.ctrl && key.name === "c") {
        if (state.abortController) state.abortController.abort();
        state.shouldExit = true;
      }
      renderTui(state);
      if (state.shouldExit) cleanup();
      return;
    }
    if (key?.ctrl && key.name === "c") { state.shouldExit = true; cleanup(); return; }
    if ((key?.name === "return" && key?.shift) || (key?.ctrl && key.name === "n")) {
      resetTabState();
      state.input = state.input.slice(0, state.cursorPos) + "\n" + state.input.slice(state.cursorPos);
      state.cursorPos++;
      scheduleRenderInput(state); return;
    }
    if (key?.name === "return") {
      const current = state.input.trim();
      state.input = ""; state.cursorPos = 0; state.historyIndex = -1;
      resetTabState();
      if (current) state.inputHistory = [current, ...state.inputHistory.filter((h) => h !== current)].slice(0, 100);
      await executeTuiInput(state, current);
      renderTui(state);
      if (state.shouldExit) cleanup();
      return;
    }
    if (key?.name === "up") {
      if (state.inputHistory.length === 0) return;
      if (state.historyIndex === -1) state.inputBeforeBrowse = state.input;
      state.historyIndex = Math.min(state.historyIndex + 1, state.inputHistory.length - 1);
      state.input = state.inputHistory[state.historyIndex];
      state.cursorPos = state.input.length;
      resetTabState(); scheduleRenderInput(state); return;
    }
    if (key?.name === "down") {
      if (state.historyIndex === -1) return;
      state.historyIndex -= 1;
      state.input = state.historyIndex === -1 ? state.inputBeforeBrowse : state.inputHistory[state.historyIndex];
      state.cursorPos = state.input.length;
      resetTabState(); scheduleRenderInput(state); return;
    }
    if (key?.name === "pageup") {
      const logBodyHeight = Math.max(10, (process.stdout.rows || 32) - 5 - inputBoxHeight(state));
      state.scrollOffset += Math.max(5, logBodyHeight / 2 | 0);
      renderTui(state); return;
    }
    if (key?.name === "pagedown") {
      const logBodyHeight = Math.max(10, (process.stdout.rows || 32) - 5 - inputBoxHeight(state));
      state.scrollOffset = Math.max(0, state.scrollOffset - Math.max(5, logBodyHeight / 2 | 0));
      renderTui(state); return;
    }
    if (key?.ctrl && key.name === "left") { state.cursorPos = wordLeft(state.input, state.cursorPos); resetTabState(); scheduleRenderInput(state); return; }
    if (key?.ctrl && key.name === "right") { state.cursorPos = wordRight(state.input, state.cursorPos); resetTabState(); scheduleRenderInput(state); return; }
    if (key?.name === "left") { state.cursorPos = Math.max(0, state.cursorPos - 1); resetTabState(); scheduleRenderInput(state); return; }
    if (key?.name === "right") { state.cursorPos = Math.min(state.input.length, state.cursorPos + 1); resetTabState(); scheduleRenderInput(state); return; }
    if (key?.name === "home" || (key?.ctrl && key.name === "a")) { state.cursorPos = 0; resetTabState(); scheduleRenderInput(state); return; }
    if (key?.name === "end" || (key?.ctrl && key.name === "e")) { state.cursorPos = state.input.length; resetTabState(); scheduleRenderInput(state); return; }
    if (key?.name === "backspace") {
      if (state.cursorPos > 0) {
        state.input = state.input.slice(0, state.cursorPos - 1) + state.input.slice(state.cursorPos);
        state.cursorPos--;
      }
      resetTabState(); scheduleRenderInput(state); return;
    }
    if (key?.name === "delete") {
      if (state.cursorPos < state.input.length) {
        state.input = state.input.slice(0, state.cursorPos) + state.input.slice(state.cursorPos + 1);
      }
      resetTabState(); scheduleRenderInput(state); return;
    }
    if (key?.name === "escape") {
      state.input = ""; state.cursorPos = 0; state.historyIndex = -1;
      resetTabState(); scheduleRenderInput(state); return;
    }
    if (key?.name === "tab") {
      const existingTabState = state.tabState;
      const baseInput = existingTabState ? existingTabState.baseInput : state.input;
      const baseCursorPos = existingTabState ? existingTabState.baseCursorPos : state.cursorPos;
      const tabSeed = existingTabState || getTabCompletions(baseInput, baseCursorPos);
      if (!tabSeed || tabSeed.completions.length === 0) { resetTabState(); scheduleRenderInput(state); return; }
      const index = existingTabState ? (existingTabState.index + 1) % tabSeed.completions.length : 0;
      state.input = baseInput;
      state.cursorPos = baseCursorPos;
      applyTabCompletion(state, tabSeed, tabSeed.completions[index]);
      state.tabState = { ...tabSeed, baseInput, baseCursorPos, index };
      scheduleRenderInput(state); return;
    }
    if (typeof str === "string" && str >= " ") {
      if (state.historyIndex !== -1) { state.historyIndex = -1; state.inputBeforeBrowse = ""; }
      resetTabState();
      state.input = state.input.slice(0, state.cursorPos) + str + state.input.slice(state.cursorPos);
      state.cursorPos++;
      scheduleRenderInput(state);
    }
  };

  process.stdout.write("\x1b[?1049h\x1b[2J");
  process.stdout.on("resize", onResize);
  process.stdin.on("keypress", onKeypress);
  renderTui(state);

  if (config.apiKey) {
    fetchCredits(config).then((data) => { state.credits = data; renderTui(state); }).catch(() => {});
  }

  await exitPromise;
}

module.exports = { promptLoop, executeTuiInput, loadClaudeMd, saveTuiSession, loadTuiSession };

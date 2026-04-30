const { formatCredits } = require("./api");

const _logCache = { seq: -1, width: 0, lines: [], stableLines: [], stableCount: 0 };
let _renderTimer = null;

function charWidth(char) {
  const code = char.codePointAt(0);
  if (!code) return 1;
  if (
    (code >= 0x1100 && code <= 0x11FF) || (code >= 0x2E80 && code <= 0x303F) ||
    (code >= 0x3040 && code <= 0x33FF) || (code >= 0x3400 && code <= 0x4DBF) ||
    (code >= 0x4E00 && code <= 0xA4CF) || (code >= 0xA960 && code <= 0xA97F) ||
    (code >= 0xAC00 && code <= 0xD7FF) || (code >= 0xF900 && code <= 0xFAFF) ||
    (code >= 0xFE10 && code <= 0xFE6F) || (code >= 0xFF00 && code <= 0xFF60) ||
    (code >= 0xFFE0 && code <= 0xFFE6) || (code >= 0x1F300 && code <= 0x1F9FF) ||
    (code >= 0x20000 && code <= 0x3134F)
  ) return 2;
  return 1;
}

function dispWidth(str) {
  let w = 0;
  for (const ch of String(str ?? "")) w += charWidth(ch);
  return w;
}

function truncToWidth(str, maxW) {
  let out = "";
  let w = 0;
  for (const ch of str) {
    const cw = charWidth(ch);
    if (w + cw > maxW) break;
    out += ch;
    w += cw;
  }
  return { text: out, width: w };
}

function wrapLine(text, width) {
  const safeWidth = Math.max(10, width);
  const source = String(text ?? "").replace(/\r/g, "");
  const rawLines = source.split("\n");
  const output = [];
  for (const rawLine of rawLines) {
    if (!rawLine) { output.push(""); continue; }
    let remaining = rawLine;
    while (dispWidth(remaining) > safeWidth) {
      const { text: hardChunk } = truncToWidth(remaining, safeWidth);
      let breakAt = -1;
      for (let i = hardChunk.length - 1; i > 0; i -= 1) {
        if (/\s/.test(hardChunk[i])) {
          breakAt = i;
          break;
        }
      }
      const shouldSoftWrap = breakAt > Math.floor(hardChunk.length * 0.45);
      const chunk = shouldSoftWrap ? hardChunk.slice(0, breakAt).trimEnd() : hardChunk;
      output.push(chunk);
      remaining = shouldSoftWrap ? remaining.slice(breakAt).trimStart() : remaining.slice(hardChunk.length);
    }
    output.push(remaining);
  }
  return output;
}

function fitLine(text, width) {
  const value = String(text ?? "");
  const dw = dispWidth(value);
  if (dw >= width) return truncToWidth(value, width - 1).text + " ";
  return value + " ".repeat(width - dw);
}

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function renderMarkdown(text) {
  return text
    .replace(/^(#{1,6})\s+(.+)$/, (_, hashes, content) => color("1", content))
    .replace(/\*\*(.+?)\*\*/g, color("1", "$1"))
    .replace(/__(.+?)__/g, color("1", "$1"))
    .replace(/\*([^*\n]+?)\*/g, color("3", "$1"))
    .replace(/`([^`\n]+?)`/g, color("36", "$1"));
}

function stripAnsi(text) {
  return String(text ?? "").replace(/\x1b\[[0-9;]*m/g, "");
}

function stripToWidth(text, width) {
  return truncToWidth(stripAnsi(text), Math.max(1, width)).text;
}

function fitAnsiLine(text, width) {
  const plain = stripAnsi(text);
  const dw = dispWidth(plain);
  if (dw >= width) return stripToWidth(plain, width - 1) + " ";
  return `${text}${" ".repeat(width - dw)}`;
}

function makeBox(title, lines, width) {
  const innerWidth = Math.max(10, width - 2);
  const safeTitle = title ? ` ${title} ` : "";
  const titleDisplayWidth = dispWidth(stripAnsi(safeTitle));
  const topFill = "─".repeat(Math.max(0, innerWidth - titleDisplayWidth));
  const top = `┌${safeTitle}${topFill}┐`;
  const bottom = `└${"─".repeat(innerWidth)}┘`;
  const body = lines.map((line) => `│${fitAnsiLine(line, innerWidth)}│`);
  return [top, ...body, bottom];
}

function makeBoxAccent(title, lines, width, borderColor) {
  const innerWidth = Math.max(10, width - 2);
  const safeTitle = title ? ` ${title} ` : "";
  const titleDisplayWidth = dispWidth(stripAnsi(safeTitle));
  const fill = "─".repeat(Math.max(0, innerWidth - titleDisplayWidth));
  const top = color(borderColor, `┌${safeTitle}${fill}┐`);
  const bottom = color(borderColor, `└${"─".repeat(innerWidth)}┘`);
  const body = lines.map((line) => `${color(borderColor, "│")}${fitAnsiLine(line, innerWidth)}${color(borderColor, "│")}`);
  return [top, ...body, bottom];
}

function roleColor(role) {
  if (role === "user") return "36";
  if (role === "assistant") return "32";
  if (role === "agent") return "35";
  if (role === "error") return "31";
  return "33";
}

function roleLabel(role) {
  const labels = { user: "you", assistant: " ai", agent: "run", error: "err", system: "sys" };
  return labels[role] ?? role.slice(0, 3).padStart(3);
}

function renderMessageLines(text, width, useMarkdown) {
  const rawLines = wrapLine(text, width);
  const output = [];
  let inCode = false;
  for (const line of rawLines) {
    const stripped = stripAnsi(line).trim();
    if (stripped.startsWith("```")) {
      inCode = !inCode;
      output.push(color("2;36", line));
      continue;
    }
    if (inCode) {
      output.push(color("36", line));
    } else {
      output.push(useMarkdown ? renderMarkdown(line) : line);
    }
  }
  return output;
}

function renderInputWithCursor(text, pos) {
  const lines = text.split("\n");
  let rem = pos;
  return lines.map((line) => {
    if (rem < 0) return line;
    if (rem <= line.length) {
      const out = `${line.slice(0, rem)}\x1b[7m${line[rem] || " "}\x1b[0m${line.slice(rem + 1)}`;
      rem = -1;
      return out;
    }
    rem -= line.length + 1;
    return line;
  });
}

function inputBoxHeight(state) {
  const inputLines = state.input.split("\n");
  const commandBoxHeight = 2 + Math.min(5, inputLines.length) + 1 + (state.tabState?.completions?.length ? 1 : 0);
  const changeBoxHeight = state.changeSummary ? 4 : 0;
  return commandBoxHeight + changeBoxHeight;
}

function buildInputBox(state, width) {
  const boxes = [];
  if (state.changeSummary) {
    const files = state.changeSummary.files || [];
    const header = `${state.changeSummary.count} file(s) changed`;
    const detail = files.length ? files.slice(0, 3).join("  ") : "(none)";
    boxes.push(...makeBoxAccent("Changes", [
      color("1;32", header),
      `${color("2", state.changeSummary.action || "Review")}  ·  /undo to revert`,
      color("2", detail + (files.length > 3 ? `  +${files.length - 3} more` : ""))
    ], width, "32"));
  }
  if (state.pendingPermission) {
    const { toolName, description } = state.pendingPermission;
    boxes.push(...makeBoxAccent("Permission Required", [
      `${color("1;33", toolName)}  ${color("2", description)}`,
      `${color("32", "y")} allow  ·  ${color("32", "a")} allow all  ·  ${color("31", "n")} deny`
    ], width, "33"));
    return boxes;
  }
  const inputLines = renderInputWithCursor(state.input, state.cursorPos);
  const busyPrefix = state.busy ? color("1;33", "● ") : color("2", "  ");
  const contentLines = inputLines.map((l, i) => i === 0 ? `${busyPrefix}${l}` : `   ${l}`).slice(0, 5);
  const tabHint = state.tabState?.completions?.length
    ? color("2", `  tab ${state.tabState.index + 1}/${state.tabState.completions.length}:  ${state.tabState.completions.slice(0, 5).join("  ")}`)
    : null;
  const hintText = state.busy
    ? color("2", "  Esc interrupt  ·  Ctrl+C exit")
    : color("2", "  Enter  ·  Ctrl+N newline  ·  ↑↓ history  ·  ←→ cursor  ·  /help");
  boxes.push(...makeBox(color("2", "Input"), [
    ...contentLines,
    ...(tabHint ? [tabHint] : []),
    hintText
  ], width));
  return boxes;
}

function renderInputOnly(state) {
  if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }
  const width = Math.max(84, process.stdout.columns || 120);
  const height = Math.max(24, process.stdout.rows || 32);
  const ibh = inputBoxHeight(state);
  const logBodyHeight = Math.max(10, height - 5 - ibh);
  const startRow = logBodyHeight + 4;
  const lines = buildInputBox(state, width);
  process.stdout.write("\x1b[?25l");
  const blank = " ".repeat(width);
  for (let i = startRow; i <= height; i++) process.stdout.write(`\x1b[${i};1H${blank}`);
  for (let i = 0; i < lines.length; i++) process.stdout.write(`\x1b[${startRow + i};1H${lines[i]}`);
  process.stdout.write("\x1b[?25h");
}

function scheduleRender(state) {
  if (_renderTimer) return;
  _renderTimer = setTimeout(() => { _renderTimer = null; renderTui(state); }, 8);
}

const MODE_BAR_COLOR = {
  chat:    "1;37;44",
  agent:   "1;37;45",
  edit:    "1;30;43",
  plan:    "1;37;42",
  context: "1;37;46"
};

const MODE_ICON = {
  chat: "chat", agent: "agent", edit: "edit", plan: "plan", context: "ctx"
};

function renderTui(state) {
  if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }
  const width = Math.max(84, process.stdout.columns || 120);
  const height = Math.max(24, process.stdout.rows || 32);
  const leftWidth = Math.max(48, Math.floor(width * 0.68));
  const rightWidth = width - leftWidth - 1;

  const modeIcon = MODE_ICON[state.mode] ?? state.mode;
  const barColor = MODE_BAR_COLOR[state.mode] ?? "1;37;44";
  const busyStr = state.busy ? "  ● busy" : "";
  const topBarText = ` AjouLLM  [${modeIcon}]  ${state.config.model}${busyStr} `;
  const topBar = color(barColor, fitLine(topBarText, width));

  const ibh = inputBoxHeight(state);
  const logBodyHeight = Math.max(10, height - 5 - ibh);
  const sideBodyHeight = logBodyHeight;

  const useMarkdownRoles = new Set(["assistant", "agent"]);
  const needsFull = _logCache.seq !== state.logSeq || _logCache.width !== leftWidth;
  const canPartial = state.liveStreaming && _logCache.stableCount === state.logs.length - 1 && _logCache.width === leftWidth;

  if (needsFull || canPartial) {
    function renderEntry(entry) {
      const lbl = roleLabel(entry.role);
      const badge = color(roleColor(entry.role), lbl);
      const sep = color("2", " │ ");
      const contentLines = renderMessageLines(entry.text, leftWidth - 10, useMarkdownRoles.has(entry.role));
      const out = [];
      contentLines.forEach((line, index) => {
        out.push(index === 0 ? `${badge}${sep}${line}` : `   ${color("2", "│")} ${line}`);
      });
      out.push("");
      return out;
    }
    if (canPartial && !needsFull && state.logs.length > 0) {
      _logCache.lines = [..._logCache.stableLines, ...renderEntry(state.logs[state.logs.length - 1])];
    } else {
      _logCache.stableLines = [];
      _logCache.lines = [];
      for (let i = 0; i < state.logs.length; i++) {
        const lines = renderEntry(state.logs[i]);
        _logCache.lines.push(...lines);
        if (i < state.logs.length - 1) _logCache.stableLines.push(...lines);
      }
      _logCache.stableCount = Math.max(0, state.logs.length - 1);
      _logCache.seq = state.logSeq;
      _logCache.width = leftWidth;
    }
  }

  const totalLines = _logCache.lines.length;
  const maxScroll = Math.max(0, totalLines - logBodyHeight);
  const clampedOffset = Math.min(state.scrollOffset, maxScroll);
  if (state.scrollOffset !== clampedOffset) state.scrollOffset = clampedOffset;
  const end = clampedOffset > 0 ? -clampedOffset : undefined;
  const start = -(logBodyHeight + clampedOffset);
  const visibleLogs = _logCache.lines.slice(start, end);
  while (visibleLogs.length < logBodyHeight) visibleLogs.unshift("");

  const turns = (state.history.length / 2) | 0;
  const usageStr = state.lastUsage ? `${state.lastUsage.prompt_tokens}in / ${state.lastUsage.completion_tokens}out` : "─";
  const creditsStr = state.credits != null ? formatCredits(state.credits) : "(use /credits)";
  const turnWarn = turns >= 25 ? color("1;33", " !") : "";

  const statusLines = [
    color("2", "─── Session ─────────────────"),
    `  turns  ${color("2", "·")} ${turns}${turnWarn}`,
    `  mode   ${color("2", "·")} ${color(roleColor("user"), modeIcon)}`,
    `  model  ${color("2", "·")} ${color("2", state.config.model)}`,
    `  review ${color("2", "·")} ${color("2", state.config.reviewModel || "off")}`,
    `  fallback ${color("2", "·")} ${color("2", state.config.reviewFallback ? "on" : "off")}`,
    `  tokens ${color("2", "·")} ${color("2", usageStr)}`,
    `  credits ${color("2", "·")} ${color("2", creditsStr)}`,
    "",
    color("2", "─── System Prompt ────────────"),
  ];
  const sysText = state.config.systemPrompt || color("2", "(not set)");
  for (const line of wrapLine(sysText, rightWidth - 4).slice(0, 3)) statusLines.push(`  ${color("2", line)}`);
  statusLines.push("");
  statusLines.push(color("2", "─── Recent Files ─────────────"));
  if (state.lastFiles.length === 0) {
    statusLines.push(color("2", "  (none)"));
  } else {
    for (const file of state.lastFiles.slice(0, sideBodyHeight - statusLines.length - 3)) {
      statusLines.push(`  ${color("2", file)}`);
    }
  }
  while (statusLines.length < sideBodyHeight - 1) statusLines.push("");
  statusLines.push(color("2", "  /help"));

  const visibleStatus = statusLines.slice(0, sideBodyHeight);
  while (visibleStatus.length < sideBodyHeight) visibleStatus.push("");

  const scrollLabel = clampedOffset > 0 ? color("2", ` ↑${clampedOffset}`) : "";
  const leftBox = makeBox(`Conversation${scrollLabel}`, visibleLogs, leftWidth);
  const rightBox = makeBox("", visibleStatus, rightWidth);

  const combinedRows = [];
  for (let i = 0; i < Math.max(leftBox.length, rightBox.length); i += 1) {
    const left = leftBox[i] || " ".repeat(leftWidth);
    const right = rightBox[i] || " ".repeat(rightWidth);
    combinedRows.push(`${left} ${right}`);
  }

  const inputBox = buildInputBox(state, width);
  process.stdout.write("\x1b[?25l\x1b[H");
  process.stdout.write([topBar, ...combinedRows, ...inputBox].slice(0, height).join("\n"));
  process.stdout.write("\x1b[?25h");
}

function logTui(state, role, text) {
  state.logs.push({ role, text });
  if (state.logs.length > 200) state.logs = state.logs.slice(-200);
  state.logSeq = (state.logSeq || 0) + 1;
  state.scrollOffset = 0;
}

module.exports = {
  charWidth, dispWidth, truncToWidth, wrapLine, fitLine,
  color, renderMarkdown, stripAnsi, fitAnsiLine,
  makeBox, makeBoxAccent, roleColor, roleLabel,
  renderInputWithCursor, inputBoxHeight, buildInputBox,
  renderInputOnly, scheduleRender, renderTui, logTui
};

#!/usr/bin/env node

const { KNOWN_COMMANDS } = require("../lib/paths");
const { getRuntimeConfig } = require("../lib/config");
const { fail } = require("../lib/utils");
const { promptLoop } = require("../lib/tui");
const { readPromptFromStdin, mergeChatOverrides, handleChatCommand } = require("../lib/commands/chat");
const { handleConfigCommand } = require("../lib/commands/config");
const { handleCodeCommand } = require("../lib/commands/code");
const { handleAgentCommand } = require("../lib/commands/agent-cmd");
const { handleCreditsCommand, handleModelsCommand } = require("../lib/commands/credits");
const { runChatOnce } = require("../lib/api");

function parseArgs(argv) {
  const flags = new Set();
  const options = {};
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (["--stream", "--no-stream", "--plan", "--apply", "--resume", "--dry-run"].includes(arg)) {
      flags.add(arg); continue;
    }
    if (["--model", "--system", "--temperature", "--top-p", "--max-tokens", "--verify"].includes(arg)) {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) fail(`Missing value for ${arg}`);
      options[arg] = next;
      i += 1; continue;
    }
    values.push(arg);
  }
  return { flags, options, values };
}

function printHelp() {
  console.log(`AjouLLM CLI

Usage:
  ajoullm
  ajoullm "your prompt"
  ajoullm chat "your prompt"
  ajoullm code scan
  ajoullm code context "task"
  ajoullm code plan "task"
  ajoullm agent --plan "task"
  ajoullm agent --apply "task"
  ajoullm agent --resume
  ajoullm config init
  ajoullm config set <key> <value>
  ajoullm config show

Agent flags:
  --plan
  --apply
  --resume
  --dry-run
  --verify <command>

Code commands:
  scan
  context <task>
  plan <task>
  cache show
  cache clear

Config keys:
  apiKey, model, baseUrl, systemPrompt
  temperature, topP, maxTokens, stream

TUI commands:
  /help
  /mode chat|context|plan|edit|agent
  /apikey <key>
  /model <name>
  /system <text>
  /stream on|off
  /init  /compact  /undo  /export [file]
  /credits  /models  /status  /clear  /exit
`);
}

async function handleDefaultInvocation(argv) {
  const parsed = parseArgs(argv);
  const promptFromStdin = await readPromptFromStdin();
  const prompt = parsed.values.join(" ").trim() || promptFromStdin;
  if (!prompt && process.stdin.isTTY) {
    await promptLoop();
    return;
  }
  if (!prompt) fail('Missing prompt. Example: ajoullm "hello"');
  const config = mergeChatOverrides(getRuntimeConfig(), parsed.options, parsed.flags);
  const result = await runChatOnce(config, prompt);
  if (result.thinking) console.log(`[thinking]\n${result.thinking}\n`);
  if (result.text) {
    if (!config.stream) console.log(result.text);
    return;
  }
  console.log(JSON.stringify(result.raw, null, 2));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) { await handleDefaultInvocation([]); return; }
  if (command === "help" || command === "--help") { printHelp(); return; }
  if (command === "config") { await handleConfigCommand(rest); return; }
  if (command === "chat") { await handleChatCommand(rest, parseArgs); return; }
  if (command === "models") { await handleModelsCommand(); return; }
  if (command === "credits") { await handleCreditsCommand(); return; }
  if (command === "interactive") { await promptLoop(); return; }
  if (command === "code") { await handleCodeCommand(rest); return; }
  if (command === "agent") { await handleAgentCommand(rest, parseArgs); return; }
  await handleDefaultInvocation([command, ...rest]);
}

main().catch((error) => {
  fail(error.message || String(error));
});

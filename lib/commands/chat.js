const { getRuntimeConfig, parseNumber } = require("../config");
const { runChatOnce } = require("../api");
const { fail } = require("../utils");

function readPromptFromStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(""); return; }
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buffer += chunk; });
    process.stdin.on("end", () => { resolve(buffer.trim()); });
  });
}

function mergeChatOverrides(baseConfig, options, flags) {
  const next = { ...baseConfig };
  if (options["--model"]) next.model = options["--model"];
  if (options["--system"]) next.systemPrompt = options["--system"];
  if (options["--temperature"]) next.temperature = parseNumber(options["--temperature"], "temperature");
  if (options["--top-p"]) next.topP = parseNumber(options["--top-p"], "topP");
  if (options["--max-tokens"]) next.maxTokens = Math.trunc(parseNumber(options["--max-tokens"], "maxTokens"));
  if (flags.has("--stream")) next.stream = true;
  if (flags.has("--no-stream")) next.stream = false;
  return next;
}

async function handleChatCommand(args, parseArgs) {
  const parsed = parseArgs(args);
  const config = mergeChatOverrides(getRuntimeConfig(), parsed.options, parsed.flags);
  const promptFromArgs = parsed.values.join(" ").trim();
  const promptFromStdin = await readPromptFromStdin();
  const prompt = promptFromArgs || promptFromStdin;
  if (!prompt) fail('Missing prompt. Example: ajoullm "hello"');
  const result = await runChatOnce(config, prompt);
  if (result.thinking) console.log(`[thinking]\n${result.thinking}\n`);
  if (result.text) {
    if (!config.stream) console.log(result.text);
    return;
  }
  console.log(JSON.stringify(result.raw, null, 2));
}

module.exports = { readPromptFromStdin, mergeChatOverrides, handleChatCommand };

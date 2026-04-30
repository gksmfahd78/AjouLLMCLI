const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const api = require("../lib/api");
const render = require("../lib/render");

const root = path.resolve(__dirname, "..");

function listJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".ajoullm") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listJsFiles(fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(fullPath);
    }
  }
  return out;
}

function checkSyntax() {
  for (const file of listJsFiles(root)) {
    childProcess.execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
  }
}

function checkRenderWrapping() {
  const samples = [
    "1) 질문 답변 / 2) 글쓰기 / 3) 번역·맞춤법 / 4) 문제 해결 중에 원하시는 걸 골라서 말해주세요.",
    "This sentence should wrap at a useful word boundary instead of cutting words in the middle.",
    "https://example.com/really/long/path/that/should/not/bleed/into/the/next/panel",
    "\x1b[32mcolored ansi text that must still fit inside a fixed width box\x1b[0m"
  ];
  for (const sample of samples) {
    const lines = render.wrapLine(sample, 40);
    for (const line of lines) {
      const width = render.dispWidth(render.stripAnsi(line));
      if (width > 40) {
        throw new Error(`render.wrapLine exceeded width: ${width} > 40 for ${JSON.stringify(line)}`);
      }
    }
  }
  const englishLines = render.wrapLine(samples[1], 40);
  if (englishLines[0].endsWith("bounda")) {
    throw new Error("render.wrapLine did not prefer a word boundary");
  }
}

function checkApiConfig() {
  const original = process.env.AJOULLM_REQUEST_TIMEOUT_MS;
  delete process.env.AJOULLM_REQUEST_TIMEOUT_MS;
  if (api.getRequestTimeoutMs() !== 120000) {
    throw new Error("default request timeout should be 120000ms");
  }
  process.env.AJOULLM_REQUEST_TIMEOUT_MS = "5000";
  if (api.getRequestTimeoutMs() !== 5000) {
    throw new Error("AJOULLM_REQUEST_TIMEOUT_MS was not applied");
  }
  if (original === undefined) delete process.env.AJOULLM_REQUEST_TIMEOUT_MS;
  else process.env.AJOULLM_REQUEST_TIMEOUT_MS = original;
}

checkSyntax();
checkRenderWrapping();
checkApiConfig();
console.log("[check] ok");

const fs = require("fs");
const { CACHE_PATH } = require("../paths");
const { getRuntimeConfig } = require("../config");
const { updateProjectCache, rankFilesForTask, buildProjectOverview, buildModelBackedPlan, buildOfflinePlan } = require("../context");
const { invalidateProjectFileCache, loadCache } = require("../workspace");
const { fail } = require("../utils");

function printCodeScanSummary(cache) {
  const overview = buildProjectOverview(cache);
  console.log(`root: ${cache.root}`);
  console.log(`indexedFiles: ${overview.totalIndexedFiles}`);
  console.log(`topExtensions: ${overview.topExtensions || "(none)"}`);
  console.log(`cache: ${CACHE_PATH}`);
  console.log(`updatedAt: ${overview.updatedAt}`);
}

function printRankedContext(task, result) {
  console.log(`task: ${task}`);
  console.log(`tokens: ${result.tokens.join(", ") || "(none)"}`);
  console.log("related files:");
  if (result.ranked.length === 0) { console.log("(no related files found)"); return; }
  for (const item of result.ranked) {
    console.log(`- ${item.entry.path} [score=${item.score}]`);
    console.log(`  ${item.entry.summary}`);
    if (item.entry.preview) console.log(`  ${item.entry.preview}`);
  }
}

async function handleCodeCommand(args) {
  const [action, ...rest] = args;
  if (!action || action === "scan") {
    printCodeScanSummary(updateProjectCache()); return;
  }
  if (action === "cache") {
    const subAction = rest[0];
    if (subAction === "show") { console.log(JSON.stringify(loadCache(), null, 2)); return; }
    if (subAction === "clear") {
      if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH);
      invalidateProjectFileCache();
      console.log("[ajoullm] Code cache cleared"); return;
    }
    fail("Usage: ajoullm code cache <show|clear>");
  }
  const task = rest.join(" ").trim();
  if (!task) fail(`Usage: ajoullm code ${action} "your task"`);
  const result = rankFilesForTask(task);
  if (action === "context") { printRankedContext(task, result); return; }
  if (action === "plan") {
    const config = getRuntimeConfig();
    console.log(config.apiKey ? await buildModelBackedPlan(task, result, config) : buildOfflinePlan(task, result));
    return;
  }
  fail("Code command supports: scan, context, plan, cache");
}

module.exports = { printCodeScanSummary, printRankedContext, handleCodeCommand };

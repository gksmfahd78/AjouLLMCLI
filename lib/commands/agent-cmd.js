const { getRuntimeConfig } = require("../config");
const { loadAgentSession, saveAgentSession, runShellCommand } = require("../workspace");
const { rankFilesForTask, buildModelBackedPlan, buildOfflinePlan } = require("../context");
const { buildAgentEdits, applyAgentEdits } = require("../agent");
const { mergeChatOverrides } = require("./chat");
const { fail } = require("../utils");

function printAgentSession(session) {
  console.log(`task: ${session.task}`);
  console.log(`mode: ${session.mode}`);
  console.log(`updatedAt: ${session.updatedAt}`);
  if (session.verifyCommand) console.log(`verify: ${session.verifyCommand}`);
  if (Array.isArray(session.files) && session.files.length) {
    console.log("files:");
    for (const file of session.files) console.log(`- ${file}`);
  }
}

async function handleAgentCommand(args, parseArgs) {
  const parsed = parseArgs(args);
  const config = mergeChatOverrides(getRuntimeConfig(), parsed.options, parsed.flags);
  const mode = parsed.flags.has("--apply") ? "apply" : "plan";

  if (parsed.flags.has("--resume")) {
    const session = loadAgentSession();
    if (!session) fail("No saved agent session.");
    printAgentSession(session);
    return;
  }

  const task = parsed.values.join(" ").trim();
  if (!task) fail('Usage: ajoullm agent --plan "task" or ajoullm agent --apply "task"');

  const result = rankFilesForTask(task, 10);
  const session = {
    task,
    mode,
    updatedAt: new Date().toISOString(),
    files: result.ranked.map((item) => item.entry.path),
    verifyCommand: parsed.options["--verify"] || null
  };

  if (mode === "plan") {
    const plan = config.apiKey ? await buildModelBackedPlan(task, result, config) : buildOfflinePlan(task, result);
    session.plan = plan;
    saveAgentSession(session);
    console.log(plan);
    return;
  }

  if (!config.apiKey) fail("Missing API key. Use `ajoullm config set apiKey <key>` or `AJOULLM_API_KEY`.");
  const editSpec = await buildAgentEdits(task, result, config);
  session.plan = Array.isArray(editSpec.plan) ? editSpec.plan : [];
  session.summary = editSpec.summary || "";
  session.edits = (editSpec.edits || []).map((edit) => ({ path: edit.path, reason: edit.reason || "" }));
  saveAgentSession(session);

  console.log(`summary: ${session.summary || "(none)"}`);
  if (session.plan.length) {
    console.log("plan:");
    for (const step of session.plan) console.log(`- ${step}`);
  }
  if (session.edits.length) {
    console.log("edits:");
    for (const edit of session.edits) console.log(`- ${edit.path}${edit.reason ? ` :: ${edit.reason}` : ""}`);
  }

  const dryRun = parsed.flags.has("--dry-run");
  const changedFiles = applyAgentEdits(editSpec, dryRun);
  console.log(dryRun ? "dry-run: no files written" : "files written:");
  for (const file of changedFiles) console.log(`- ${file}`);

  if (parsed.options["--verify"]) {
    const verification = runShellCommand(parsed.options["--verify"]);
    console.log(`verify ok: ${verification.ok}`);
    if (verification.stdout.trim()) console.log(verification.stdout.trim());
    if (!verification.ok && verification.stderr.trim()) console.log(verification.stderr.trim());
  }
}

module.exports = { printAgentSession, handleAgentCommand };

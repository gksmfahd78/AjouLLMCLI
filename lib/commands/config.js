const { CONFIG_PATH, CONFIG_KEYS, DEFAULT_CONFIG } = require("../paths");
const { loadConfig, saveConfig, deleteConfig, normalizeConfigValue, redactConfig, getRuntimeConfig } = require("../config");
const { fail } = require("../utils");

async function handleConfigCommand(args) {
  const [action, key, ...rest] = args;
  const current = loadConfig();
  if (action === "show") {
    console.log(JSON.stringify(redactConfig(getRuntimeConfig()), null, 2)); return;
  }
  if (action === "path") {
    console.log(CONFIG_PATH); return;
  }
  if (action === "init") {
    saveConfig({ ...DEFAULT_CONFIG, ...current });
    console.log("[ajoullm] Config file initialized"); return;
  }
  if (action === "reset") {
    deleteConfig();
    console.log("[ajoullm] Config file removed"); return;
  }
  if (action === "unset") {
    if (!CONFIG_KEYS.includes(key)) fail(`Unknown config key: ${key}`);
    delete current[key];
    saveConfig(current);
    console.log(`[ajoullm] Removed ${key}`); return;
  }
  if (action !== "set") fail("Config command supports: init, set, unset, show, path, reset");
  const value = rest.join(" ").trim();
  if (!CONFIG_KEYS.includes(key) || !value) fail("Usage: ajoullm config set <key> <value>");
  current[key] = normalizeConfigValue(key, value);
  saveConfig(current);
  console.log(`[ajoullm] Saved ${key}`);
}

module.exports = { handleConfigCommand };

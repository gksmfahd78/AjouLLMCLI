const { getRuntimeConfig } = require("../config");
const { requestJson, createHeaders, fetchCredits, formatCredits } = require("../api");

async function handleCreditsCommand() {
  const config = getRuntimeConfig();
  const data = await fetchCredits(config);
  console.log(JSON.stringify(data, null, 2));
}

async function handleModelsCommand() {
  const config = getRuntimeConfig();
  const data = await requestJson(`${config.baseUrl}/models/`, {
    method: "GET",
    headers: createHeaders(config.apiKey, false)
  });
  for (const model of Array.isArray(data.data) ? data.data : []) {
    if (model?.id) console.log(model.id);
  }
}

module.exports = { handleCreditsCommand, handleModelsCommand, formatCredits };

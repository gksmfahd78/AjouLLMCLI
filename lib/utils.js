function fail(message, code = 1) {
  console.error(`[ajoullm] ${message}`);
  process.exit(code);
}

module.exports = { fail };

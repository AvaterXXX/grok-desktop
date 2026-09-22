async function restorePreferredModel(client, preferredModel) {
  if (!preferredModel || preferredModel === client.currentModelId) return;
  await client.setModel(preferredModel);
}

module.exports = { restorePreferredModel };

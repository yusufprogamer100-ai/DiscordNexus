const snipeCache = new Map();

module.exports = {
  add(guildId, channelId, entry) {
    const key = `${guildId}-${channelId}`;
    if (!snipeCache.has(key)) snipeCache.set(key, []);
    const arr = snipeCache.get(key);
    arr.unshift(entry);
    if (arr.length > 10) arr.pop();
  },

  get(guildId, channelId, userId = null) {
    const key = `${guildId}-${channelId}`;
    const arr = snipeCache.get(key) || [];
    if (!userId) return arr.slice(0, 10);
    return arr.filter(e => e.authorId === userId).slice(0, 10);
  },

  getAll(guildId, channelId) {
    return this.get(guildId, channelId);
  },

  clear(guildId, channelId) {
    const key = `${guildId}-${channelId}`;
    snipeCache.delete(key);
  },
};

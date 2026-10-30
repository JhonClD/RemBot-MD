const configuredPrefixes = (process.env.BOT_PREFIX || '/')
  .split(/[\s,]+/)
  .map((prefix) => prefix.trim())
  .filter(Boolean);

let activePrefixes = configuredPrefixes.length ? configuredPrefixes : ['/'];

export const prefix = {
  defaults: activePrefixes,
  async load() {
    return activePrefixes;
  },
  resolvePrefix() {
    return activePrefixes;
  },
  set(_botId, prefixes) {
    const next = (Array.isArray(prefixes) ? prefixes : [prefixes])
      .map((item) => String(item).trim())
      .filter(Boolean);
    activePrefixes = next.length ? next : ['/'];
    this.defaults = activePrefixes;
  },
  clear() {
    activePrefixes = configuredPrefixes.length ? configuredPrefixes : ['/'];
    this.defaults = activePrefixes;
  },
  invalidate() {}
};

export default { prefix };

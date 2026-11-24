// Prefijo único del bot: «`» (comilla invertida)
export const DEFAULT_PREFIX = '`';
const DEFAULT_PREFIXES = Object.freeze([DEFAULT_PREFIX]);

export const prefix = {
  get defaults() {
    return [...DEFAULT_PREFIXES];
  },
  get current() {
    return [...DEFAULT_PREFIXES];
  },
  async load() {
    return [...DEFAULT_PREFIXES];
  },
  resolvePrefix() {
    return [...DEFAULT_PREFIXES];
  },
  set() {
    return [...DEFAULT_PREFIXES];
  },
  clear() {},
  invalidate() {}
};

export default { prefix, DEFAULT_PREFIX };

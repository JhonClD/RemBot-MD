// Prefijo único del bot: «`» (comilla invertida) por defecto.
// Cambiable en caliente con `setprefix`; el valor activo vive en
// lib/system/botstore.js (un solo símbolo, sin letras ni espacios).
import { getPrefix, setPrefix } from './system/botstore.js';

export const DEFAULT_PREFIX = '`';
const DEFAULT_PREFIXES = Object.freeze([DEFAULT_PREFIX]);

export const prefix = {
  get defaults() {
    return [...DEFAULT_PREFIXES];
  },
  get current() {
    return [getPrefix()];
  },
  async load() {
    return [getPrefix()];
  },
  resolvePrefix() {
    return [getPrefix()];
  },
  set(value) {
    const result = setPrefix(value);
    return result.ok ? [result.prefix] : [getPrefix()];
  },
  clear() {},
  invalidate() {}
};

export default { prefix, DEFAULT_PREFIX };

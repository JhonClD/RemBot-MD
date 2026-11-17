// Prefijo predeterminado del bot: «.»
// Se puede cambiar (o agregar varios) con BOT_PREFIX en el archivo .env,
// separando cada prefijo por coma o espacio. Ejemplo: BOT_PREFIX=.,/
export const DEFAULT_PREFIX = '.';
const DEFAULT_PREFIXES = [DEFAULT_PREFIX];

const SEPARATORS = /[\s,]+/;

function parsePrefixList(raw) {
  const list = String(raw ?? '')
    .split(SEPARATORS)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(list)];
}

// Se lee en cada resolución para que el .env y los cambios en caliente
// (prefix.set / prefix.clear) siempre se reflejen al procesar mensajes.
function envPrefixes() {
  const configured = parsePrefixList(process.env.BOT_PREFIX);
  return configured.length ? configured : [...DEFAULT_PREFIXES];
}

let overridePrefixes = null;

export const prefix = {
  get defaults() {
    return overridePrefixes ? [...overridePrefixes] : envPrefixes();
  },
  get current() {
    return this.resolvePrefix();
  },
  async load() {
    return this.resolvePrefix();
  },
  resolvePrefix() {
    return overridePrefixes ? [...overridePrefixes] : envPrefixes();
  },
  set(_botId, prefixes) {
    const next = (Array.isArray(prefixes) ? prefixes : [prefixes])
      .flatMap((item) => parsePrefixList(item));
    overridePrefixes = next.length ? next : null;
  },
  clear() {
    overridePrefixes = null;
  },
  invalidate() {
    overridePrefixes = null;
  }
};

export default { prefix, DEFAULT_PREFIX };

// tagall.js — Menciona a todos los miembros del grupo. Autor: Jhon 𝗖𝗜𝗗.

const PAISES = {
  1: 'Estados Unidos/Canadá', 7: 'Rusia', 20: 'Egipto', 27: 'Sudáfrica',
  30: 'Grecia', 31: 'Países Bajos', 32: 'Bélgica', 33: 'Francia', 34: 'España',
  36: 'Hungría', 39: 'Italia', 40: 'Rumanía', 41: 'Suiza', 43: 'Austria',
  44: 'Reino Unido', 45: 'Dinamarca', 46: 'Suecia', 47: 'Noruega', 48: 'Polonia',
  49: 'Alemania', 51: 'Perú', 52: 'México', 53: 'Cuba', 54: 'Argentina',
  55: 'Brasil', 56: 'Chile', 57: 'Colombia', 58: 'Venezuela', 60: 'Malasia',
  61: 'Australia', 62: 'Indonesia', 63: 'Filipinas', 64: 'Nueva Zelanda',
  65: 'Singapur', 66: 'Tailandia', 81: 'Japón', 82: 'Corea del Sur',
  84: 'Vietnam', 86: 'China', 90: 'Turquía', 91: 'India', 92: 'Pakistán',
  94: 'Sri Lanka', 98: 'Irán', 212: 'Marruecos', 213: 'Argelia', 216: 'Túnez',
  218: 'Libia', 234: 'Nigeria', 237: 'Camerún', 254: 'Kenia', 255: 'Tanzania',
  351: 'Portugal', 353: 'Irlanda', 380: 'Ucrania', 385: 'Croacia',
  502: 'Guatemala', 503: 'El Salvador', 504: 'Honduras', 505: 'Nicaragua',
  506: 'Costa Rica', 507: 'Panamá', 591: 'Bolivia', 593: 'Ecuador',
  595: 'Paraguay', 598: 'Uruguay', 966: 'Arabia Saudita',
  971: 'Emiratos Árabes', 972: 'Israel', 974: 'Catar',
}

function countryName(digits) {
  for (let len = Math.min(digits.length, 4); len >= 1; len--) {
    if (PAISES[digits.slice(0, len)]) return PAISES[digits.slice(0, len)]
  }
  return 'país desconocido'
}

export default {
  command: ['todos', 'invocar', 'tagall'],
  category: 'group',
  description: 'Menciona a todos los miembros del grupo. Uso: tagall [mensaje] | tagall +51 [mensaje].',
  isAdmin: true,
  run: async ({ msg, sock, args, participants }) => {
    const prefixArg = args.find(a => /^\+\d{1,4}$/.test(a))
    const reasonArgs = args.filter(a => a !== prefixArg)
    const pesan = reasonArgs.join(' ')
    const memberJids = (participants || []).map(p => p.id).filter(Boolean)
    if (prefixArg) {
      const digits = prefixArg.replace('+', '')
      const pais = countryName(digits)
      const filtered = memberJids.filter(jid => jid.split('@')[0].startsWith(digits))
      if (!filtered.length) {
        return msg.reply(`No hay miembros con el prefijo +${digits} (${pais}) en este grupo.`)
      }
      const teks = `${pesan || 'Revivan'}\n\nMiembros: ${filtered.length}\nPaís: ${pais}\nSolicitado por: @${msg.sender.split('@')[0]}\n\n${filtered.map(jid => `@${jid.split('@')[0]}`).join('\n')}`
      return sock.sendMessage(msg.chat, { text: teks, mentions: [msg.sender, ...filtered] }, { quoted: msg })
    }
    const teks = `${pesan || 'Revivan'}\n\nMiembros: ${memberJids.length}\nSolicitado por: @${msg.sender.split('@')[0]}\n\n${memberJids.map(jid => `@${jid.split('@')[0]}`).join('\n')}`
    return sock.sendMessage(msg.chat, { text: teks, mentions: [msg.sender, ...memberJids] }, { quoted: msg })
  },
}

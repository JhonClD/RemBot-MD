// kick.js — Expulsa a un usuario del grupo. Autor: Jhon 𝗖𝗜𝗗.
// Corrige el bug de YukiBot (`global.owner + '@s.whatsapp.net'`):
// global.owner es un array, así que se normalizan todos sus números.
// La rama `inactive` usa el contador de mensajes del store: inactivo es
// quien no tiene mensajes contados en el grupo (el conteo solo existe
// desde que el handler lo cablea, no es un historial de 30 días).
import { getMessageCounts, getOwnerJid } from '../../lib/system/botstore.js'

const KICK_DELAY_MS = 3000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Base numérica de un JID (sin @s.whatsapp.net, sin :dispositivo).
function base(jid) {
  return String(jid || '').split('@')[0].split(':')[0]
}

// Bases numéricas de los dueños del bot (array global.owner + dueño guardado).
function ownerBases() {
  const raw = Array.isArray(global.owner) ? global.owner : (global.owner ? [global.owner] : [])
  const bases = new Set()
  for (const entry of raw) {
    const value = typeof entry === 'string' ? entry : (entry?.jid ?? entry?.number ?? '')
    const digits = base(value).replace(/\D/g, '')
    if (digits) bases.add(digits)
  }
  const stored = base(getOwnerJid()).replace(/\D/g, '')
  if (stored) bases.add(stored)
  return bases
}

function isProtected(jid, { botId, ownerGroup, owners }) {
  if (!jid) return true
  if (jid === botId || base(jid) === base(botId)) return true
  if (jid === ownerGroup || base(jid) === base(ownerGroup)) return true
  if (owners.has(base(jid).replace(/\D/g, ''))) return true
  return false
}

function isGroupAdmin(participant) {
  return participant?.admin === 'admin' || participant?.admin === 'superadmin'
}

// Expulsa una lista con pausa entre expulsiones. Devuelve { removed, errors }.
async function kickMany(sock, chat, jids) {
  let removed = 0
  const errors = []
  for (const jid of jids) {
    try {
      await sock.groupParticipantsUpdate(chat, [jid], 'remove')
      removed++
      await sleep(KICK_DELAY_MS)
    } catch (e) {
      errors.push(`@${jid.split('@')[0]}: ${e?.message || e}`)
    }
  }
  return { removed, errors }
}

function summary(removed, skipped, errors) {
  let res = `Proceso completado.\nUsuarios eliminados: ${removed}`
  if (skipped > 0) res += `\nUsuarios omitidos (admins o dueños): ${skipped}`
  if (errors.length > 0) res += `\nErrores: ${errors.length}\n${errors.join('\n')}`
  return res
}

export default {
  command: ['kick', 'ban', 'bang'],
  category: 'group',
  description: 'Expulsa a un usuario del grupo. Uso: kick @usuario | kick num +57 | kick listnum +57 | kick all | kick inactive | kick listinactive.',
  isAdmin: true,
  botAdmin: true,
  run: async ({ msg, sock, args, usedPrefix, command, groupMetadata, participants }) => {
    const ownerGroup = groupMetadata?.owner || `${msg.chat.split('-')[0]}@s.whatsapp.net`
    const owners = ownerBases()
    const botId = sock.decodeJid(sock.user.id)
    const guard = { botId, ownerGroup, owners }
    const list = participants || []

    if (args[0] === 'num' || args[0] === 'listnum') {
      if (!args[1]) {
        return msg.reply(`Ingresa el prefijo de un país.\nEjemplo: ${usedPrefix}${command} num +54`)
      }
      const prefix = args[1].replace(/[+]/g, '')
      const withPrefix = list.map(p => p.id).filter(jid => jid && jid !== botId && base(jid).startsWith(prefix))
      if (withPrefix.length === 0) {
        return msg.reply(`No hay ningún número con el prefijo +${prefix} en este grupo.`)
      }
      if (args[0] === 'listnum') {
        const numbers = withPrefix.map(jid => `@${jid.split('@')[0]}`)
        return sock.sendMessage(msg.chat, {
          text: `Usuarios con prefijo +${prefix} (${withPrefix.length}):\n\n${numbers.join('\n')}`,
          mentions: withPrefix,
        }, { quoted: msg })
      }
      const toKick = withPrefix.filter(jid => {
        const p = list.find(x => x.id === jid)
        if (!p || isGroupAdmin(p)) return false
        return !isProtected(jid, guard)
      })
      if (toKick.length === 0) {
        return msg.reply(`Hay usuarios con prefijo +${prefix}, pero todos son admins o dueños.`)
      }
      await msg.reply(`Eliminando usuarios con prefijo +${prefix} (${toKick.length} de ${withPrefix.length}).\nEl proceso tomará unos segundos...`)
      const { removed, errors } = await kickMany(sock, msg.chat, toKick)
      return msg.reply(summary(removed, withPrefix.length - toKick.length, errors))
    }

    if (args[0] === 'all') {
      const toKick = list
        .filter(p => p.id && !isGroupAdmin(p) && !isProtected(p.id, guard))
        .map(p => p.id)
      if (toKick.length === 0) {
        return msg.reply('No hay usuarios para eliminar (todos son admins o dueños).')
      }
      await msg.reply(`Eliminando todos los usuarios (${toKick.length}).\nEl proceso tomará unos segundos...`)
      const { removed, errors } = await kickMany(sock, msg.chat, toKick)
      return msg.reply(summary(removed, list.length - toKick.length, errors))
    }

    if (args[0] === 'inactive' || args[0] === 'listinactive') {
      const counts = getMessageCounts(msg.chat)
      const countedBases = new Set(Object.keys(counts).map(jid => base(jid)))
      const sider = list
        .filter(p => p.id && !isGroupAdmin(p) && !isProtected(p.id, guard))
        .filter(p => !countedBases.has(base(p.id)) && !countedBases.has(base(p.lid)))
        .map(p => p.id)
      if (sider.length === 0) {
        return msg.reply('Este grupo no tiene inactivos (todos tienen mensajes contados).')
      }
      if (args[0] === 'listinactive') {
        return sock.sendMessage(msg.chat, {
          text: `Usuarios inactivos (${sider.length}):\n\n${sider.map(jid => `@${jid.split('@')[0]}`).join('\n')}`,
          mentions: sider,
        }, { quoted: msg })
      }
      await msg.reply(`Eliminando inactivos (${sider.length}).\nEl proceso tomará unos segundos...`)
      const { removed, errors } = await kickMany(sock, msg.chat, sider)
      return msg.reply(summary(removed, 0, errors))
    }

    if (!msg.mentionedJid?.[0] && !msg.quoted) {
      return msg.reply(`Etiqueta o responde al mensaje de la persona que quieres eliminar.\n\nOpciones especiales:\n- ${usedPrefix}${command} num +57 — Eliminar usuarios con prefijo +57\n- ${usedPrefix}${command} listnum +56 — Listar usuarios con prefijo +56\n- ${usedPrefix}${command} all — Eliminar todos los usuarios\n- ${usedPrefix}${command} inactive — Eliminar usuarios inactivos\n- ${usedPrefix}${command} listinactive — Listar usuarios inactivos`)
    }
    const targetRaw = msg.mentionedJid?.[0] || msg.quoted.sender
    const userBase = base(targetRaw)
    const participant = list.find(p => base(p.id) === userBase || base(p.lid) === userBase)
    if (!participant) {
      return sock.sendMessage(msg.chat, {
        text: `@${userBase} ya no está en el grupo.`,
        mentions: [targetRaw],
      }, { quoted: msg })
    }
    const realJid = participant.id || targetRaw
    if (realJid === sock.decodeJid(sock.user.id)) return msg.reply('No puedo eliminar al bot del grupo.')
    if (realJid === ownerGroup) return msg.reply('No puedo eliminar al creador del grupo.')
    if (owners.has(base(realJid).replace(/\D/g, ''))) return msg.reply('No puedo eliminar al dueño del bot.')
    try {
      await sock.groupParticipantsUpdate(msg.chat, [realJid], 'remove')
      await sock.sendMessage(msg.chat, {
        text: `@${userBase} eliminado correctamente.`,
        mentions: [targetRaw],
      }, { quoted: msg })
    } catch (e) {
      return msg.reply(`No se pudo eliminar al usuario. Error: ${e?.message || e}`)
    }
  },
}

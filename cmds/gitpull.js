import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pullState = globalThis.__rembotGitPullState ??= { running: false }

async function runGit(args) {
  return execFileAsync('git', args, {
    cwd: REPO_ROOT,
    timeout: 60_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  })
}

function safeOutput(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s/@:]+(?::[^\s/@]*)?@/gi, 'https://[credenciales ocultas]@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[credencial oculta]')
    .trim()
    .slice(0, 3000)
}

async function finishReply({ msg, sock }, progress, text) {
  if (progress?.key && sock?.sendMessage) {
    try {
      await sock.sendMessage(msg.chat, { text, edit: progress.key })
      return
    } catch {}
  }
  await msg.reply(text)
}

export default {
  command: 'gitpull',
  category: 'owner',
  description: 'Actualiza el repositorio con git pull --ff-only (solo propietario; no reinicia el bot).',
  isOwner: true,
  run: async (context) => {
    const { msg, sock, isOwner } = context
    if (!isOwner) return msg.reply('⛔ Solo el dueño puede ejecutar este comando.')
    if (pullState.running) return msg.reply('⏳ Ya hay una actualización en curso.')

    pullState.running = true
    let progress = null
    try {
      try { progress = await msg.reply('⏳ Revisando el repositorio y buscando actualizaciones…') } catch {}

      const { stdout: status } = await runGit(['status', '--porcelain', '--untracked-files=no'])
      if (status.trim()) {
        const text = '⚠️ No ejecuté `git pull`: hay cambios locales en archivos rastreados. Guárdalos o haz un respaldo y vuelve a intentarlo.'
        await finishReply(context, progress, text)
        return
      }

      const { stdout, stderr } = await runGit(['pull', '--ff-only'])
      const output = safeOutput([stdout, stderr].filter(Boolean).join('\n'))
      const text = [
        '✅ `git pull --ff-only` terminó correctamente.',
        output || 'No había cambios nuevos.',
        'El comando no reinicia el bot ni instala dependencias; reinícialo manualmente si la actualización lo requiere.',
      ].join('\n\n')
      await finishReply(context, progress, text)
    } catch (error) {
      const detail = safeOutput(error?.stderr || error?.stdout || error?.message)
      const text = `❌ No se pudo actualizar el repositorio.${detail ? `\n\n${detail}` : ''}`
      await finishReply(context, progress, text)
    } finally {
      pullState.running = false
    }
  },
}

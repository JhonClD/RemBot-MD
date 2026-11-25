import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pullState = globalThis.__rembotGitPullState ??= { running: false }

const HEADING = '⚙️ ⟨ 𝗥𝗲𝗺 - 𝗨𝗣𝗗𝗔𝗧𝗘 ⟩'
const MAX_FILES_LISTED = 15
const MAX_COMMITS_LISTED = 10

// GIT_TERMINAL_PROMPT=0 evita que git se quede esperando usuario/clave
// en la terminal del servidor (ahí no hay nadie para escribirla).
async function runGit(args, timeout = 120_000) {
  return execFileAsync('git', args, {
    cwd: REPO_ROOT,
    timeout,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  })
}

function safeOutput(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s/@:]+(?::[^\s/@]*)?@/gi, 'https://[credenciales ocultas]@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[credencial oculta]')
    .trim()
    .slice(0, 3000)
}

function lines(value, limit) {
  const all = String(value || '').split('\n').map((line) => line.trim()).filter(Boolean)
  return { shown: all.slice(0, limit), total: all.length }
}

// `git status --porcelain` devuelve "XY ruta": hay que quitar los 3
// primeros caracteres ANTES de recortar espacios, si no se come letras.
function parseStatus(value, limit) {
  const all = String(value || '').split('\n').filter((line) => line.trim()).map((line) => line.slice(3).trim()).filter(Boolean)
  return { shown: all.slice(0, limit), total: all.length }
}

function parseArgs(args = []) {
  const flags = new Set(args.map((a) => String(a).toLowerCase()))
  return {
    check: flags.has('--check') || flags.has('--dry-run') || flags.has('check'),
    force: flags.has('--force') || flags.has('-f') || flags.has('force'),
    restart: flags.has('--restart') || flags.has('restart'),
    help: flags.has('--help') || flags.has('-h') || flags.has('help'),
  }
}

// Edita el mensaje de progreso; si WhatsApp no deja editar, manda uno nuevo.
async function finishReply({ msg, sock }, progress, text) {
  if (progress?.key && sock?.sendMessage) {
    try {
      await sock.sendMessage(msg.chat, { text, edit: progress.key })
      return
    } catch {}
  }
  if (typeof progress?.edit === 'function') {
    try { await progress.edit(text); return } catch {}
  }
  await msg.reply(text)
}

function classifyError(error) {
  const detail = safeOutput([error?.stderr, error?.stdout, error?.message].filter(Boolean).join('\n')).toLowerCase()
  if (/timed out|timeout|etimedout/.test(detail)) return { kind: 'timeout', detail }
  if (/could not resolve host|unable to connect|network is unreachable|connection timed out|failed to connect/.test(detail)) {
    return { kind: 'network', detail }
  }
  if (/authentication failed|permission denied|403|repository not found|invalid username or password/.test(detail)) {
    return { kind: 'auth', detail }
  }
  if (/not a git repository|not a git repo/.test(detail)) return { kind: 'nogit', detail }
  if (/no remote|does not appear to be a git repository|no such remote/.test(detail)) return { kind: 'noremote', detail }
  if (/no upstream|no tracking information|upstream branch/.test(detail)) return { kind: 'noupstream', detail }
  if (/not possible to fast-forward|diverged|have diverged|non-fast-forward/.test(detail)) return { kind: 'diverged', detail }
  if (/index\.lock|another git process|unable to create .*index\.lock/.test(detail)) return { kind: 'locked', detail }
  if (/merge conflict|conflict \(|automatic merge failed/.test(detail)) return { kind: 'conflict', detail }
  return { kind: 'generic', detail }
}

async function pathExists(p) {
  try { await fs.access(p); return true } catch { return false }
}

// La raíz real del repo y la carpeta bot/, válidas en los dos layouts:
// layout viejo: cmds/gitpull.js -> raíz = cmds/.. ; layout bot/:
// bot/cmds/gitpull.js -> raíz = bot/cmds/../..
async function detectRoots() {
  const cmdsDir = path.dirname(fileURLToPath(import.meta.url))
  const parent = path.resolve(cmdsDir, '..')
  if (path.basename(parent) === 'bot'
    && (await pathExists(path.join(parent, '..', 'start.js')) || await pathExists(path.join(parent, '..', '.git')))) {
    return { repoRoot: path.resolve(parent, '..'), botDir: parent }
  }
  return { repoRoot: parent, botDir: path.join(parent, 'bot') }
}

const REORG_ENTRIES = ['index.js', 'handler.js', 'settings.js', 'cmds', 'lib', 'assets', '.env.example']

async function moveEntry(src, dest) {
  const stat = await fs.stat(src)
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true })
    for (const entry of await fs.readdir(src)) {
      await moveEntry(path.join(src, entry), path.join(dest, entry))
    }
    await fs.rmdir(src)
  } else {
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.rename(src, dest)
  }
}

// Reorganiza el repo al layout bot/ (fix del glob de Pterodactyl: la raíz
// debe tener un solo .js: start.js). No usa la API del panel: el plugin ya
// corre dentro del bot, en el hosting, así que mueve los archivos
// directamente con fs. Mover el directorio cmds/ mientras el proceso corre
// es seguro: el módulo ya está cargado en memoria. Devuelve
// { needed, moved, patched }.
async function reorganizeLayout() {
  const { repoRoot, botDir } = await detectRoots()
  const moved = []
  const patched = []
  for (const name of REORG_ENTRIES) {
    const src = path.join(repoRoot, name)
    if (await pathExists(src)) {
      await moveEntry(src, path.join(botDir, name))
      moved.push(name)
    }
  }
  const startJs = path.join(repoRoot, 'start.js')
  if (!(await pathExists(startJs))) {
    await fs.writeFile(startJs, "process.chdir('./bot');\nawait import('./bot/index.js');\n")
    moved.push('start.js (creado)')
  }
  const pkgPath = path.join(repoRoot, 'package.json')
  if (await pathExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'))
      let changed = false
      if (pkg.main !== 'start.js') { pkg.main = 'start.js'; changed = true }
      const wantScripts = { start: 'node start.js', 'start:qr': 'node start.js --qr' }
      if (JSON.stringify(pkg.scripts) !== JSON.stringify(wantScripts)) { pkg.scripts = wantScripts; changed = true }
      if (pkg.imports) {
        for (const [key, value] of Object.entries(pkg.imports)) {
          if (typeof value === 'string' && value.startsWith('./') && !value.startsWith('./bot/')) {
            pkg.imports[key] = value.replace('./', './bot/', 1)
            changed = true
          }
        }
      }
      if (changed) {
        await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
        patched.push('package.json')
      }
    } catch {}
  }
  const pingPath = path.join(botDir, 'cmds', 'ping.js')
  if (await pathExists(pingPath)) {
    const text = await fs.readFile(pingPath, 'utf8')
    if (!text.includes('BOT_ROOT')) {
      const next = text
        .replace("const REPO_ROOT = path.resolve(__dirname, '..')",
          "const REPO_ROOT = path.resolve(__dirname, '..', '..')\nconst BOT_ROOT = path.resolve(__dirname, '..')")
        .replace("const IMAGE_PATH = path.join(REPO_ROOT, 'assets', 'rem-host.png')",
          "const IMAGE_PATH = path.join(BOT_ROOT, 'assets', 'rem-host.png')")
        .replace("const exifTempRoot = path.join(REPO_ROOT, 'lib', 'system', path.basename(tempRoot))",
          "const exifTempRoot = path.join(BOT_ROOT, 'lib', 'system', path.basename(tempRoot))")
      if (next !== text) {
        await fs.writeFile(pingPath, next)
        patched.push('cmds/ping.js')
      }
    }
  }
  const giPath = path.join(repoRoot, '.gitignore')
  if (await pathExists(giPath)) {
    const text = await fs.readFile(giPath, 'utf8')
    const next = text
      .replace(/^lib\/system\/tmp\/\*/m, 'bot/lib/system/tmp/*')
      .replace(/^lib\/system\/botstore\.json$/m, 'bot/lib/system/botstore.json')
    if (next !== text) {
      await fs.writeFile(giPath, next)
      patched.push('.gitignore')
    }
  }
  return { needed: moved.length > 0 || patched.length > 0, moved, patched }
}

// ¿El layout actual necesita reorganización? (archivos de código en la raíz
// o falta start.js). Se usa para el aviso en el mensaje de cambios locales.
async function layoutNeedsReorg() {
  try {
    const { repoRoot } = await detectRoots()
    if (!(await pathExists(path.join(repoRoot, 'start.js')))) return true
    for (const name of REORG_ENTRIES) {
      if (await pathExists(path.join(repoRoot, name))) return true
    }
    return false
  } catch { return false }
}

function reorgNote(result) {
  if (!result?.needed) return ''
  const parts = []
  if (result.moved.length) parts.push(`movido a \`bot/\`: ${result.moved.join(', ')}`)
  if (result.patched.length) parts.push(`ajustado: ${result.patched.join(', ')}`)
  return `\n\n📁 *Reorganización aplicada (fix glob Pterodactyl):* ${parts.join(' · ')}.\n_El próximo arranque usará el layout \`bot/\` con un solo \`.js\` en la raíz (\`start.js\`)._`
}

function errorText({ kind, detail }, { branch, remote }) {
  const base = `${HEADING}\n\n*[ ❌ ] No se pudo actualizar.*\n\n`
  switch (kind) {
    case 'timeout': return `${base}_El servidor tardó demasiado en responder a GitHub. Inténtalo de nuevo en un rato._`
    case 'network': return `${base}_Sin conexión a GitHub._\nRevisa el internet del servidor e inténtalo de nuevo.`
    case 'auth': return `${base}_GitHub rechazó la conexión al repositorio._\nRevisa el remoto (\`git remote -v\`) y que el repo siga siendo público o tenga acceso.`
    case 'nogit': return `${base}_Este directorio no es un repositorio git._\nReinstala el bot clonándolo de GitHub.`
    case 'noremote': return `${base}_No hay remoto configurado._\nConfigúralo con:\n\`git remote add origin ${remote || 'https://github.com/JhonClD/RemBot-MD.git'}\``
    case 'noupstream': return `${base}_La rama \`${branch || 'actual'}\` no tiene rama remota asociada._\nConfigúrala con:\n\`git branch --set-upstream-to=origin/${branch || 'main'} ${branch || 'main'}\``
    case 'diverged': return `${base}_Tu copia local y GitHub divergieron (hay commits en ambos lados)._ \nUsa *\`gitpull --force\`* solo si estás seguro de descartar tus cambios locales.`
    case 'locked': return `${base}_Otro proceso de git está usando el repositorio._\nEspera unos segundos y vuelve a intentarlo. Si persiste, borra \`.git/index.lock\`.`
    case 'conflict': return `${base}_El pull generó conflictos de fusión._\nResuélvelos a mano en el servidor o usa *\`gitpull --force\`* para descartar los cambios locales.`
    default: return detail ? `${base}\`\`\`\n${detail.slice(0, 800)}\n\`\`\`` : `${base}_Error desconocido. Revisa los registros del bot._`
  }
}

export default {
  command: ['gitpull', 'update', 'actualizar'],
  category: 'owner',
  description: 'Actualiza el bot desde GitHub y reorganiza el layout a bot/ (fix glob Pterodactyl) tras actualizar: `gitpull` (normal), `gitpull --check` (solo revisa), `gitpull --force` (descarta cambios locales), `gitpull --restart` (reinicia tras actualizar). Solo propietario.',
  isOwner: true,
  run: async (context) => {
    const { msg, sock, args = [], isOwner } = context
    if (!isOwner) return msg.reply('⛔ Solo el dueño puede ejecutar este comando.')
    if (pullState.running) return msg.reply('⏳ Ya hay una actualización en curso.')

    const opts = parseArgs(args)
    if (opts.help) {
      return msg.reply(
        `${HEADING}\n\n` +
        '*Uso:*\n' +
        '• `gitpull` — descarga y aplica los cambios (solo fast-forward)\n' +
        '• `gitpull --check` — solo revisa qué hay nuevo, sin tocar nada\n' +
        '• `gitpull --force` — descarta cambios locales y deja la copia igual a GitHub\n' +
        '• `gitpull --restart` — tras actualizar, reinicia el proceso (solo si usas pm2 o un supervisor; si lo corres con `node index.js` directo, el bot no vuelve solo)\n\n' +
        '_Tras cada actualización el plugin reorganiza el repo al layout `bot/` (mueve el código, crea `start.js` y ajusta `package.json`): así el próximo arranque no falla con el error del glob de Pterodactyl. Los plugins en \`cmds/\` se recargan solos al cambiar. Los cambios en \`index.js\`, \`handler.js\` o \`lib/\` necesitan reinicio._',
      )
    }

    pullState.running = true
    let progress = null
    try {
      try { progress = await msg.reply(`${HEADING}\n_⏳ Conectando con GitHub..._`) } catch {}

      // 1) ¿Es un repo git y en qué rama/remoto estamos?
      const inside = await runGit(['rev-parse', '--is-inside-work-tree']).catch((e) => { throw e })
      if (inside.stdout.trim() !== 'true') {
        await finishReply(context, progress, errorText({ kind: 'nogit', detail: '' }, {}))
        return
      }
      const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
      const remote = safeOutput((await runGit(['remote', 'get-url', 'origin']).catch(() => ({ stdout: '' }))).stdout)
      if (branch === 'HEAD') {
        await finishReply(context, progress, `${HEADING}\n\n*[ ❌ ] El repo está en estado detached HEAD.*\nCambia a la rama principal con \`git checkout main\` y vuelve a intentarlo.`)
        return
      }

      // 2) Traer lo nuevo de GitHub sin tocar los archivos todavía.
      await runGit(['fetch', '--prune', 'origin'])
      const upstream = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
        .then((r) => r.stdout.trim())
        .catch(() => '')
      if (!upstream) {
        await finishReply(context, progress, errorText({ kind: 'noupstream', detail: '' }, { branch, remote }))
        return
      }

      const counts = (await runGit(['rev-list', '--left-right', '--count', `HEAD...@{u}`])).stdout.trim().split(/\s+/)
      const ahead = Number(counts[0] || 0)
      const behind = Number(counts[1] || 0)
      const incoming = lines((await runGit(['log', '--oneline', `HEAD..@{u}`])).stdout, MAX_COMMITS_LISTED)
      const incomingFiles = lines((await runGit(['diff', '--name-only', `HEAD..@{u}`])).stdout, MAX_FILES_LISTED)

      const status = parseStatus((await runGit(['status', '--porcelain', '--untracked-files=no'])).stdout, MAX_FILES_LISTED)
      const dirty = status.total > 0

      // 3) Solo revisar, sin tocar nada.
      if (opts.check) {
        const state = behind === 0 && ahead === 0
          ? '✅ Ya estás al día con GitHub.'
          : behind > 0 && ahead === 0
            ? `⬇️ Hay *${behind}* commit(s) nuevo(s) en GitHub.`
            : ahead > 0 && behind === 0
              ? `⬆️ Tienes *${ahead}* commit(s) local(es) sin subir; GitHub no tiene nada nuevo.`
              : `⚠️ Tu copia y GitHub divergieron: *${ahead}* local(es) y *${behind}* remoto(s).`
        const commitsText = incoming.shown.length
          ? `\n\n*Lo nuevo:*\n${incoming.shown.map((c) => `• \`${c.replace(/`/g, "'")}\``).join('\n')}${incoming.total > incoming.shown.length ? `\n_...y ${incoming.total - incoming.shown.length} más._` : ''}`
          : ''
        const filesText = incomingFiles.shown.length
          ? `\n\n*Archivos que cambiarían (${incomingFiles.total}):*\n${incomingFiles.shown.map((f) => `• \`${f}\``).join('\n')}${incomingFiles.total > incomingFiles.shown.length ? `\n_...y ${incomingFiles.total - incomingFiles.shown.length} más._` : ''}`
          : ''
        const dirtyText = dirty
          ? `\n\n⚠️ *Cambios locales sin guardar (${status.total}):*\n${status.shown.map((f) => `• \`${f}\``).join('\n')}${status.total > status.shown.length ? `\n_...y ${status.total - status.shown.length} más._` : ''}\n_El pull normal se negará hasta guardarlos o usar \`--force\`._`
          : ''
        await finishReply(context, progress,
          `${HEADING}\n\n*Rama:* \`${branch}\` → \`${upstream}\`\n*Remoto:* \`${remote || 'sin remoto'}\`\n\n${state}${commitsText}${filesText}${dirtyText}`)
        return
      }

      // 4) Cambios locales: el pull normal se niega; --force los descarta.
      if (dirty && !opts.force) {
        const needsReorg = await layoutNeedsReorg().catch(() => false)
        const reorgHint = needsReorg
          ? `\n\n📁 _Si esos cambios son la reorganización a \`bot/\`, usa *\`gitpull --force\`*: el plugin la vuelve a aplicar solo después del reset._`
          : ''
        await finishReply(context, progress,
          `${HEADING}\n\n*[ ⚠️ ] No ejecuté \`git pull\`: hay cambios locales en archivos rastreados (${status.total}).*\n\n` +
          `${status.shown.map((f) => `*• ${f}*`).join('\n')}${status.total > status.shown.length ? `\n_...y ${status.total - status.shown.length} más._` : ''}\n\n` +
          `_Guárdalos con \`git stash\` o descártalos con *\`gitpull --force\`*._${reorgHint}`)
        return
      }

      // --force sin nada nuevo en GitHub: igual descarta lo local.
      if (opts.force && behind === 0 && (dirty || ahead > 0)) {
        await runGit(['reset', '--hard', '@{u}'])
        let reorg = null
        try { reorg = await reorganizeLayout() } catch {}
        await finishReply(context, progress, `${HEADING}\n\n*[ ✅ ] Copia local restaurada a GitHub.*\n\n_Se descartaron los cambios locales y los commits sin subir. No había nada nuevo que descargar en \`${branch}\`._${reorgNote(reorg)}`)
        if (opts.restart) {
          await msg.reply('🔁 Reiniciando el proceso en 2 segundos...').catch(() => {})
          setTimeout(() => process.exit(0), 2000)
        }
        return
      }

      if (behind === 0 && ahead === 0) {
        let reorg = null
        try { reorg = await reorganizeLayout() } catch {}
        await finishReply(context, progress, `${HEADING}\n✅ 𝗘𝗹 𝗯𝗼𝘁 𝘆𝗮 𝗲𝘀𝘁á 𝗮𝗰𝘁𝘂𝗮𝗹𝗶𝘇𝗮𝗱𝗼.\n_No hay cambios pendientes en \`${branch}\`._${reorgNote(reorg)}`)
        if (reorg?.needed && opts.restart) {
          await msg.reply('🔁 Reiniciando el proceso en 2 segundos...').catch(() => {})
          setTimeout(() => process.exit(0), 2000)
        }
        return
      }
      if (behind === 0 && ahead > 0) {
        await finishReply(context, progress, `${HEADING}\n\n⚠️ *No hay nada nuevo en GitHub, pero tienes ${ahead} commit(s) local(es) sin subir.*\n_Súbelos desde el servidor con \`git push\` o descártalos con \`gitpull --force\`._`)
        return
      }

      // 5) Aplicar la actualización.
      const oldHead = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
      if (opts.force) {
        await runGit(['reset', '--hard', '@{u}'])
      } else {
        await runGit(['pull', '--ff-only', '--no-rebase'])
      }
      const newHead = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
      const applied = lines((await runGit(['log', '--oneline', `${oldHead}..${newHead}`]).catch(() => ({ stdout: '' }))).stdout, MAX_COMMITS_LISTED)
      const changedNames = (await runGit(['diff', '--name-only', `${oldHead}..${newHead}`]).catch(() => ({ stdout: '' }))).stdout || ''
      const changed = lines(changedNames, MAX_FILES_LISTED)
      // Reorganizar el layout tras actualizar: el pull trae el layout viejo
      // de main y sin esto el próximo arranque fallaría con el error del glob.
      const notes = []
      let reorg = null
      let reorgError = ''
      try { reorg = await reorganizeLayout() } catch (error) { reorgError = safeOutput(error?.message).slice(0, 300) }
      if (reorg?.needed) notes.push('📁 *Layout reorganizado a `bot/`* (fix glob Pterodactyl): el próximo arranque usará `start.js`.')
      if (reorgError) notes.push(`⚠️ *La reorganización falló:* ${reorgError}. Revisa los archivos en el servidor.`)

      const needsInstall = /(^|\n)package\.json(\n|$)/.test(changedNames) || /(^|\n)package-lock\.json(\n|$)/.test(changedNames)
      const coreChanged = /(^|\n)(index\.js|handler\.js|settings\.js|lib\/)/.test(changedNames)
      const onlyPlugins = changed.total > 0 && changedNames.split('\n').filter(Boolean).every((f) => f.startsWith('cmds/'))

      const commitsText = applied.shown.length
        ? `\n\n*Aplicado (${applied.total}):*\n${applied.shown.map((c) => `• \`${c.replace(/`/g, "'")}\``).join('\n')}${applied.total > applied.shown.length ? `\n_...y ${applied.total - applied.shown.length} más._` : ''}`
        : ''
      if (needsInstall) notes.push('📦 *Cambió `package.json`*: corre `npm install` en el servidor antes de reiniciar.')
      if (coreChanged) notes.push('🔁 *Cambiaron archivos del núcleo* (`index.js` / `handler.js` / `lib/`): hay que reiniciar el bot para que apliquen.')
      else if (onlyPlugins) notes.push('♻️ Solo cambiaron plugins en `cmds/`: se recargan solos, sin reiniciar.')
      if (opts.force) notes.push('⚠️ Se descartaron los cambios locales.')

      const doneText = `${HEADING}\n\n*[ ✅ ] ${opts.force ? 'Actualización forzada aplicada.' : 'Actualización aplicada correctamente.'}*\n\n` +
        `*Rama:* \`${branch}\` · \`${oldHead.slice(0, 7)}\` → \`${newHead.slice(0, 7)}\`${commitsText}` +
        (notes.length ? `\n\n${notes.join('\n')}` : '') +
        reorgNote(reorg)

      await finishReply(context, progress, doneText)

      if (opts.restart) {
        await msg.reply('🔁 Reiniciando el proceso en 2 segundos...').catch(() => {})
        setTimeout(() => process.exit(0), 2000)
      }
    } catch (error) {
      const classified = classifyError(error)
      await finishReply(context, progress, errorText(classified, {})).catch(() => {})
    } finally {
      pullState.running = false
    }
  },
}

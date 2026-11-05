export default async function handler(sock, msg) {
  if (!msg?.message || msg.key?.remoteJid === 'status@broadcast') return;
  if (msg.fromMe && !msg.key?.participant && msg.isBot) return;

  const command = String(msg.command || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!command) return;

  const cmdData = global.comandos?.get(command);
  if (!cmdData) return;

  const ownerNumbers = (global.owner || []).map((number) => String(number).replace(/\D/g, '')).filter(Boolean);
  const ownerLids = String(process.env.BOT_OWNER_LID || '')
    .split(',')
    .map((number) => number.replace(/\D/g, ''))
    .filter(Boolean);
  const owners = ownerNumbers.map((number) => `${number}@s.whatsapp.net`);
  const sender = msg.sender || '';
  const senderCandidates = [
    sender,
    msg.key?.participant,
    msg.key?.remoteJid,
  ].filter(Boolean);
  const senderBases = senderCandidates.map((jid) => String(jid).split('@')[0].split(':')[0]);
  const isOwner = owners.includes(sender)
    || senderBases.some((base) => ownerNumbers.includes(base) || ownerLids.includes(base));
  if (cmdData.isOwner && !isOwner) return;

  let groupMetadata = null;
  let participants = [];
  let isAdmins = false;
  let isBotAdmins = false;

  if (msg.isGroup && (cmdData.isAdmin || cmdData.botAdmin)) {
    groupMetadata = await sock.groupMetadata(msg.chat).catch(() => null);
    participants = groupMetadata?.participants || [];
    const senderBase = sender.split('@')[0];
    const botBase = sock.user?.id?.split(':')[0];
    const admins = new Set(participants
      .filter((participant) => participant.admin === 'admin' || participant.admin === 'superadmin')
      .flatMap((participant) => [participant.id, participant.lid, participant.phoneNumber]
        .filter(Boolean)
        .map((jid) => jid.split('@')[0])));
    isAdmins = admins.has(senderBase);
    isBotAdmins = admins.has(botBase);
  }

  if (cmdData.isAdmin && !isAdmins) return;
  if (cmdData.botAdmin && !isBotAdmins) return;

  const args = Array.isArray(msg.args) ? msg.args : [];
  const usedPrefix = msg.usedPrefix || '';
  const text = args.join(' ');

  try {
    await cmdData.run({
      msg,
      sock,
      args,
      command,
      usedPrefix,
      text,
      groupMetadata,
      participants,
      isAdmins,
      isBotAdmins,
      isOwner,
      __dirname: global.plugins?.[cmdData.pluginKey]?.dirname
    });
  } catch (error) {
    console.error(`[command:${command}]`, error?.stack || error);
    await msg.reply?.('No se pudo completar el comando. Revisa los registros del bot.');
  }
}

import 'dotenv/config';

const ownerNumbers = (process.env.BOT_OWNER_NUMBER || '')
  .split(',')
  .map((number) => number.replace(/\D/g, ''))
  .filter(Boolean);

global.owner = ownerNumbers;
global.mods = [];
global.dev = 'RemBot-MD';
global.mess = {
  socket: 'Este comando solo puede ser ejecutado por un dispositivo autorizado.',
  admin: 'Este comando solo puede ser ejecutado por administradores del grupo.',
  botAdmin: 'El bot debe ser administrador del grupo para realizar esta acción.',
  nsfw: 'Los comandos para adultos están desactivados.',
  comandooff: 'Este comando está desactivado.'
};

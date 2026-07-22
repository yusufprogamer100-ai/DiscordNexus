const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');

function embed(title, desc, color = 0x2b2d31) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc).setTimestamp();
}

function smallEmbed(desc, color = 0x2b2d31) {
  return new EmbedBuilder().setColor(color).setDescription(desc).setTimestamp();
}

function errorEmbed(msg) {
  return smallEmbed(`\u274c ${msg}`, 0x2b2d31);
}

function checkPerms(member, perm) {
  if (!member) return false;
  if (perm === null || perm === undefined) return true;
  return member.permissions.has(perm);
}

function requirePerm(perm) {
  return async (interaction, _args, next) => {
    if (!interaction.member) return;
    if (!checkPerms(interaction.member, perm)) {
      if (interaction.isChatInputCommand()) {
        await interaction.reply({ embeds: [errorEmbed('You don\'t have permission to use this.')], ephemeral: true });
      }
      return false;
    }
    return next ? next() : true;
  };
}

function getTarget(interaction, args) {
  if (interaction.isChatInputCommand()) {
    return interaction.options.getUser('user');
  }
  const ref = interaction.channel?.messages?.cache?.get(interaction.message?.reference?.messageId);
  if (ref) return ref.author;
  const mention = interaction.mentions?.users?.first();
  if (mention) return mention;
  const id = args?.[1]?.replace(/[<@!>]/g, '');
  if (id && /^\d{17,19}$/.test(id)) return { id };
  return null;
}

function getTimeSeconds(str) {
  if (!str) return null;
  const m = str.match(/^(\d+)\s*(s|sec|m|min|h|d|w)$/i);
  if (!m) return null;
  const n = parseInt(m[1]);
  switch (m[2].toLowerCase()) {
    case 's': case 'sec': return n;
    case 'm': case 'min': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    case 'w': return n * 604800;
    default: return null;
  }
}

function timeLabel(sec) {
  if (sec >= 604800) return `${Math.round(sec / 604800)}w`;
  if (sec >= 86400) return `${Math.round(sec / 86400)}d`;
  if (sec >= 3600) return `${Math.round(sec / 3600)}h`;
  if (sec >= 60) return `${Math.round(sec / 60)}m`;
  return `${sec}s`;
}

function formatReason(reason) {
  return reason || 'No reason provided';
}

module.exports = { embed, smallEmbed, errorEmbed, checkPerms, requirePerm, getTarget, getTimeSeconds, timeLabel, formatReason };

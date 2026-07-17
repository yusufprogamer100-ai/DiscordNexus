const {
  Client, GatewayIntentBits, REST, Routes, ChannelType, PermissionFlagsBits,
  ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  AttachmentBuilder,
} = require('discord.js');

const { joinVoiceChannel, getVoiceConnection, entersState, VoiceConnectionStatus } = require('@discordjs/voice');

const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID || '1467153107837255734';
const CLIENT_ID = process.env.CLIENT_ID || '1526982043857059981';
const PREFIX = ',';
const OWNER_ID = process.env.OWNER_ID || '1451684769061535826';

const db = require('./src/db');
const snipe = require('./src/snipe');
const { embed, smallEmbed, errorEmbed, checkPerms, getTarget, getTimeSeconds, timeLabel, formatReason } = require('./src/helpers');
const { generateBanner } = require('./src/banner');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildInvites,
  ],
});

const cache = new Map();
const giveaways = new Map();
const pendingRules = new Map(); // userId -> true, waiting for next message to save as rules
const timers = new Map();
const ticketLocks = new Set(); // userId -> lock to prevent duplicate ticket channels

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ POLL HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function parseDuration(str) {
  if (!str) return null;
  const m = str.match(/^(\d+)\s*(s|sec|m|min|h|d|w)$/i);
  if (!m) return null;
  const n = parseInt(m[1]);
  switch (m[2].toLowerCase()) {
    case 's': case 'sec': return n * 1000;
    case 'm': case 'min': return n * 60000;
    case 'h': return n * 3600000;
    case 'd': return n * 86400000;
    case 'w': return n * 604800000;
    default: return null;
  }
}

function discordTimestamp(ts) {
  return `<t:${Math.floor(ts / 1000)}:R>`;
}

function buildBar(pct, w = 18) {
  const f = Math.round((pct / 100) * w);
  return 'â–ˆ'.repeat(Math.max(0, f)) + 'â–‘'.repeat(Math.max(0, w - f));
}

function buildPollEmbed(poll, authorName) {
  const total = poll.counts.reduce((a, b) => a + b, 0);
  const max = Math.max(...poll.counts, 1);
  const ended = poll.endsAt && poll.endsAt <= Date.now();
  const lines = poll.options.map((o, i) => {
    const v = poll.counts[i];
    const p = total === 0 ? 0 : Math.round((v / total) * 100);
    return `**${i + 1}** ${o}\n\`${buildBar((v / max) * 100)}\` **${v}** vote${v !== 1 ? 's' : ''} (${p}%)`;
  });
  const desc = [];
  if (ended) {
    const winner = total > 0 ? poll.options[poll.counts.indexOf(Math.max(...poll.counts))] : null;
    desc.push(`\uD83C\uDFC6 **Poll ended!**${winner ? ` Winner: **${winner}**` : ' No votes were cast.'}`);
  } else {
    if (poll.description) desc.push(`*${poll.description}*`, '');
    desc.push(`Choose an option below to cast or change your vote.`);
    if (poll.endsAt) desc.push(`\n\u23F1 Time remaining: ${discordTimestamp(poll.endsAt)}`);
  }
  desc.push('', ...lines);
  const title = ended ? `Poll Results \u2014 ${total} vote${total !== 1 ? 's' : ''}` : 'Script Selection Poll';
  return new EmbedBuilder()
    .setColor(0x2b2d31).setTitle(title).setDescription(desc.join('\n'))
    .setFooter({ text: `Created by ${authorName}` }).setTimestamp();
}

function savePoll(id, data) {
  db.prepare(`INSERT OR REPLACE INTO polls VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, data.guildId, data.channelId, JSON.stringify(data.options), JSON.stringify(data.counts),
      JSON.stringify([...data.voters.entries()]), data.authorId, data.endsAt || null, data.ping || null, data.createdBy || null, data.description || null);
}

function archivePoll(options, counts, guildId, createdBy) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return;
  const maxV = Math.max(...counts);
  const idx = counts.indexOf(maxV);
  db.prepare('INSERT INTO history (guild_id, options, counts, winner, total_votes, closed_at, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(guildId, JSON.stringify(options), JSON.stringify(counts), options[idx], total, new Date().toISOString(), createdBy || 'Unknown');
}

function loadPolls() {
  for (const r of db.prepare('SELECT * FROM polls').all()) {
    const data = {
      guildId: r.guild_id, channelId: r.channel_id, options: JSON.parse(r.options),
      counts: JSON.parse(r.counts), voters: new Map(JSON.parse(r.voters || '[]')),
      authorId: r.author_id, endsAt: r.ends_at, ping: r.ping, createdBy: r.created_by,
      description: r.description || null,
    };
    cache.set(r.message_id, data);
    if (data.endsAt) scheduleEnd(r.message_id, data);
  }
}

function scheduleEnd(id, data) {
  if (timers.has(id)) clearTimeout(timers.get(id));
  const remaining = data.endsAt - Date.now();
  if (remaining <= 0) { autoEndPoll(id, data); return; }
  timers.set(id, setTimeout(() => autoEndPoll(id, data), remaining));
}

async function autoEndPoll(id, data) {
  timers.delete(id); cache.delete(id);
  db.prepare('DELETE FROM polls WHERE message_id = ?').run(id);
  archivePoll(data.options, data.counts, data.guildId, data.createdBy);
  try {
    const guild = await client.guilds.fetch(data.guildId);
    const channel = await guild.channels.fetch(data.channelId);
    const msg = await channel.messages.fetch(id);
    const total = data.counts.reduce((a, b) => a + b, 0);
    let winner = null;
    if (total > 0) {
      const maxV = Math.max(...data.counts);
      const idx = data.counts.indexOf(maxV);
      winner = { name: data.options[idx], votes: maxV, total };
    }
    await msg.edit({ components: [], embeds: [buildPollEmbed(data, data.createdBy || 'Unknown')] });
    let announce = data.ping === 'everyone' ? '@everyone' : data.ping === 'here' ? '@here' : '';
    if (announce) announce += ' ';
    if (winner) {
      announce += `**Poll ended!** Winner: **${winner.name}** (${winner.votes}/${winner.total} votes)`;
    } else {
      announce += `**Poll ended!** No votes were cast.`;
    }
    await channel.send({ content: announce });
  } catch {}
}

async function notifySubscribers(pollData, pollUrl, guild) {
  for (const { user_id } of db.prepare('SELECT user_id FROM subscribers WHERE guild_id = ?').all(guild.id)) {
    try {
      const user = await client.users.fetch(user_id);
      await user.send({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('New Poll Created')
        .setDescription(`A new poll has started in **${guild.name}**!\n\n${pollData.options.map((o, i) => `**${i + 1}** ${o}`).join('\n')}\n\n[Jump to poll](${pollUrl})`)
        .setFooter({ text: `Cast your vote` }).setTimestamp()] });
    } catch {}
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ LOG & UTILITY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const LOG_TYPES = {
  MESSAGE_DELETE: 'message_delete',
  MESSAGE_EDIT: 'message_edit',
  MEMBER_JOIN: 'member_join',
  MEMBER_LEAVE: 'member_leave',
  MEMBER_BAN: 'member_ban',
  MEMBER_UNBAN: 'member_unban',
  MEMBER_ROLE: 'member_role',
  MEMBER_NICKNAME: 'member_nickname',
  MEMBER_TIMEOUT: 'member_timeout',
  VOICE: 'voice',
  CHANNEL_CREATE: 'channel_create',
  CHANNEL_DELETE: 'channel_delete',
  CHANNEL_UPDATE: 'channel_update',
  INVITE_CREATE: 'invite_create',
  INVITE_DELETE: 'invite_delete',
  EMOJI: 'emoji',
  BULK_DELETE: 'bulk_delete',
  MODERATION: 'moderation',
  MESSAGE_KEYWORD: 'message_keyword',
};

const LOG_NAMES = {
  message_delete: 'Deleted Messages',
  message_edit: 'Edited Messages',
  member_join: 'Member Joins',
  member_leave: 'Member Leaves',
  member_ban: 'Member Bans',
  member_unban: 'Member Unbans',
  member_role: 'Role Changes',
  member_nickname: 'Nickname Changes',
  member_timeout: 'Timeout/Mute Changes',
  voice: 'Voice Events',
  channel_create: 'Channel Created',
  channel_delete: 'Channel Deleted',
  channel_update: 'Channel Updated',
  invite_create: 'Invite Created',
  invite_delete: 'Invite Deleted',
  emoji: 'Emoji/Sticker Changes',
  bulk_delete: 'Bulk Message Delete',
  moderation: 'Moderation Actions',
  message_keyword: 'Keyword Triggers',
};

function ensureConfig(guildId) {
  db.prepare('INSERT OR IGNORE INTO config (guild_id) VALUES (?)').run(guildId);
}

function setConfig(guildId, column, value) {
  ensureConfig(guildId);
  db.prepare(`INSERT INTO config (guild_id, ${column}) VALUES (?,?) ON CONFLICT(guild_id) DO UPDATE SET ${column} = excluded.${column}`).run(guildId, value);
}

async function sendLog(guild, logType, embed) {
  const cfg = db.prepare('SELECT enabled, channel_id FROM log_settings WHERE guild_id = ? AND log_type = ?').get(guild.id, logType);
  if (cfg && !cfg.enabled) return;
  const channelId = cfg?.channel_id || db.prepare('SELECT log_channel_id FROM config WHERE guild_id = ?').get(guild.id)?.log_channel_id;
  if (!channelId) return;
  try {
    const channel = await guild.channels.fetch(channelId);
    await channel.send({ embeds: [embed.setTimestamp()] });
  } catch {}
}

async function sendModLog(guild, fields) {
  const e = new EmbedBuilder().setColor(0x2b2d31);
  for (const [name, value] of Object.entries(fields)) {
    e.addFields({ name, value: String(value), inline: true });
  }
  await sendLog(guild, LOG_TYPES.MODERATION, e);
}

const recentMessages = new Map();

function checkSpam(msg, maxMsgs = 5, windowSec = 4) {
  const key = `${msg.guild.id}-${msg.author.id}`;
  if (!recentMessages.has(key)) recentMessages.set(key, []);
  const arr = recentMessages.get(key);
  arr.push({ content: msg.content, time: Date.now() });
  const window = arr.filter(m => m.time > Date.now() - windowSec * 1000);
  recentMessages.set(key, window);
  return window.length >= maxMsgs;
}

function hasInvite(text) {
  return /(discord\.(gg|io|me|com\/invite)\/|discord\.com\/invite\/)[a-zA-Z0-9_\-]+/i.test(text);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ MODERATION HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function getMember(guild, userId) {
  try { return await guild.members.fetch(userId); } catch { return null; }
}

async function checkWarnLimit(guild, userId) {
  let ws = db.prepare('SELECT * FROM warn_settings WHERE guild_id = ?').get(guild.id);
  if (!ws) {
    db.prepare('INSERT INTO warn_settings (guild_id, max_warns, action, mute_duration) VALUES (?,5,\'kick\',\'1h\')').run(guild.id);
    ws = { max_warns: 5, action: 'kick', mute_duration: '1h' };
  }
  const count = db.prepare('SELECT COUNT(*) as c FROM warns WHERE guild_id = ? AND user_id = ?').get(guild.id, userId).c;
  if (count >= ws.max_warns) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;
    const action = ws.action || 'kick';
    try {
      if (action === 'kick') {
        await member.kick(`Warn limit reached (${ws.max_warns})`);
        await sendModLog(guild, { Action: 'Auto-Kick (Warn Limit)', User: member.user.tag, ID: userId, Warns: count, MaxWarns: ws.max_warns });
      } else if (action === 'ban') {
        await member.ban({ reason: `Warn limit reached (${ws.max_warns})` });
        await sendModLog(guild, { Action: 'Auto-Ban (Warn Limit)', User: member.user.tag, ID: userId, Warns: count, MaxWarns: ws.max_warns });
      } else if (action === 'mute') {
        const dur = getTimeSeconds(ws.mute_duration) || 3600;
        await member.timeout(dur * 1000, `Warn limit reached (${ws.max_warns})`);
        await sendModLog(guild, { Action: `Auto-Mute (Warn Limit)`, User: member.user.tag, ID: userId, Duration: timeLabel(dur), Warns: count, MaxWarns: ws.max_warns });
      }
      try { await member.send({ embeds: [smallEmbed(`You were automatically **${action}** in **${guild.name}** for reaching **${ws.max_warns}** warns.`)] }); } catch {}
    } catch (e) {
      console.error(`[WARN LIMIT] Failed to ${action} ${userId}: ${e.message}`);
      const logChanId = db.prepare('SELECT log_channel_id FROM config WHERE guild_id = ?').get(guild.id)?.log_channel_id;
      if (logChanId) {
        const chan = guild.channels.cache.get(logChanId);
        if (chan) chan.send({ embeds: [errorEmbed(`Failed to ${action} <@${userId}> (warn limit reached). Bot may lack permissions.`)] }).catch(() => {});
      }
    }
  }
}

async function unbanUser(guild, userId) {
  try { await guild.bans.remove(userId); return true; } catch { return false; }
}

async function applyMute(member, durationSec, reason) {
  try {
    await member.timeout(durationSec * 1000, reason);
    return true;
  } catch { return false; }
}

async function removeMute(member) {
  try { await member.timeout(null); return true; } catch { return false; }
}

function setTempBan(guildId, userId, endsAt, reason, modId) {
  db.prepare('INSERT OR REPLACE INTO tempbans VALUES (?,?,?,?,?)').run(guildId, userId, endsAt, reason || null, modId || null);
}

function removeTempBan(guildId, userId) {
  db.prepare('DELETE FROM tempbans WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
}

async function checkTempBans() {
  const now = Date.now();
  for (const r of db.prepare('SELECT * FROM tempbans WHERE ends_at <= ?').all(now)) {
    try {
      const guild = await client.guilds.fetch(r.guild_id);
      await unbanUser(guild, r.user_id);
      removeTempBan(r.guild_id, r.user_id);
      const logChannelId = db.prepare('SELECT log_channel_id FROM config WHERE guild_id = ?').get(r.guild_id)?.log_channel_id;
      if (logChannelId) {
        try {
          const logChan = await guild.channels.fetch(logChannelId);
          await logChan.send({ embeds: [smallEmbed(`\uD83D\uDD13 **${r.user_id}** has been automatically unbanned (temp ban expired).`)] });
        } catch {}
      }
    } catch {}
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ PREFIX COMMANDS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function parsePrefix(content) {
  if (!content.startsWith(PREFIX)) return null;
  const args = content.slice(PREFIX.length).split(/ +/);
  const cmd = args.shift().toLowerCase();
  return { cmd, args };
}

function getTargetFromMsg(msg, args) {
  if (msg.reference?.messageId) {
    const ref = msg.channel.messages.cache.get(msg.reference.messageId);
    if (ref) return ref.author;
  }
  const mention = msg.mentions?.users?.first();
  if (mention) return mention;
  const id = args?.[0]?.replace(/[<@!>]/g, '');
  if (id && /^\d{17,19}$/.test(id)) return { id };
  return null;
}

async function handlePrefix(msg) {
  if (msg.author.bot || !msg.guild) return;
  const parsed = parsePrefix(msg.content);
  if (!parsed) return;
  let { cmd, args } = parsed;
  const aliasMap = { b:'ban', k:'kick', m:'mute', tm:'tempmute', tb:'tempban', pb:'permban', w:'warn', t:'timeout', ut:'untimeout', um:'unmute', r:'role', cl:'clear', sm:'slowmode', n:'nuke', l:'lock', ul:'unlock', ub:'unban', d:'deafen', ud:'undeafen', dw:'deletewarn', ms:'muteds' };
  cmd = aliasMap[cmd] || cmd;
  const member = msg.member;
  const guild = msg.guild;

  const permError = (perm) => {
    if (!checkPerms(member, perm)) {
      return msg.reply({ embeds: [errorEmbed('You don\'t have permission to use this.')] });
    }
    return true;
  };

  const modError = (perm) => {
    if (!checkPerms(member, perm) && member.id !== msg.guild.ownerId) {
      msg.reply({ embeds: [errorEmbed('You don\'t have permission to use this.')] });
      return false;
    }
    return true;
  };

  const botError = (perm) => {
    if (!guild.members.me.permissions.has(perm)) {
      msg.reply({ embeds: [errorEmbed('Bot lacks `' + Object.keys(PermissionFlagsBits).find(k => PermissionFlagsBits[k] === perm) + '` permission for this action.')] });
      return false;
    }
    return true;
  };

  const roleHierarchyError = (targetMember) => {
    if (!targetMember) return false;
    if (targetMember.roles.highest.position >= guild.members.me.roles.highest.position && guild.ownerId !== guild.members.me.id) {
      msg.reply({ embeds: [errorEmbed('Bot cannot manage this user (role hierarchy).')] });
      return false;
    }
    if (targetMember.roles.highest.position >= member.roles.highest.position && member.id !== guild.ownerId) {
      msg.reply({ embeds: [errorEmbed('Cannot action someone with equal or higher role.')] });
      return false;
    }
    return true;
  };

  const durationError = (str, maxSec) => {
    if (!str) { msg.reply({ embeds: [errorEmbed('Provide a duration (e.g. 1h, 30m, 2d).')] }); return null; }
    const sec = getTimeSeconds(str);
    if (!sec || sec < 1) { msg.reply({ embeds: [errorEmbed('Invalid duration. Use e.g. 1h, 30m, 2d.')] }); return null; }
    if (sec > maxSec) { msg.reply({ embeds: [errorEmbed('Max duration is ' + timeLabel(maxSec) + '.')] }); return null; }
    return sec;
  };

  async function modTarget() {
    let user = getTargetFromMsg(msg, args);
    if (!user && msg.reference?.messageId) {
      try {
        const ref = await msg.channel.messages.fetch(msg.reference.messageId);
        if (ref) user = ref.author;
      } catch {}
    }
    if (!user) {
      await msg.reply({ embeds: [errorEmbed('User not found. Mention, reply, or provide an ID.')] });
      return null;
    }
    if (user.id) user = await client.users.fetch(user.id).catch(() => null);
    return user;
  }

  // â”€â”€ Warn â”€â”€
  if (cmd === 'warn') {
    if (!modError(PermissionFlagsBits.ModerateMembers)) return;
    if (member.id !== OWNER_ID) {
      const today = new Date(); today.setHours(0,0,0,0);
      const dailyCount = db.prepare('SELECT COUNT(*) as c FROM warns WHERE guild_id = ? AND moderator_id = ? AND created_at >= ?').get(guild.id, member.id, today.toISOString()).c;
      if (dailyCount >= 15) return msg.reply({ embeds: [errorEmbed('You have exceeded your daily warn limit (15/15)! Try again tomorrow.')] });
    }
    const target = await modTarget();
    if (!target) return;
    const reason = formatReason(args.slice(1).join(' ') || undefined);
    if (target.id === member.id) return msg.reply({ embeds: [errorEmbed('You cannot warn yourself.')] });
    if (target.id === client.user.id) return msg.reply({ embeds: [errorEmbed('You cannot warn me.')] });
    const tMember = await getMember(guild, target.id);
    if (tMember && !roleHierarchyError(tMember)) return;
    db.prepare('INSERT INTO warns (guild_id, user_id, moderator_id, reason, created_at) VALUES (?,?,?,?,?)').run(guild.id, target.id, member.id, reason, new Date().toISOString());
    const count = db.prepare('SELECT COUNT(*) as c FROM warns WHERE guild_id = ? AND user_id = ?').get(guild.id, target.id).c;
    await msg.reply({ embeds: [smallEmbed(`\u26A0 ${target.tag} has been warned. Reason: ${reason}\nTotal warns: ${count}`)] });
    await sendModLog(guild, { Action: 'Warn', User: target.tag, ID: target.id, Moderator: member.user.tag, Reason: reason, Warns: count });
    await checkWarnLimit(guild, target.id);
    return;
  }

  if (cmd === 'warns') {
    if (!modError(PermissionFlagsBits.ModerateMembers)) return;
    const target = getTargetFromMsg(msg, args) || member.user;
    const user = target.id ? await client.users.fetch(target.id).catch(() => null) : null;
    const rows = db.prepare('SELECT * FROM warns WHERE guild_id = ? AND user_id = ? ORDER BY id DESC').all(guild.id, (user || member).id);
    if (rows.length === 0) return msg.reply({ embeds: [smallEmbed(`No warns for ${(user || member).tag}.`)] });
    const lines = rows.map((r, i) => `**#${r.id}** \u2022 ${r.reason} \u2022 <t:${Math.floor(new Date(r.created_at).getTime() / 1000)}:R>`).join('\n');
    await msg.reply({ embeds: [embed(`Warns \u2014 ${(user || member).tag}`, lines)] });
    return;
  }

  if (cmd === 'clearwarns') {
    if (!modError(PermissionFlagsBits.ModerateMembers)) return;
    const target = await modTarget();
    if (!target) return;
    db.prepare('DELETE FROM warns WHERE guild_id = ? AND user_id = ?').run(guild.id, target.id);
    await msg.reply({ embeds: [smallEmbed(`\u2705 All warns cleared for ${target.tag}.`)] });
    return;
  }

  if (cmd === 'removewarn') {
    if (!modError(PermissionFlagsBits.ModerateMembers)) return;
    const target = await modTarget();
    if (!target) return;
    const warnId = parseInt(args.find(a => /^\d+$/.test(a)));
    if (!warnId) return msg.reply({ embeds: [errorEmbed('Provide a warn ID. Use `,warns @user` to find IDs.')] });
    const del = db.prepare('DELETE FROM warns WHERE id = ? AND guild_id = ? AND user_id = ?').run(warnId, guild.id, target.id);
    if (del.changes === 0) return msg.reply({ embeds: [errorEmbed('Warn not found.')] });
    await msg.reply({ embeds: [smallEmbed(`\u2705 Warn **#${warnId}** removed for ${target.tag}.`)] });
    return;
  }

  // â”€â”€ Ban / Kick â”€â”€
  if (cmd === 'ban' || cmd === 'tempban') {
    if (!modError(PermissionFlagsBits.BanMembers)) return;
    if (!botError(PermissionFlagsBits.BanMembers)) return;
    const target = await modTarget();
    if (!target) return;
    const timeStr = args.find(a => /^\d+[smhdw]$/i.test(a));
    const reason = formatReason(args.filter(a => a !== timeStr).slice(1).join(' ') || undefined);
    if (target.id === member.id) return msg.reply({ embeds: [errorEmbed('You cannot ban yourself.')] });
    if (target.id === client.user.id) return msg.reply({ embeds: [errorEmbed('You cannot ban me.')] });
    const alreadyBanned = await guild.bans.fetch(target.id).catch(() => null);
    if (alreadyBanned) return msg.reply({ embeds: [errorEmbed('This user is already banned. Use `,bantime` to change ban duration.')] });
    const tMember = await getMember(guild, target.id);
    if (tMember && !roleHierarchyError(tMember)) return;
    if (timeStr) {
      const sec = durationError(timeStr, 604800 * 52);
      if (sec === null) return;
      await guild.bans.create(target.id, { reason: `Temp ban: ${reason} (${timeLabel(sec)})` }).catch(() => {});
      setTempBan(guild.id, target.id, Date.now() + sec * 1000, reason, member.id);
      await sendModLog(guild, { Action: 'Temp Ban', User: target.tag, ID: target.id, Moderator: member.user.tag, Duration: timeLabel(sec), Reason: reason });
      return msg.reply({ embeds: [smallEmbed(`\uD83D\uDEAA ${target.tag} has been temporarily banned for ${timeLabel(sec)}. Reason: ${reason}`)] });
    }
    await guild.bans.create(target.id, { reason }).catch(() => {});
    await sendModLog(guild, { Action: 'Ban', User: target.tag, ID: target.id, Moderator: member.user.tag, Reason: reason });
    await msg.reply({ embeds: [smallEmbed(`\uD83D\uDEAA ${target.tag} has been banned. Reason: ${reason}`)] });
    return;
  }

  if (cmd === 'pban' || cmd === 'permban') {
    if (!modError(PermissionFlagsBits.BanMembers)) return;
    if (!botError(PermissionFlagsBits.BanMembers)) return;
    const target = await modTarget();
    if (!target) return;
    const reason = formatReason(args.slice(1).join(' ') || undefined);
    if (target.id === member.id) return msg.reply({ embeds: [errorEmbed('You cannot ban yourself.')] });
    if (target.id === client.user.id) return msg.reply({ embeds: [errorEmbed('You cannot ban me.')] });
    const alreadyBanned = await guild.bans.fetch(target.id).catch(() => null);
    if (alreadyBanned) return msg.reply({ embeds: [errorEmbed('This user is already banned. Use `,bantime` to change ban duration.')] });
    await guild.bans.create(target.id, { reason }).catch(() => {});
    await sendModLog(guild, { Action: 'Perm Ban', User: target.tag, ID: target.id, Moderator: member.user.tag, Reason: reason });
    await msg.reply({ embeds: [smallEmbed(`\uD83D\uDEAA ${target.tag} has been permanently banned. Reason: ${reason}`)] });
    return;
  }

  if (cmd === 'kick') {
    if (!modError(PermissionFlagsBits.KickMembers)) return;
    if (!botError(PermissionFlagsBits.KickMembers)) return;
    const target = await modTarget();
    if (!target) return;
    const reason = formatReason(args.slice(1).join(' ') || undefined);
    if (target.id === member.id) return msg.reply({ embeds: [errorEmbed('You cannot kick yourself.')] });
    if (target.id === client.user.id) return msg.reply({ embeds: [errorEmbed('You cannot kick me.')] });
    const tMember = await getMember(guild, target.id);
    if (!tMember) return msg.reply({ embeds: [errorEmbed('User is not in the server.')] });
    if (!roleHierarchyError(tMember)) return;
    await tMember.kick(reason).catch(() => {});
    await sendModLog(guild, { Action: 'Kick', User: target.tag, ID: target.id, Moderator: member.user.tag, Reason: reason });
    await msg.reply({ embeds: [smallEmbed(`\uD83D\uDC62 ${target.tag} has been kicked. Reason: ${reason}`)] });
    return;
  }

  if (cmd === 'unban') {
    if (!modError(PermissionFlagsBits.BanMembers)) return;
    const target = await modTarget();
    if (!target) return;
    const isBanned = await guild.bans.fetch(target.id).catch(() => null);
    if (!isBanned) return msg.reply({ embeds: [errorEmbed('This user is not banned.')] });
    await unbanUser(guild, target.id);
    removeTempBan(guild.id, target.id);
    await msg.reply({ embeds: [smallEmbed(`\uD83D\uDD13 ${target.tag} has been unbanned.`)] });
    return;
  }

  if (cmd === 'bantime') {
    if (!modError(PermissionFlagsBits.BanMembers)) return;
    const target = await modTarget();
    if (!target) return;
    const timeStr = args.find(a => /^\d+[smhdw]$/i.test(a));
    const sec = durationError(timeStr, 604800 * 52);
    if (sec === null) return;
    const existing = db.prepare('SELECT * FROM tempbans WHERE guild_id = ? AND user_id = ?').get(guild.id, target.id);
    if (!existing) return msg.reply({ embeds: [errorEmbed('This user is not tempbanned.')] });
    db.prepare('UPDATE tempbans SET ends_at = ? WHERE guild_id = ? AND user_id = ?').run(Date.now() + sec * 1000, guild.id, target.id);
    await sendModLog(guild, { Action: 'Ban Time Changed', User: target.tag, ID: target.id, Moderator: member.user.tag, Duration: timeLabel(sec) });
    await msg.reply({ embeds: [smallEmbed(`Ban duration for ${target.tag} changed to **${timeLabel(sec)}**.`)] });
    return;
  }

  // â”€â”€ Mute â”€â”€
  if (cmd === 'mute' || cmd === 'tempmute') {
    if (!modError(PermissionFlagsBits.ModerateMembers)) return;
    if (!botError(PermissionFlagsBits.ModerateMembers)) return;
    const target = await modTarget();
    if (!target) return;
    const timeStr = args.find(a => /^\d+[smhdw]$/i.test(a));
    const reason = formatReason(args.filter(a => a !== timeStr).slice(1).join(' ') || undefined);
    if (target.id === member.id) return msg.reply({ embeds: [errorEmbed('You cannot mute yourself.')] });
    if (target.id === client.user.id) return msg.reply({ embeds: [errorEmbed('You cannot mute me.')] });
    const tMember = await getMember(guild, target.id);
    if (!tMember) return msg.reply({ embeds: [errorEmbed('User is not in the server.')] });
    if (!roleHierarchyError(tMember)) return;
    const sec = timeStr ? durationError(timeStr, 2419200) : 3600;
    if (timeStr && sec === null) return;
    const finalSec = timeStr ? sec : 3600;
    await applyMute(tMember, finalSec, reason);
    await sendModLog(guild, { Action: 'Mute', User: target.tag, ID: target.id, Moderator: member.user.tag, Duration: timeLabel(finalSec), Reason: reason });
    await msg.reply({ embeds: [smallEmbed(`\uD83D\uDD07 ${target.tag} has been muted for ${timeLabel(finalSec)}. Reason: ${reason}`)] });
    return;
  }

  if (cmd === 'unmute') {
    if (!modError(PermissionFlagsBits.ModerateMembers)) return;
    if (!botError(PermissionFlagsBits.ModerateMembers)) return;
    const target = await modTarget();
    if (!target) return;
    const tMember = await getMember(guild, target.id);
    if (!tMember) return msg.reply({ embeds: [errorEmbed('User is not in the server.')] });
    await removeMute(tMember);
    await msg.reply({ embeds: [smallEmbed(`\uD83D\uDD0A ${target.tag} has been unmuted.`)] });
    return;
  }

  // â”€â”€ Muteds â”€â”€
  if (cmd === 'muteds') {
    if (!modError(PermissionFlagsBits.ModerateMembers)) return;
    const muted = guild.members.cache.filter(m => m.isCommunicationDisabled());
    if (!muted.size) return msg.reply({ embeds: [smallEmbed('No muted members.')] });
    const lines = muted.map(m => `\u2022 **${m.user.tag}** (\`${m.id}\`) \u2022 ends <t:${Math.floor(m.communicationDisabledUntil / 1000)}:R>`);
    const chunks = [];
    for (let i = 0; i < lines.length; i += 20) chunks.push(lines.slice(i, i + 20).join('\n'));
    for (const chunk of chunks) await msg.reply({ embeds: [embed(`Muted Members (${muted.size})`, chunk)] });
    return;
  }

  // â”€â”€ Role â”€â”€
  if (cmd === 'role') {
    if (!modError(PermissionFlagsBits.ManageRoles)) return;
    if (!botError(PermissionFlagsBits.ManageRoles)) return;
    const target = await modTarget();
    if (!target) return;
    const mentionStr = msg.mentions.users.first() ? `<@${msg.mentions.users.first().id}>` : null;
    const roleArg = mentionStr ? msg.content.replace(/,\S+\s*/, '').replace(mentionStr, '').trim() : args.slice(1).join(' ');
    if (!roleArg) return msg.reply({ embeds: [errorEmbed('Provide a role name or ID.')] });
    let role = guild.roles.cache.find(r => r.name.toLowerCase() === roleArg.toLowerCase() || r.id === roleArg.replace(/[<@&>]/g, ''));
    if (!role) role = guild.roles.cache.find(r => roleArg.toLowerCase().includes(r.name.toLowerCase()));
    if (!role) return msg.reply({ embeds: [errorEmbed('Role not found.')] });
    if (role.position >= member.roles.highest.position && member.id !== guild.ownerId) {
      return msg.reply({ embeds: [errorEmbed('Cannot manage this role.')] });
    }
    if (role.position >= guild.members.me.roles.highest.position && guild.ownerId !== guild.members.me.id) {
      return msg.reply({ embeds: [errorEmbed('Bot cannot manage this role (hierarchy).')] });
    }
    const tMember = await getMember(guild, target.id);
    if (!tMember) return msg.reply({ embeds: [errorEmbed('User is not in the server.')] });
    if (tMember.roles.cache.has(role.id)) {
      await tMember.roles.remove(role);
      await msg.reply({ embeds: [smallEmbed(`\uD83D\uDD34 Removed **${role.name}** from ${target.tag}.`)] });
    } else {
      await tMember.roles.add(role);
      await msg.reply({ embeds: [smallEmbed(`\uD83D\uDFE2 Added **${role.name}** to ${target.tag}.`)] });
    }
    return;
  }

  // â”€â”€ Snipe â”€â”€
  if (cmd === 's' || cmd === 'snipe') {
    if (!modError(PermissionFlagsBits.ManageMessages)) return;
    let targetUser = null;
    if (msg.reference?.messageId) {
      let ref = msg.channel.messages.cache.get(msg.reference.messageId);
      if (!ref) try { ref = await msg.channel.messages.fetch(msg.reference.messageId); } catch {}
      if (ref) targetUser = ref.author.id;
    } else if (args[0]) {
      const id = args[0].replace(/[<@!>]/g, '');
      if (/^\d{17,19}$/.test(id)) targetUser = id;
    }
    const messages = targetUser ? snipe.get(guild.id, msg.channel.id, targetUser) : snipe.getAll(guild.id, msg.channel.id);
    if (!messages || messages.length === 0) return msg.reply({ embeds: [smallEmbed('No deleted messages found.')] });
    const lines = messages.slice(0, 10).map((e, i) => {
      const time = `<t:${Math.floor(e.timestamp / 1000)}:R>`;
      return `**${i + 1}.** **${e.author}** ${time}\n${e.content || '*no text*'}`;
    });
    await msg.reply({ embeds: [embed(`Sniped Messages (${messages.length})`, lines.join('\n'))] });
    return;
  }

  // â”€â”€ Banner â”€â”€
  if (cmd === 'banner') {
    const target = getTargetFromMsg(msg, args) || member.user;
    const user = target.id ? await client.users.fetch(target.id, { force: true }).catch(() => null) : null;
    if (!user) return msg.reply({ embeds: [errorEmbed('User not found.')] });
    const bannerURL = user.bannerURL({ size: 4096, force: true });
    if (!bannerURL) return msg.reply({ embeds: [smallEmbed(`${user.tag} has no banner.`)] });
    const btn = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(bannerURL).setLabel('Open Banner')
    );
    await msg.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle(`${user.tag}'s Banner`).setImage(bannerURL)], components: [btn] });
    return;
  }

  // â”€â”€ Avatar â”€â”€
  if (cmd === 'avatar' || cmd === 'av') {
    const target = getTargetFromMsg(msg, args) || member.user;
    const user = target.id ? await client.users.fetch(target.id).catch(() => null) : null;
    if (!user) return msg.reply({ embeds: [errorEmbed('User not found.')] });
    await msg.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle(`${user.tag}'s Avatar`).setImage(user.displayAvatarURL({ size: 4096, force: true }))] });
    return;
  }

  // â”€â”€ Lock / Unlock â”€â”€
  if (cmd === 'lock') {
    if (!modError(PermissionFlagsBits.ManageChannels)) return;
    await msg.channel.permissionOverwrites.edit(msg.guild.roles.everyone, { SendMessages: false }).catch(() => {});
    await msg.reply({ embeds: [smallEmbed(`\uD83D\uDD12 Channel locked.`)] });
    return;
  }

  if (cmd === 'unlock') {
    if (!modError(PermissionFlagsBits.ManageChannels)) return;
    await msg.channel.permissionOverwrites.edit(msg.guild.roles.everyone, { SendMessages: null }).catch(() => {});
    await msg.reply({ embeds: [smallEmbed(`\uD83D\uDD13 Channel unlocked.`)] });
    return;
  }

  // â”€â”€ Slowmode â”€â”€
  if (cmd === 'slowmode') {
    if (!modError(PermissionFlagsBits.ManageChannels)) return;
    const sec = getTimeSeconds(args[0]);
    if (sec === null || sec < 0 || sec > 21600) return msg.reply({ embeds: [errorEmbed('Invalid slowmode (0-21600s).')] });
    await msg.channel.setRateLimitPerUser(sec);
    await msg.reply({ embeds: [smallEmbed(`\u23F3 Slowmode set to ${timeLabel(sec)}.`)] });
    return;
  }

  // â”€â”€ Clear â”€â”€
  if (cmd === 'clear' || cmd === 'purge') {
    if (!modError(PermissionFlagsBits.ManageMessages)) return;
    const count = parseInt(args[0]);
    if (!count || count < 1 || count > 1000) return msg.reply({ embeds: [errorEmbed('Provide a number between 1-1000.')] });
    let totalDeleted = 0;
    let toDelete = Math.min(count, 1000);
    while (toDelete > 0) {
      const batch = Math.min(toDelete + 1, 100);
      const deleted = await msg.channel.bulkDelete(batch, true).catch(() => null);
      if (!deleted || deleted.size === 0) {
        if (totalDeleted === 0) return msg.reply({ embeds: [errorEmbed('Cannot delete messages older than 14 days.')] });
        break;
      }
      totalDeleted += deleted.size - (totalDeleted === 0 ? 1 : 0);
      toDelete -= batch - (totalDeleted === 0 ? 1 : 0);
    }
    const reply = await msg.channel.send({ embeds: [smallEmbed(`\uD83D\uDDD1 Cleared **${totalDeleted}** messages.`)] });
    setTimeout(() => reply.delete().catch(() => {}), 3000);
    return;
  }

  // â”€â”€ Nuke â”€â”€
  if (cmd === 'nuke') {
    if (!modError(PermissionFlagsBits.ManageChannels)) return;
    if (!botError(PermissionFlagsBits.ManageChannels)) return;
    const newChan = await msg.channel.clone().catch(() => null);
    if (!newChan) return msg.reply({ embeds: [errorEmbed('Failed to clone channel.')] });
    await msg.channel.delete().catch(() => {});
    const embed2 = new EmbedBuilder().setColor(0x2b2d31).setDescription('\uD83D\uDCA5 Channel has been nuked.').setImage('https://media1.tenor.com/m/1GQM30NmMcQAAAAd/nuke-explosion.gif').setTimestamp();
    await newChan.send({ embeds: [embed2] });
    return;
  }

  // â”€â”€ Raidmode â”€â”€
  if (cmd === 'raidmode') {
    if (!modError(PermissionFlagsBits.Administrator)) return;
    const state = args[0]?.toLowerCase();
    if (state === 'on') {
      await guild.permissionOverwrites.edit(guild.roles.everyone, { CreateInstantInvite: false }).catch(() => {});
      await msg.reply({ embeds: [smallEmbed(`\uD83D\uDEA8 Raid mode enabled.`)] });
    } else if (state === 'off') {
      await guild.permissionOverwrites.edit(guild.roles.everyone, { CreateInstantInvite: null }).catch(() => {});
      await msg.reply({ embeds: [smallEmbed(`\u2705 Raid mode disabled.`)] });
    } else {
      await msg.reply({ embeds: [errorEmbed('Usage: `,raidmode on` or `,raidmode off`')] });
    }
    return;
  }

  // â”€â”€ Voicekick â”€â”€
  if (cmd === 'voicekick' || cmd === 'vk') {
    if (!modError(PermissionFlagsBits.MoveMembers)) return;
    if (!botError(PermissionFlagsBits.MoveMembers)) return;
    const target = await modTarget();
    if (!target) return;
    const tMember = await getMember(guild, target.id);
    if (!tMember) return msg.reply({ embeds: [errorEmbed('User is not in the server.')] });
    if (!tMember.voice.channel) return msg.reply({ embeds: [errorEmbed('User is not in a voice channel.')] });
    await tMember.voice.disconnect().catch(() => {});
    await msg.reply({ embeds: [smallEmbed(`\uD83D\uDC4A ${target.tag} has been removed from voice channel.`)] });
    return;
  }

  // â”€â”€ Deafen â”€â”€
  if (cmd === 'deafen') {
    if (!modError(PermissionFlagsBits.DeafenMembers)) return;
    if (!botError(PermissionFlagsBits.DeafenMembers)) return;
    const target = await modTarget();
    if (!target) return;
    const tMember = await getMember(guild, target.id);
    if (!tMember) return msg.reply({ embeds: [errorEmbed('User is not in the server.')] });
    if (!tMember.voice.channel) return msg.reply({ embeds: [errorEmbed('User is not in a voice channel.')] });
    await tMember.voice.setDeaf(true).catch(() => {});
    await msg.reply({ embeds: [smallEmbed(`\uD83D\uDD07 ${target.tag} has been deafened.`)] });
    return;
  }

  if (cmd === 'undeafen') {
    if (!modError(PermissionFlagsBits.DeafenMembers)) return;
    if (!botError(PermissionFlagsBits.DeafenMembers)) return;
    const target = await modTarget();
    if (!target) return;
    const tMember = await getMember(guild, target.id);
    if (!tMember) return msg.reply({ embeds: [errorEmbed('User is not in the server.')] });
    await tMember.voice.setDeaf(false).catch(() => {});
    await msg.reply({ embeds: [smallEmbed(`\uD83D\uDD0A ${target.tag} has been undeafened.`)] });
    return;
  }

  // â”€â”€ Timeout â”€â”€
  if (cmd === 'timeout') {
    if (!modError(PermissionFlagsBits.ModerateMembers)) return;
    if (!botError(PermissionFlagsBits.ModerateMembers)) return;
    const target = await modTarget();
    if (!target) return;
    const timeStr = args.find(a => /^\d+[smhdw]$/i.test(a));
    const sec = durationError(timeStr, 2419200);
    if (sec === null) return;
    const reason = formatReason(args.filter(a => a !== timeStr).slice(1).join(' ') || undefined);
    if (target.id === member.id) return msg.reply({ embeds: [errorEmbed('You cannot timeout yourself.')] });
    const tMember = await getMember(guild, target.id);
    if (!tMember) return msg.reply({ embeds: [errorEmbed('User is not in the server.')] });
    if (!roleHierarchyError(tMember)) return;
    await tMember.timeout(sec * 1000, reason).catch(() => {});
    await msg.reply({ embeds: [smallEmbed(`\u23F1 ${target.tag} has been timed out for ${timeLabel(sec)}. Reason: ${reason}`)] });
    return;
  }

  if (cmd === 'untimeout') {
    if (!modError(PermissionFlagsBits.ModerateMembers)) return;
    if (!botError(PermissionFlagsBits.ModerateMembers)) return;
    const target = await modTarget();
    if (!target) return;
    const tMember = await getMember(guild, target.id);
    if (!tMember) return msg.reply({ embeds: [errorEmbed('User is not in the server.')] });
    await tMember.timeout(null).catch(() => {});
    await msg.reply({ embeds: [smallEmbed(`\u2705 ${target.tag} timeout removed.`)] });
    return;
  }

  // â”€â”€ Banword / Warnword / Muteword (prefix) â”€â”€
  if (cmd === 'banword' || cmd === 'warnword' || cmd === 'muteword') {
    if (!modError(PermissionFlagsBits.ManageMessages)) return;
    const type = (cmd === 'muteword') ? 'mute' : 'ban';
    const sub = args[0]?.toLowerCase();
    if (sub === 'list') {
      const words = db.prepare('SELECT word, duration FROM word_filters WHERE guild_id = ? AND action = ?').all(guild.id, type);
      if (!words.length) return msg.reply({ embeds: [smallEmbed(`No ${cmd} words.`)] });
      return msg.reply({ embeds: [embed(`${cmd} list (${words.length})`, words.map(w => `\`${w.word}\`${w.duration ? ` (\u2192 ${w.duration})` : ''}`).join(', '))] });
    }
    if (sub === 'remove' || sub === 'del') {
      const word = args.slice(1).join(' ').toLowerCase();
      if (!word) return msg.reply({ embeds: [errorEmbed('Provide a word to remove.')] });
      db.prepare('DELETE FROM word_filters WHERE guild_id = ? AND word = ?').run(guild.id, word);
      return msg.reply({ embeds: [smallEmbed(`\u2705 \`${word}\` removed from ${cmd}.`)] });
    }
    // Parse: ,warnword <word> [duration]  or  ,muteword <word> [duration]
    let word, duration = null;
    const timeMatch = args.find(a => /^\d+[smhd]$/i.test(a));
    if (timeMatch) {
      duration = timeMatch;
      word = args.filter(a => a !== timeMatch).join(' ').toLowerCase();
    } else {
      word = args.join(' ').toLowerCase();
    }
    if (!word || word.length < 2) return msg.reply({ embeds: [errorEmbed('Usage: ,warnword <word> [duration]  e.g. ,muteword badword 30m')] });
    db.prepare('INSERT OR REPLACE INTO word_filters VALUES (?,?,?,?)').run(guild.id, word, type, duration);
    await msg.reply({ embeds: [smallEmbed(`\u2705 \`${word}\` added to ${cmd}${duration ? ` for ${duration}` : ''}.`)] });
    return;
  }

  // â”€â”€ Rules (capture) â”€â”€
  if (cmd === 'rules') {
    if (member.id !== OWNER_ID) return msg.reply({ embeds: [errorEmbed('Owner only.')] });
    pendingRules.set(member.id, true);
    await msg.reply({ embeds: [smallEmbed('Rules message waiting...')] });
    return;
  }

  // â”€â”€ Endpoll prefix â”€â”€
  if (cmd === 'endpoll') {
    if (!hasPanelAccess(msg.member)) return msg.reply({ embeds: [errorEmbed('Owner only.')] });
    const msgId = args[0];
    if (!msgId) return msg.reply({ embeds: [errorEmbed('Usage: ,endpoll <message_id>')] });
    const poll = cache.get(msgId);
    if (!poll) return msg.reply({ embeds: [errorEmbed('Poll not found.')] });
    const total = poll.counts.reduce((a, b) => a + b, 0);
    if (total === 0) {
      cache.delete(msgId); db.prepare('DELETE FROM polls WHERE message_id = ?').run(msgId);
      if (timers.has(msgId)) clearTimeout(timers.get(msgId));
      return msg.reply({ embeds: [smallEmbed('No votes were cast.')] });
    }
    if (timers.has(msgId)) clearTimeout(timers.get(msgId));
    cache.delete(msgId); db.prepare('DELETE FROM polls WHERE message_id = ?').run(msgId);
    archivePoll(poll.options, poll.counts, guild.id, poll.createdBy);
    const maxV = Math.max(...poll.counts);
    const idx = poll.counts.indexOf(maxV);
    const winner = poll.options[idx];
    const resultEmbed = new EmbedBuilder().setColor(0x2b2d31).setTitle('Poll Closed \u2014 Result')
      .setDescription(`After **${total}** vote${total !== 1 ? 's' : ''}, the winner is:\n\n**${winner}** with **${maxV}** vote${maxV !== 1 ? 's' : ''}!`)
      .setFooter({ text: `Closed by ${member.displayName}` }).setTimestamp();
    try {
      const channel = await client.channels.fetch(poll.channelId);
      const m = await channel.messages.fetch(msgId);
      await m.edit({ components: [], embeds: [resultEmbed] });
    } catch {}
    await msg.reply({ embeds: [resultEmbed] });
    return;
  }

  // â”€â”€ lastwarn / lastban / lastmuted â”€â”€
  if (cmd === 'lastwarn') {
    if (!modError(PermissionFlagsBits.ModerateMembers)) return;
    const rows = db.prepare('SELECT * FROM warns WHERE guild_id = ? ORDER BY id DESC LIMIT 10').all(guild.id);
    if (!rows.length) return msg.reply({ embeds: [smallEmbed('No warns recorded.')] });
    const lines = rows.map((r, i) => `**#${i+1}** <@${r.user_id}> \u2022 ${r.reason} \u2022 <t:${Math.floor(new Date(r.created_at).getTime() / 1000)}:R>`);
    await msg.reply({ embeds: [embed(`Last Warns (${rows.length})`, lines.join('\n'))] });
    return;
  }

  if (cmd === 'lastban') {
    if (!modError(PermissionFlagsBits.BanMembers)) return;
    const since = Date.now() - 86400000;
    const entries = await guild.fetchAuditLogs({ type: 22, limit: 20 }).catch(() => null);
    if (!entries) return msg.reply({ embeds: [errorEmbed('Could not fetch audit logs.')] });
    const recent = entries.entries.filter(e => e.createdTimestamp > since);
    if (!recent.size) return msg.reply({ embeds: [smallEmbed('No bans in the last 24 hours.')] });
    const lines = [...recent.values()].slice(0, 10).map(e => `\u2022 **${e.target?.tag || 'Unknown'}** (\`${e.targetId}\`) \u2022 ${e.reason || 'No reason'} \u2022 <t:${Math.floor(e.createdTimestamp / 1000)}:R>`);
    await msg.reply({ embeds: [embed(`Recent Bans (Last 24h)`, lines.join('\n'))] });
    return;
  }

  if (cmd === 'lastmuted') {
    if (!modError(PermissionFlagsBits.ModerateMembers)) return;
    const since = Date.now() - 86400000;
    const entries = await guild.fetchAuditLogs({ type: 24, limit: 20 }).catch(() => null);
    if (!entries) return msg.reply({ embeds: [errorEmbed('Could not fetch audit logs.')] });
    const recent = entries.entries.filter(e => e.createdTimestamp > since);
    if (!recent.size) return msg.reply({ embeds: [smallEmbed('No mutes in the last 24 hours.')] });
    const lines = [...recent.values()].slice(0, 10).map(e => `\u2022 **${e.target?.tag || 'Unknown'}** (\`${e.targetId}\`) \u2022 ${e.reason || 'No reason'} \u2022 <t:${Math.floor(e.createdTimestamp / 1000)}:R>`);
    await msg.reply({ embeds: [embed(`Recent Mutes (Last 24h)`, lines.join('\n'))] });
    return;
  }

  // â”€â”€ deletewarn / dwarn â”€â”€
  if (cmd === 'deletewarn') {
    if (!modError(PermissionFlagsBits.ModerateMembers)) return;
    const target = await modTarget();
    if (!target) return;
    const arg = args.find(a => a === 'all' || /^\d+$/.test(a));
    if (!arg) return msg.reply({ embeds: [errorEmbed('Usage: `,deletewarn <user> [all|count]`')] });
    if (arg === 'all') {
      db.prepare('DELETE FROM warns WHERE guild_id = ? AND user_id = ?').run(guild.id, target.id);
      await msg.reply({ embeds: [smallEmbed(`All warns cleared for ${target.tag}.`)] });
    } else {
      const count = parseInt(arg);
      const rows = db.prepare('SELECT id FROM warns WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?').all(guild.id, target.id, count);
      if (!rows.length) return msg.reply({ embeds: [errorEmbed('No warns to delete.')] });
      for (const r of rows) db.prepare('DELETE FROM warns WHERE id = ?').run(r.id);
      await msg.reply({ embeds: [smallEmbed(`**${rows.length}** warn(s) deleted for ${target.tag}.`)] });
    }
    return;
  }

  // â”€â”€ Panel prefix â”€â”€
  if (cmd === 'panel') {
    return msg.reply(panelMain({ guildId: guild.id, guild, member: msg.member, channel: msg.channel }));
  }

  // ── Prefix commands (moved from messageCreate) ──
  if (cmd === 'help') {
    const embed = new EmbedBuilder().setColor(0x000000).setTitle('NEXUS').setDescription('Your all-in-one Discord bot').setFooter({ text: 'Prefix: ,' });
    embed.addFields(
      { name: 'Everyone', value: '`/help` `,help` • `/panel` `,panel` • `/userinfo` `,ui` • `/serverinfo` `,si` • `/avatar` `,av` • `/banner` • `/afk` `,afk` • `/remind` `,remind` • `/ticket` `,ticket` • `/entervc` `,entervc` • `/leavevc` `,leavevc` • `/subscribe` `,subscribe` • `/lastwarn` `,lastwarn` • `/lastban` `,lastban` • `/lastmuted` `,lastmuted`', inline: false },
      { name: 'Polls', value: '`/poll`, `/endpoll`, `/activepolls`, `/history` (Owner + Staff only) `,endpoll`', inline: false },
      { name: 'Giveaways', value: '`/giveaway`, `/endgiveaway`, `/reroll` (Owner only) — Panel: Log > Giveaways tab', inline: false },
      { name: 'Moderation', value: '`,w`(warn) `,b`(ban) `,tb`(tempban) `,k`(kick) `,m`(mute) `,t`(timeout) `,cl`(clear) `,n`(nuke) `,r`(role) `,l`(lock) `,ul`(unlock) `,sm`(slowmode) `,vk`(voicekick) `,s`(snipe) `,d`(deafen) • `,deletewarn` `,dw` • `/deletewarn`', inline: false },
      { name: 'Auto-Mod', value: '`,warnword`, `,muteword`, `,addword` — Panel: Protect > Filters', inline: false },
      { name: 'Settings', value: '`/panel` → All config (log types, anti-spam, tickets, AI, perms, keyword triggers, auto-replies)', inline: false },
    );
    const bannerPath = require('path').join(__dirname, 'assets', 'banner.png');
    const bannerFile = require('fs').existsSync(bannerPath) ? new AttachmentBuilder(bannerPath) : null;
    if (bannerFile) embed.setImage('attachment://banner.png');
    await msg.reply({ embeds: [embed], files: bannerFile ? [bannerFile] : [] });
    return;
  }

  if (cmd === 'ticket') {
    if (!modError(PermissionFlagsBits.ManageMessages)) return;
    const btn = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_open').setLabel('🎫 Open Ticket').setStyle(ButtonStyle.Primary),
    );
    await msg.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('Support Tickets').setDescription('Click the button below to open a support ticket.')], components: [btn] });
    return;
  }

  if (cmd === 'afk') {
    const reason = args.join(' ') || 'AFK';
    db.prepare('INSERT OR REPLACE INTO afk VALUES (?,?,?,?)').run(guild.id, member.id, reason, Date.now());
    await msg.reply({ embeds: [new EmbedBuilder().setColor(0xCC3333).setDescription(`🚫 ${member.user} is now **AFK**: ${reason}`)] });
    return;
  }

  if (cmd === 'userinfo' || cmd === 'ui') {
    const target = getTargetFromMsg(msg, args) || member.user;
    const user = target.id ? await client.users.fetch(target.id).catch(() => null) : null;
    if (!user) return msg.reply({ embeds: [errorEmbed('User not found.')] });
    const tMember = await getMember(guild, user.id);
    const warns = db.prepare('SELECT COUNT(*) as c FROM warns WHERE guild_id = ? AND user_id = ?').get(guild.id, user.id).c;
    const uilines = [
      `**User:** ${user.tag} (${user.id})`,
      `**Joined:** ${tMember ? `<t:${Math.floor(tMember.joinedTimestamp / 1000)}:R>` : 'Not in server'}`,
      `**Registered:** <t:${Math.floor(user.createdTimestamp / 1000)}:R>`,
      `**Warns:** ${warns}`,
      `**Roles:** ${tMember ? tMember.roles.cache.filter(r => r.id !== guild.id).size : '-'}`,
    ];
    await msg.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('User Info').setDescription(uilines.join('\n')).setThumbnail(user.displayAvatarURL())] });
    return;
  }

  if (cmd === 'serverinfo' || cmd === 'si') {
    const silines = [
      `**Name:** ${guild.name}`,
      `**ID:** ${guild.id}`,
      `**Owner:** ${(await guild.fetchOwner()).user.tag}`,
      `**Members:** ${guild.memberCount}`,
      `**Channels:** ${guild.channels.cache.size}`,
      `**Roles:** ${guild.roles.cache.size}`,
      `**Boost Level:** ${guild.premiumTier}`,
      `**Created:** <t:${Math.floor(guild.createdTimestamp / 1000)}:R>`,
    ];
    await msg.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('Server Info').setDescription(silines.join('\n')).setThumbnail(guild.iconURL())] });
    return;
  }

  if (cmd === 'remind') {
    const timeStr = args[0];
    const text = args.slice(1).join(' ');
    const sec = getTimeSeconds(timeStr);
    if (!sec || sec < 10 || sec > 2592000) return msg.reply({ embeds: [errorEmbed('Duration must be 10s-30d.')] });
    await msg.reply({ embeds: [smallEmbed(`I will remind you in **${timeStr}**.`)] });
    setTimeout(async () => {
      try { await member.user.send({ embeds: [smallEmbed(`⏰ **Reminder:** ${text}`)] }); } catch {}
    }, sec * 1000);
    return;
  }

  if (cmd === 'giveaway') {
    if (member.id !== OWNER_ID) return msg.reply({ embeds: [errorEmbed('Owner only.')] });
    const durationStr = args[0];
    const prize = args.slice(1).join(' ');
    const sec = getTimeSeconds(durationStr);
    if (!sec || sec < 30 || sec > 2592000 || !prize) return msg.reply({ embeds: [errorEmbed('Usage: `,giveaway <duration> <prize>` e.g. `,giveaway 1h Discord Nitro`')] });
    const endsAt = Date.now() + sec * 1000;
    const gembed = new EmbedBuilder().setColor(0x2b2d31)
      .setTitle('🎉 Giveaway')
      .setDescription(`**${prize}**\n\nHosted by ${member.user}\nWinners: **1**\nEnds: <t:${Math.floor(endsAt / 1000)}:R>`)
      .setFooter({ text: 'Click the button below to enter!' });
    const btn = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('giveaway_join').setEmoji('🎉').setLabel('Enter').setStyle(ButtonStyle.Success),
    );
    const m = await msg.channel.send({ embeds: [gembed], components: [btn] });
    const data = { msgId: m.id, channelId: msg.channel.id, guildId: guild.id, prize, winners: 1, endsAt, hostId: member.id, entries: [] };
    giveaways.set(m.id, data);
    db.prepare('INSERT OR REPLACE INTO giveaways VALUES (?,?,?,?,?,?,?,?)').run(m.id, guild.id, msg.channel.id, prize, 1, endsAt, member.id, JSON.stringify([]));
    scheduleGiveawayEnd(m.id, data);
    return;
  }

  if (cmd === 'endgiveaway') {
    if (member.id !== OWNER_ID) return msg.reply({ embeds: [errorEmbed('Owner only.')] });
    const msgId = args[0];
    if (!msgId) return msg.reply({ embeds: [errorEmbed('Usage: `,endgiveaway <message_id>`')] });
    const g = giveaways.get(msgId);
    if (!g) return msg.reply({ embeds: [errorEmbed('Giveaway not found or already ended.')] });
    endGiveaway(msgId);
    await msg.reply({ embeds: [smallEmbed('Giveaway ended.')] });
    return;
  }

  if (cmd === 'reroll') {
    if (member.id !== OWNER_ID) return msg.reply({ embeds: [errorEmbed('Owner only.')] });
    const msgId = args[0];
    if (!msgId) return msg.reply({ embeds: [errorEmbed('Usage: `,reroll <message_id>`')] });
    const row = db.prepare('SELECT * FROM giveaways WHERE message_id = ?').get(msgId);
    if (!row) return msg.reply({ embeds: [errorEmbed('Giveaway not found.')] });
    const entries = JSON.parse(row.entries);
    const valid = entries.filter(id => { try { return guild.members.cache.has(id); } catch { return false; } });
    if (valid.length === 0) return msg.reply({ embeds: [errorEmbed('No valid entrants to reroll.')] });
    const newWinners = [];
    const count = Math.min(row.winners, valid.length);
    for (let i = 0; i < count; i++) {
      const idx = Math.floor(Math.random() * valid.length);
      newWinners.push(valid.splice(idx, 1)[0]);
    }
    await msg.channel.send({ embeds: [smallEmbed(`🎉 **Reroll!** New winner(s) for **${row.prize}**: ${newWinners.map(id => `<@${id}>`).join(', ')}`)] });
    await msg.reply({ embeds: [smallEmbed('Reroll done.')] });
    return;
  }

  if (cmd === 'poll') {
    if (!modError(PermissionFlagsBits.ManageMessages)) return;
    const optionsStr = args[0];
    const desc = args.slice(1).join(' ');
    const options = optionsStr ? optionsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    if (options.length < 2) return msg.reply({ embeds: [errorEmbed('Usage: `,poll <option1,option2,...> [description]` e.g. `,poll Yes,No,Maybe Vote now!`')] });
    if (options.length > 25) return msg.reply({ embeds: [errorEmbed('Maximum 25 options.')] });
    const pollData = {
      guildId: guild.id, channelId: msg.channel.id, options, ping: 'none', description: desc || null,
      counts: new Array(options.length).fill(0), voters: new Map(),
      authorId: member.id, endsAt: null, createdBy: member.displayName,
    };
    const select = new StringSelectMenuBuilder().setCustomId('vote').setPlaceholder('Cast your vote...')
      .addOptions(options.map((o, i) => ({ label: o.length > 100 ? o.slice(0, 97) + '...' : o, value: String(i) })));
    const m = await msg.channel.send({ embeds: [buildPollEmbed(pollData, member.displayName)], components: [new ActionRowBuilder().addComponents(select)] });
    cache.set(m.id, pollData);
    savePoll(m.id, pollData);
    return;
  }

  if (cmd === 'entervc') {
    if (!modError(PermissionFlagsBits.Connect)) return;
    const channel = msg.member.voice.channel;
    if (!channel) return msg.reply({ embeds: [errorEmbed('You are not in a voice channel.')] });
    const existing = getVoiceConnection(guild.id);
    if (existing) existing.destroy();
    try {
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 10000);
      await msg.reply({ embeds: [smallEmbed(`🔊 Joined **${channel.name}**`)] });
    } catch {
      await msg.reply({ embeds: [errorEmbed('Failed to join the voice channel.')] });
    }
    return;
  }

  if (cmd === 'leavevc') {
    const connection = getVoiceConnection(guild.id);
    if (connection) {
      const name = guild.channels.cache.get(connection.joinConfig.channelId)?.name || 'voice channel';
      connection.destroy();
      await msg.reply({ embeds: [smallEmbed(`🔇 Left **${name}**`)] });
    } else {
      await msg.reply({ embeds: [errorEmbed('Bot is not in any voice channel.')] });
    }
    return;
  }

  if (cmd === 'nick') {
    if (member.id !== OWNER_ID) return msg.reply({ embeds: [errorEmbed('Owner only.')] });
    const target = await modTarget();
    if (!target) return;
    const name = args.slice(1).join(' ');
    const tMember = await getMember(guild, target.id);
    if (!tMember) return msg.reply({ embeds: [errorEmbed('User is not in the server.')] });
    await tMember.setNickname(name);
    await msg.reply({ embeds: [smallEmbed(`Nickname changed to **${name}**.`)] });
    return;
  }

  if (cmd === 'say') {
    if (member.id !== OWNER_ID) return msg.reply({ embeds: [errorEmbed('Owner only.')] });
    const text = args.join(' ');
    if (!text) return msg.reply({ embeds: [errorEmbed('Usage: `,say <message>`')] });
    await msg.channel.send(text);
    return;
  }

  if (cmd === 'roleall') {
    if (member.id !== OWNER_ID) return msg.reply({ embeds: [errorEmbed('Owner only.')] });
    const roleName = args.join(' ');
    let role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase() || r.id === roleName);
    if (!role) return msg.reply({ embeds: [errorEmbed('Role not found.')] });
    if (role.managed) return msg.reply({ embeds: [errorEmbed('Cannot give managed roles.')] });
    await msg.reply({ embeds: [smallEmbed(`Giving role **${role.name}** to all members...`)] });
    const membersList = await guild.members.fetch();
    let success = 0, fail = 0;
    for (const [, m] of membersList) {
      try { if (!m.roles.cache.has(role.id)) { await m.roles.add(role.id); success++; } } catch { fail++; }
    }
    await msg.channel.send({ embeds: [smallEmbed(`Given **${role.name}** to **${success}** members.${fail ? ` Failed: ${fail}` : ''}`)] });
    return;
  }

  if (cmd === 'removeall') {
    if (member.id !== OWNER_ID) return msg.reply({ embeds: [errorEmbed('Owner only.')] });
    const roleName = args.join(' ');
    let role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase() || r.id === roleName);
    if (!role) return msg.reply({ embeds: [errorEmbed('Role not found.')] });
    if (role.managed) return msg.reply({ embeds: [errorEmbed('Cannot remove managed roles.')] });
    await msg.reply({ embeds: [smallEmbed(`Removing role **${role.name}** from all members...`)] });
    const membersList = await guild.members.fetch();
    let success = 0, fail = 0;
    for (const [, m] of membersList) {
      try { if (m.roles.cache.has(role.id)) { await m.roles.remove(role.id); success++; } } catch { fail++; }
    }
    await msg.channel.send({ embeds: [smallEmbed(`Removed **${role.name}** from **${success}** members.${fail ? ` Failed: ${fail}` : ''}`)] });
    return;
  }

  if (cmd === 'emoji') {
    if (member.id !== OWNER_ID) return msg.reply({ embeds: [errorEmbed('Owner only.')] });
    const name = args[0];
    const url = args[1];
    if (!name || !url) return msg.reply({ embeds: [errorEmbed('Usage: `,emoji <name> <image_url>`')] });
    try {
      await guild.emojis.create({ name, attachment: url });
      await msg.reply({ embeds: [smallEmbed(`Emoji **:${name}:** created.`)] });
    } catch { await msg.reply({ embeds: [errorEmbed('Failed to create emoji. Check URL and name.')] }); }
    return;
  }

  if (cmd === 'setlog') {
    if (!modError(PermissionFlagsBits.ManageGuild)) return;
    const channel = msg.mentions.channels.first() || msg.channel;
    ensureConfig(guild.id);
    setConfig(guild.id, 'log_channel_id', channel.id);
    await msg.reply({ embeds: [smallEmbed(`Log channel set to ${channel}.`)] });
    return;
  }

  if (cmd === 'tagchannel') {
    if (!modError(PermissionFlagsBits.ManageGuild)) return;
    const channel = msg.mentions.channels.first();
    if (channel) {
      ensureConfig(guild.id);
      setConfig(guild.id, 'tag_channel_id', channel.id);
      await msg.reply({ embeds: [smallEmbed(`Tag channel set to ${channel}.`)] });
    } else {
      const current = db.prepare('SELECT tag_channel_id FROM config WHERE guild_id = ?').get(guild.id)?.tag_channel_id;
      if (current) { setConfig(guild.id, 'tag_channel_id', null); return msg.reply({ embeds: [smallEmbed('Tag channel disabled.')] }); }
      await msg.reply({ embeds: [errorEmbed('Mention a channel or use without mention to disable.')] });
    }
    return;
  }

  if (cmd === 'settings') {
    const ws = db.prepare('SELECT * FROM warn_settings WHERE guild_id = ?').get(guild.id);
    const logChanId = db.prepare('SELECT log_channel_id FROM config WHERE guild_id = ?').get(guild.id);
    const banWords = db.prepare("SELECT word FROM word_filters WHERE guild_id = ? AND action = 'ban'").all(guild.id);
    const muteWords = db.prepare("SELECT word FROM word_filters WHERE guild_id = ? AND action = 'mute'").all(guild.id);
    const activePolls = [...cache.values()].filter(p => p.guildId === guild.id).length;
    const setlines = [
      `**Polls** — ${activePolls} active`,
      `**Log Channel** — ${logChanId ? `<#${logChanId.log_channel_id}>` : 'Not set'}`,
      '',
      `**Warn Settings**`,
      `  Max warns: **${ws?.max_warns || 5}**`,
      `  Action: **${ws?.action || 'kick'}**${ws?.action === 'mute' ? ` (${ws?.mute_duration || '1h'})` : ''}`,
      '',
      `**Word Filters**`,
      `  Ban words: **${banWords.length}**`,
      `  Mute words: **${muteWords.length}**`,
    ];
    await msg.reply({ embeds: [embed('Bot Settings', setlines.join('\n'))] });
    return;
  }

  if (cmd === 'activepolls') {
    const list = [...cache.entries()].filter(([_, p]) => p.guildId === guild.id);
    if (list.length === 0) return msg.reply({ embeds: [smallEmbed('No active polls.')] });
    const apLines = list.map(([id, p]) => {
      const total = p.counts.reduce((a, b) => a + b, 0);
      const remain = p.endsAt ? discordTimestamp(p.endsAt) : 'no limit';
      return `**${p.options.join(', ')}** — ${total} vote${total !== 1 ? 's' : ''} (ends ${remain})`;
    });
    await msg.reply({ embeds: [embed(`Active Polls (${list.length})`, apLines.join('\n\n'))] });
    return;
  }

  if (cmd === 'history') {
    const rows = db.prepare('SELECT * FROM history WHERE guild_id = ? ORDER BY id DESC LIMIT 10').all(guild.id);
    if (rows.length === 0) return msg.reply({ embeds: [smallEmbed('No poll history.')] });
    const histLines = rows.map(r => {
      const opts = JSON.parse(r.options);
      const counts = JSON.parse(r.counts);
      const total = counts.reduce((a, b) => a + b, 0);
      const details = opts.map((o, j) => `  ${j + 1}. ${o} — ${counts[j]} votes`).join('\n');
      return `**#${r.id}** — **${r.winner}** (${total} votes)\n${details}\nBy ${r.created_by || 'Unknown'}`;
    });
    await msg.reply({ embeds: [embed('Poll History (Last 10)', histLines.join('\n\n'))] });
    return;
  }

  if (cmd === 'subscribe') {
    const existing = db.prepare('SELECT user_id FROM subscribers WHERE user_id = ? AND guild_id = ?').get(member.id, guild.id);
    if (existing) {
      db.prepare('DELETE FROM subscribers WHERE user_id = ? AND guild_id = ?').run(member.id, guild.id);
      await msg.reply({ embeds: [smallEmbed('DM notifications disabled.')] });
    } else {
      db.prepare('INSERT OR REPLACE INTO subscribers (user_id, guild_id) VALUES (?, ?)').run(member.id, guild.id);
      await msg.reply({ embeds: [smallEmbed('DM notifications enabled.')] });
    }
    return;
  }

  if (cmd === 'warncount') {
    if (!modError(PermissionFlagsBits.Administrator)) return;
    const count = parseInt(args[0]);
    if (!count || count < 1 || count > 100) return msg.reply({ embeds: [errorEmbed('Count must be 1-100.')] });
    db.prepare("INSERT OR REPLACE INTO warn_settings (guild_id, max_warns, action, mute_duration) VALUES (?,?,COALESCE((SELECT action FROM warn_settings WHERE guild_id = ?),'kick'),COALESCE((SELECT mute_duration FROM warn_settings WHERE guild_id = ?),'1h'))")
      .run(guild.id, count, guild.id, guild.id);
    await msg.reply({ embeds: [smallEmbed(`Max warns set to **${count}**.`)] });
    return;
  }

  if (cmd === 'warnsetting') {
    if (!modError(PermissionFlagsBits.Administrator)) return;
    const action = args[0]?.toLowerCase();
    const duration = args[1];
    if (!action || !['kick', 'ban', 'mute'].includes(action)) return msg.reply({ embeds: [errorEmbed('Usage: `,warnsetting <kick|ban|mute> [duration]`')] });
    if (action === 'mute' && !duration) return msg.reply({ embeds: [errorEmbed('Provide a mute duration (e.g., 1h, 30m, 1d).')] });
    if (duration && !getTimeSeconds(duration)) return msg.reply({ embeds: [errorEmbed('Invalid duration. Use e.g., 1h, 30m, 1d.')] });
    db.prepare("INSERT OR REPLACE INTO warn_settings (guild_id, max_warns, action, mute_duration) VALUES (?,COALESCE((SELECT max_warns FROM warn_settings WHERE guild_id = ?),5),?,?)")
      .run(guild.id, guild.id, action, duration || '1h');
    let wdesc = `Action set to **${action}**`;
    if (action === 'mute') wdesc += ` for **${duration || '1h'}**`;
    await msg.reply({ embeds: [smallEmbed(wdesc)] });
    return;
  }

  if (cmd === 'addword') {
    if (!modError(PermissionFlagsBits.ManageMessages)) return;
    const trigger = args[0]?.toLowerCase();
    const response = args.slice(1).join(' ');
    if (!trigger || !response) return msg.reply({ embeds: [errorEmbed('Usage: `,addword <trigger> <response>`')] });
    if (trigger.length < 2) return msg.reply({ embeds: [errorEmbed('Trigger must be at least 2 characters.')] });
    db.prepare('INSERT OR REPLACE INTO auto_replies VALUES (?,?,?)').run(guild.id, trigger, response);
    await msg.reply({ embeds: [smallEmbed(`Auto-reply added: **${trigger}** → ${response}`)] });
    return;
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ PANEL SYSTEM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function panelMain(interaction) {
  const pollCount = cache.size;
  const totalWarns = db.prepare('SELECT COUNT(*) as c FROM warns WHERE guild_id = ?').get(interaction.guildId).c;
  const activeBans = db.prepare('SELECT COUNT(*) as c FROM tempbans WHERE guild_id = ?').get(interaction.guildId).c;
  const subs = db.prepare('SELECT COUNT(*) as c FROM subscribers WHERE guild_id = ?').get(interaction.guildId).c;
  const banWords = db.prepare('SELECT COUNT(*) as c FROM word_filters WHERE guild_id = ? AND action = \'ban\'').get(interaction.guildId).c;
  const muteWords = db.prepare('SELECT COUNT(*) as c FROM word_filters WHERE guild_id = ? AND action = \'mute\'').get(interaction.guildId).c;
  const logChanId = db.prepare('SELECT log_channel_id FROM config WHERE guild_id = ?').get(interaction.guildId)?.log_channel_id;
  const tagChanId = db.prepare('SELECT tag_channel_id FROM config WHERE guild_id = ?').get(interaction.guildId)?.tag_channel_id;
  const ws = db.prepare('SELECT * FROM warn_settings WHERE guild_id = ?').get(interaction.guildId);
  const wsAction = ws?.action || 'kick';
  const wsCount = ws?.max_warns || 5;
  const aiCfg = db.prepare('SELECT * FROM ai_config WHERE guild_id = ?').get(interaction.guildId);
  const cfg = db.prepare('SELECT * FROM config WHERE guild_id = ?').get(interaction.guildId) || {};
  const ticketCfg = db.prepare('SELECT * FROM ticket_config WHERE guild_id = ?').get(interaction.guildId);
  const access = hasPanelAccess(interaction.member);
  const modRoleCount = db.prepare('SELECT COUNT(*) as c FROM mod_roles WHERE guild_id = ?').get(interaction.guildId).c;

  const desc = [
    `**${interaction.guild.name}** \u2014 ${interaction.guild.memberCount} members`,
    `\u23F1 Uptime: ${Math.floor(process.uptime() / 60)}m | **${access ? access : 'No'}** access`,
    '',
    `\uD83D\uDCCA **Server Stats**`,
    `  \u2022 Polls: **${pollCount}** active / **${db.prepare('SELECT COUNT(*) as c FROM history WHERE guild_id = ?').get(interaction.guildId).c}** archived`,
    `  \u2022 Warns: **${totalWarns}** total | Temp Bans: **${activeBans}** | Subs: **${subs}**`,
    '',
    `\uD83D\uDEE1\uFE0F **Protection**`,
    `  \u2022 Anti-Spam: **${cfg.anti_spam_max || 5}** msgs / **${cfg.anti_spam_window || 4}s**`,
    `  \u2022 Anti-Invite: **${cfg.anti_invite !== 0 ? 'ON' : 'OFF'}**`,
    `  \u2022 Word Filters: **${banWords}** ban / **${muteWords}** mute`,
    '',
    `\u2699\uFE0F **Moderation**`,
    `  \u2022 Warn: **${wsCount}** \u2192 **${wsAction}**`,
    `  \u2022 AI: ${aiCfg ? `**${aiCfg.provider}**` : 'Not configured'}`,
    `  \u2022 Tickets: ${ticketCfg ? 'Ready' : 'Not configured'}`,
    '',
    `\uD83D\uDCDD **Logging**`,
    `  \u2022 Log: ${logChanId ? `<#${logChanId}>` : 'Not set'}`,
    `  \u2022 Tag: ${tagChanId ? `<#${tagChanId}>` : 'Not set'}`,
    '',
    `\uD83D\uDD11 **Permissions**`,
    `  \u2022 Mod Roles: **${modRoleCount}** configured`,
    `  \u2022 Access: ${access ? '**Granted**' : 'View only'}`,
  ].join('\n');

  const btn = (id, label, style) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

  const rows = [
    new ActionRowBuilder().addComponents(
      btn('panel_polls', '\uD83D\uDCCA Polls', ButtonStyle.Secondary),
      btn('panel_warns', '\u26A0\uFE0F Warns', ButtonStyle.Secondary),
      btn('panel_words', '\uD83D\uDD0D Filters', ButtonStyle.Secondary),
      btn('panel_antispam', '\uD83D\uDEE1\uFE0F Protect', ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      btn('panel_autoreply', '\uD83E\uDD16 Auto-Reply', ButtonStyle.Secondary),
      btn('panel_ticket', '\uD83C\uDFAB Tickets', ButtonStyle.Secondary),
      btn('panel_ai', '\uD83E\uDD16 AI Chat', ButtonStyle.Secondary),
      btn('panel_bans', '\uD83D\uDD28 Bans', ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      btn('panel_log', '\uD83D\uDCDD Log', ButtonStyle.Secondary),
      btn('panel_tag', '\uD83D\uDC4B Tag', ButtonStyle.Secondary),
      btn('panel_permissions', '\uD83D\uDD11 Perms', access ? ButtonStyle.Primary : ButtonStyle.Secondary),
      btn('panel_stats', '\uD83D\uDCC8 Stats', ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      btn('panel_giveaway', '\uD83C\uDF89 Giveaways', ButtonStyle.Secondary),
      btn('panel_refresh', '\uD83D\uDD04 Refresh', ButtonStyle.Secondary),
      btn('panel_close', '\u274C Close', ButtonStyle.Danger),
    ),
  ];

  return { embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('\uD83D\uDEE1\uFE0F Admin Panel').setDescription(desc)], components: rows };
}

function panelStats(interaction) {
  const totalWarns = db.prepare('SELECT COUNT(*) as c FROM warns WHERE guild_id = ?').get(interaction.guildId).c;
  const activeBans = db.prepare('SELECT COUNT(*) as c FROM tempbans WHERE guild_id = ?').get(interaction.guildId).c;
  const memCount = interaction.guild.memberCount;
  const bots = interaction.guild.members.cache.filter(m => m.user.bot).size;
  const created = `<t:${Math.floor(interaction.guild.createdTimestamp / 1000)}:D>`;
  const boostLevel = interaction.guild.premiumTier ? `Level ${interaction.guild.premiumTier}` : 'None';

  const desc = [
    `**${interaction.guild.name}**`,
    `  \u2022 Owner: <@${interaction.guild.ownerId}>`,
    `  \u2022 Created: ${created}`,
    `  \u2022 Members: **${memCount}** (${memCount - bots} users, ${bots} bots)`,
    `  \u2022 Boosts: **${interaction.guild.premiumSubscriptionCount || 0}** (${boostLevel})`,
    `  \u2022 Channels: **${interaction.guild.channels.cache.size}**`,
    `  \u2022 Roles: **${interaction.guild.roles.cache.size}**`,
    '',
    `**Bot Stats**`,
    `  \u2022 Uptime: **${Math.floor(process.uptime() / 60)}m**`,
    `  \u2022 Warns Issued: **${totalWarns}**`,
    `  \u2022 Active Temp Bans: **${activeBans}**`,
    `  \u2022 Cached Polls: **${cache.size}**`,
  ].join('\n');

  return {
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('\uD83D\uDCC8 Server Stats').setDescription(desc)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_main').setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
    )],
  };
}

function panelPolls(interaction) {
  const pollCount = cache.size;
  const archived = db.prepare('SELECT COUNT(*) as c FROM history WHERE guild_id = ?').get(interaction.guildId).c;
  const subs = db.prepare('SELECT COUNT(*) as c FROM subscribers WHERE guild_id = ?').get(interaction.guildId).c;
  const list = [...cache.entries()].filter(([_, p]) => p.guildId === interaction.guildId).slice(0, 5);

  const desc = [
    `Active: **${pollCount}** | Archived: **${archived}** | Subscribers: **${subs}**`,
    list.length ? '' : '\nNo active polls.',
    ...list.map(([id, p]) => {
      const total = p.counts.reduce((a, b) => a + b, 0);
      const remain = p.endsAt ? discordTimestamp(p.endsAt) : 'no limit';
      return `  \u2022 **${p.options.join(', ')}** \u2014 ${total} votes (ends ${remain})`;
    }),
  ].join('\n');

  return {
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('\uD83D\uDCCA Polls').setDescription(desc)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_main').setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
    )],
  };
}

function panelWarns(interaction) {
  const ws = db.prepare('SELECT * FROM warn_settings WHERE guild_id = ?').get(interaction.guildId);
  const count = db.prepare('SELECT COUNT(*) as c FROM warns WHERE guild_id = ?').get(interaction.guildId).c;
  const action = ws?.action || 'kick';
  const maxWarns = ws?.max_warns || 5;
  const muteDur = ws?.mute_duration || '1h';

  const desc = [
    `**Current Settings**`,
    `  \u2022 Max Warns: **${maxWarns}**`,
    `  \u2022 Action: **${action}**${action === 'mute' ? ` (${muteDur})` : ''}`,
    `  \u2022 Total Warns Issued: **${count}**`,
    '',
    `**Set Warn Action**`,
  ].join('\n');

  return {
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('\u26A0\uFE0F Warn Settings').setDescription(desc)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_act_warncount').setLabel('\uD83D\uDD22 Set Max Warns').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('panel_act_mutedur').setLabel('\u23F1\uFE0F Mute Duration').setStyle(ButtonStyle.Primary),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_act_warnaction_kick').setLabel(`Kick${action === 'kick' ? ' \u2714\uFE0F' : ''}`).setStyle(action === 'kick' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('panel_act_warnaction_ban').setLabel(`Ban${action === 'ban' ? ' \u2714\uFE0F' : ''}`).setStyle(action === 'ban' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('panel_act_warnaction_mute').setLabel(`Mute${action === 'mute' ? ' \u2714\uFE0F' : ''}`).setStyle(action === 'mute' ? ButtonStyle.Success : ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_main').setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function panelWords(interaction) {
  const banWords = db.prepare('SELECT word, duration FROM word_filters WHERE guild_id = ? AND action = \'ban\'').all(interaction.guildId);
  const muteWords = db.prepare('SELECT word, duration FROM word_filters WHERE guild_id = ? AND action = \'mute\'').all(interaction.guildId);

  const desc = [
    `**Ban Words (${banWords.length})**`,
    banWords.length ? banWords.map(w => `  \u2022 ${w.word}${w.duration ? ` (\u2192 ${w.duration})` : ''}`).join('\n') : '  None',
    '',
    `**Mute Words (${muteWords.length})**`,
    muteWords.length ? muteWords.map(w => `  \u2022 ${w.word}${w.duration ? ` (\u2192 ${w.duration})` : ''}`).join('\n') : '  None',
  ].join('\n');

  return {
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('\uD83D\uDD0D Word Filters').setDescription(desc)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_act_banword').setLabel('\uD83D\uDEAB Add Ban Word').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('panel_act_muteword').setLabel('\uD83D\uDD07 Add Mute Word').setStyle(ButtonStyle.Primary),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_main').setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function panelAutoReply(interaction) {
  const rows = db.prepare('SELECT * FROM auto_replies WHERE guild_id = ?').all(interaction.guildId);
  const desc = rows.length
    ? rows.map(r => `  \u2022 **${r.trigger}** \u2192 ${r.response}`).join('\n')
    : 'No auto-replies configured.';

  return {
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle(`\uD83E\uDD16 Auto-Replies (${rows.length})`).setDescription(desc)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_act_autoreply').setLabel('\u2795 Add Auto-Reply').setStyle(ButtonStyle.Primary),
        ...(rows.length ? [new ButtonBuilder().setCustomId('panel_act_autoreply_del').setLabel('\u2796 Remove').setStyle(ButtonStyle.Danger)] : []),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_main').setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function panelLog(interaction) {
  const logChanId = db.prepare('SELECT log_channel_id FROM config WHERE guild_id = ?').get(interaction.guildId)?.log_channel_id;
  const allSettings = db.prepare('SELECT * FROM log_settings WHERE guild_id = ?').all(interaction.guildId);
  const settingsMap = {};
  for (const s of allSettings) settingsMap[s.log_type] = s;
  const access = hasPanelAccess(interaction.member);

  const desc = [
    `**Main Log Channel:** ${logChanId ? `<#${logChanId}>` : 'Not set'}`,
    '',
    '**Log Types**',
    ...Object.entries(LOG_NAMES).map(([key, label]) => {
      const s = settingsMap[key];
      const enabled = s ? s.enabled === 1 : true;
      const chanSuffix = s?.channel_id ? ` â†’ <#${s.channel_id}>` : '';
      return `  ${enabled ? 'ğŸŸ¢' : 'ğŸ”´'} **${label}**${chanSuffix}`;
    }),
    '',
    '*Use the dropdown to toggle a log type or set a separate channel.*',
  ].join('\n');

  const select = new StringSelectMenuBuilder().setCustomId('select_log_type').setPlaceholder('Select a log type...').addOptions(
    Object.entries(LOG_NAMES).map(([key, label]) => {
      const s = settingsMap[key];
      const enabled = s ? s.enabled === 1 : true;
      return { label: `${enabled ? 'ğŸŸ¢' : 'ğŸ”´'} ${label}`, value: key, description: enabled ? 'Click to configure' : 'Currently disabled' };
    }),
  );

  return {
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('\uD83D\uDCDD Log System').setDescription(desc)],
    components: [
      ...(access ? [new ActionRowBuilder().addComponents(
        select,
      )] : []),
      new ActionRowBuilder().addComponents(
        ...(access ? [new ButtonBuilder().setCustomId('panel_act_log').setLabel(logChanId ? '\uD83D\uDD04 Change Main Channel' : '\uD83D\uDD0D Set Main Channel').setStyle(ButtonStyle.Primary)] : []),
        ...(access ? [new ButtonBuilder().setCustomId('panel_act_log_reset').setLabel('\uD83D\uDD04 Reset All').setStyle(ButtonStyle.Danger)] : []),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_keywordlog').setLabel('\uD83D\uDD0D Keyword Triggers').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('panel_main').setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function panelKeywordLog(interaction) {
  const keywords = db.prepare('SELECT trigger FROM keyword_logs WHERE guild_id = ?').all(interaction.guildId);
  const access = hasPanelAccess(interaction.member);

  const desc = [
    '**Keyword Triggers** â€” When someone types a trigger word in any channel, it is logged.',
    '',
    keywords.length ? keywords.map(k => `  \u2022 \`${k.trigger}\``).join('\n') : '  No keywords configured.',
    '',
    `Total: **${keywords.length}** triggers`,
  ].join('\n');

  return {
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('\uD83D\uDD0D Keyword Triggers').setDescription(desc)],
    components: [
      ...(access ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_act_kw_add').setLabel('\u2795 Add Trigger').setStyle(ButtonStyle.Primary),
        ...(keywords.length ? [new ButtonBuilder().setCustomId('panel_act_kw_del').setLabel('\u2796 Remove Trigger').setStyle(ButtonStyle.Danger)] : []),
      )] : []),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_log').setLabel('\u2190 Back to Log').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function panelBans(interaction) {
  const rows = db.prepare('SELECT * FROM tempbans WHERE guild_id = ?').all(interaction.guildId);
  const desc = rows.length
    ? rows.map(r => `  \u2022 <@${r.user_id}> \u2192 ends <t:${Math.floor(r.ends_at / 1000)}:R>`).join('\n')
    : 'No active temp bans.';

  return {
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle(`\uD83D\uDD28 Temp Bans (${rows.length})`).setDescription(desc)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_main').setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
    )],
  };
}

function panelTag(interaction) {
  const tagChanId = db.prepare('SELECT tag_channel_id FROM config WHERE guild_id = ?').get(interaction.guildId)?.tag_channel_id;
  const desc = tagChanId ? `Welcome mention channel: <#${tagChanId}>` : 'No tag channel set. New members will not be welcomed.';
  return {
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('\uD83D\uDC4B Welcome Tag').setDescription(desc)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_act_tag').setLabel(tagChanId ? '\uD83D\uDD04 Change Channel' : '\uD83D\uDD0D Set Channel').setStyle(ButtonStyle.Primary),
        ...(tagChanId ? [new ButtonBuilder().setCustomId('panel_act_tag_disable').setLabel('\u274C Disable').setStyle(ButtonStyle.Danger)] : []),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_main').setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function panelTicket(interaction) {
  const cfg = db.prepare('SELECT * FROM ticket_config WHERE guild_id = ?').get(interaction.guildId);
  const desc = [
    `Category: ${cfg?.category_id ? `<#${cfg.category_id}>` : 'Not set'}`,
    `Support Role: ${cfg?.role_id ? `<@&${cfg.role_id}>` : 'Not set'}`,
    `Open Tickets: **${db.prepare("SELECT COUNT(*) as c FROM tickets WHERE guild_id = ? AND status = 'open'").get(interaction.guildId).c}**`,
  ].join('\n');
  return {
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('\uD83C\uDFAB Ticket System').setDescription(desc)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_act_ticket_cat').setLabel('\uD83D\uDCC2 Set Category').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('panel_act_ticket_role').setLabel('\uD83D\uDC64 Set Support Role').setStyle(ButtonStyle.Primary),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_main').setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function panelAI(interaction) {
  const cfg = db.prepare('SELECT * FROM ai_config WHERE guild_id = ?').get(interaction.guildId);
  const desc = cfg
    ? `Provider: **${cfg.provider}**\nModel: ${cfg.model || 'Default'}\nChannel: ${cfg.channel_id ? `<#${cfg.channel_id}>` : 'All channels'}\nAPI Key: ${cfg.api_key ? cfg.api_key.slice(0, 8) + '...' : 'Not set'}`
    : 'AI not configured.';
  const access = hasPanelAccess(interaction.member);
  return {
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('\uD83E\uDD16 AI Chat').setDescription(desc)],
    components: [
      new ActionRowBuilder().addComponents(
        ...(access ? [new ButtonBuilder().setCustomId('panel_act_ai').setLabel(cfg ? '\u2699\uFE0F Reconfigure' : '\u2795 Configure').setStyle(ButtonStyle.Primary)] : []),
        ...(access && cfg ? [new ButtonBuilder().setCustomId('panel_act_ai_disable').setLabel('\u274C Disable').setStyle(ButtonStyle.Danger)] : []),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_main').setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function panelPermissions(interaction) {
  const modRoles = db.prepare('SELECT mr.role_id, mr.permissions, r.name FROM mod_roles mr LEFT JOIN roles r ON r.id = mr.role_id WHERE mr.guild_id = ?').all(interaction.guildId);
  const adminCmd = db.prepare('SELECT command_name, allowed_roles FROM command_permissions WHERE guild_id = ?').all(interaction.guildId);
  const access = hasPanelAccess(interaction.member);

  const roleLines = modRoles.length
    ? modRoles.map(r => `  \u2022 <@&${r.role_id}>`).join('\n')
    : '  None configured. Anyone with MANAGE_GUILD can use this panel.';

  const cmdLines = adminCmd.length
    ? adminCmd.map(c => `  \u2022 **/${c.command_name}** \u2192 ${JSON.parse(c.allowed_roles || '[]').map(rId => `<@&${rId}>`).join(', ') || 'Owner only'}`).join('\n')
    : '  No command restrictions set (Owner only by default).';

  const desc = [
    `**Mod Roles (${modRoles.length})**`,
    roleLines,
    '',
    `**Command Access (${adminCmd.length})**`,
    cmdLines,
    '',
    '*Mod roles can use the panel UI. Per-command access restricts who can run that command.*',
  ].join('\n');

  return {
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('\uD83D\uDD11 Permissions').setDescription(desc)],
    components: [
      new ActionRowBuilder().addComponents(
        ...(access ? [new ButtonBuilder().setCustomId('panel_act_addmodrole').setLabel('\u2795 Add Mod Role').setStyle(ButtonStyle.Primary)] : []),
        ...(access && modRoles.length ? [new ButtonBuilder().setCustomId('panel_act_rmmodrole').setLabel('\u2796 Remove Mod Role').setStyle(ButtonStyle.Danger)] : []),
      ),
      new ActionRowBuilder().addComponents(
        ...(access ? [new ButtonBuilder().setCustomId('panel_act_setcmdperm').setLabel('\uD83D\uDD11 Set Command Access').setStyle(ButtonStyle.Primary)] : []),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_main').setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function panelGiveaway(interaction) {
  const rows = db.prepare('SELECT * FROM giveaways WHERE guild_id = ?').all(interaction.guildId);
  const access = hasPanelAccess(interaction.member);
  const desc = rows.length
    ? rows.map(r => {
        const entries = JSON.parse(r.entries || '[]');
        return `  \u2022 **${r.prize}** \u2014 ${entries.length} entries (ends <t:${Math.floor(r.ends_at / 1000)}:R>)`;
      }).join('\n')
    : 'No active giveaways.';

  return {
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle(`\uD83C\uDF89 Giveaways (${rows.length})`).setDescription(desc)],
    components: [
      new ActionRowBuilder().addComponents(
        ...(access ? [new ButtonBuilder().setCustomId('panel_act_giveaway').setLabel('\u2795 New Giveaway').setStyle(ButtonStyle.Primary)] : []),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_main').setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function panelAntiSpam(interaction) {
  const cfg = db.prepare('SELECT * FROM config WHERE guild_id = ?').get(interaction.guildId) || {};
  const whitelist = db.prepare('SELECT domain FROM invite_whitelist WHERE guild_id = ?').all(interaction.guildId);
  const longAction = cfg.long_msg_action || 'mute';
  const desc = [
    `**Anti-Spam** ${cfg.anti_spam_max ? 'ON' : 'OFF (using defaults)'}`,
    `  Max Messages: **${cfg.anti_spam_max || 5}** in **${cfg.anti_spam_window || 4}s**`,
    `  Mute Duration: **${cfg.anti_spam_mute || 300}s**`,
    '',
    `**Anti-Invite** ${cfg.anti_invite !== 0 ? 'ON' : 'OFF'}`,
    `  Warns per Invite: **${cfg.invite_warns || 2}**`,
    `  Mute Duration: **${cfg.invite_mute || 600}s**`,
    `  Whitelist (${whitelist.length}): ${whitelist.length ? whitelist.map(w => `\`${w.domain}\``).join(', ') : 'None'}`,
    '',
    `**Long Message** Threshold: **${cfg.long_msg_threshold || 2000}** chars`,
    `  Warns: **${cfg.long_msg_warns || 2}** | ${longAction === 'mute' ? `Mute: **${cfg.long_msg_mute || 3600}s**` : 'Action: **BAN**'}`,
  ].join('\n');
  return {
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('\uD83D\uDEE1\uFE0F Protection').setDescription(desc)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_act_antispam_max').setLabel('\uD83D\uDD22 Msg Limit').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('panel_act_antispam_window').setLabel('\u23F1\uFE0F Window').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('panel_act_antispam_mute').setLabel('\uD83D\uDD07 Spam Mute').setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_act_invite_warns').setLabel('\u26A0\uFE0F Inv Warns').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('panel_act_invite_mute').setLabel('\uD83D\uDD07 Inv Mute').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('panel_act_invite_whitelist').setLabel('\u2714\uFE0F Whitelist').setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_act_long_threshold').setLabel('\uD83D\uDCCF Long Threshold').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('panel_act_long_warns').setLabel('\u26A0\uFE0F Long Warns').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('panel_act_long_mute').setLabel('\uD83D\uDD07 Long Mute').setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_act_long_toggle').setLabel(`Long Action: ${longAction.toUpperCase()}`).setStyle(longAction === 'ban' ? ButtonStyle.Danger : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('panel_act_invite_toggle').setLabel(`Invites: ${cfg.anti_invite !== 0 ? 'ON' : 'OFF'}`).setStyle(cfg.anti_invite !== 0 ? ButtonStyle.Success : ButtonStyle.Danger),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_main').setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function createModal(id, title, fields) {
  const modal = new ModalBuilder().setCustomId(id).setTitle(title);
  for (const f of fields) {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(f.id).setLabel(f.label).setStyle(f.long ? TextInputStyle.Paragraph : TextInputStyle.Short).setPlaceholder(f.placeholder || '').setRequired(f.required !== false).setMinLength(f.min || 1).setMaxLength(f.max || 400),
    ));
  }
  return modal;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ PANEL BUTTON HANDLER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function handlePanelButton(interaction) {
  const id = interaction.customId;
  const access = hasPanelAccess(interaction.member);

  // Navigation â€” everyone can view, but action buttons are hidden from non-access users
  if (id === 'panel_log') return interaction.update(panelLog(interaction));
  if (id === 'panel_tag') return interaction.update(panelTag(interaction));
  if (id === 'panel_ticket') return interaction.update(panelTicket(interaction));
  if (id === 'panel_ai') return interaction.update(panelAI(interaction));
  if (id === 'panel_antispam') return interaction.update(panelAntiSpam(interaction));
  if (id === 'panel_bans') return interaction.update(panelBans(interaction));
  if (id === 'panel_main') return interaction.update(panelMain(interaction));
  if (id === 'panel_refresh') return interaction.update(panelMain(interaction));
  if (id === 'panel_stats') return interaction.update(panelStats(interaction));
  if (id === 'panel_polls') return interaction.update(panelPolls(interaction));
  if (id === 'panel_warns') return interaction.update(panelWarns(interaction));
  if (id === 'panel_words') return interaction.update(panelWords(interaction));
  if (id === 'panel_autoreply') return interaction.update(panelAutoReply(interaction));
  if (id === 'panel_permissions') return interaction.update(panelPermissions(interaction));
  if (id === 'panel_giveaway') return interaction.update(panelGiveaway(interaction));
  if (id === 'panel_keywordlog') return interaction.update(panelKeywordLog(interaction));
  if (id === 'panel_close') return interaction.message.delete().catch(() => {});

  // â”€â”€ All actions below require panel access â”€â”€
  if (!access) return interaction.reply({ content: 'You do not have permission to modify settings.', ephemeral: true });

  // Action modals
  if (id === 'panel_act_warncount') return interaction.showModal(createModal('modal_warncount', 'Set Max Warns', [{ id: 'count', label: 'Warn count (1-100)', placeholder: '5', min: 1, max: 3 }]));
  if (id === 'panel_act_mutedur') return interaction.showModal(createModal('modal_mutedur', 'Set Mute Duration', [{ id: 'duration', label: 'Duration (e.g. 1h, 30m, 2d)', placeholder: '1h', min: 1, max: 10 }]));
  if (id === 'panel_act_banword') return interaction.showModal(createModal('modal_banword', 'Add Ban Word', [
    { id: 'word', label: 'Word to auto-ban', placeholder: 'badword', min: 2, max: 50 },
    { id: 'duration', label: 'Duration (optional, e.g. 1h, 30m)', placeholder: 'Leave blank for permanent', min: 1, max: 10, required: false },
  ]));
  if (id === 'panel_act_muteword') return interaction.showModal(createModal('modal_muteword', 'Add Mute Word', [
    { id: 'word', label: 'Word to auto-mute', placeholder: 'badword', min: 2, max: 50 },
    { id: 'duration', label: 'Duration (optional, e.g. 1h, 30m)', placeholder: 'Default: 1h', min: 1, max: 10, required: false },
  ]));
  if (id === 'panel_act_autoreply') return interaction.showModal(createModal('modal_autoreply', 'Add Auto-Reply', [
    { id: 'trigger', label: 'Trigger word', placeholder: 'hello', min: 2, max: 100 },
    { id: 'response', label: 'Response', placeholder: 'Hi there!', min: 1, max: 500, long: true },
  ]));
  if (id === 'panel_act_autoreply_del') {
    const rows = db.prepare('SELECT trigger FROM auto_replies WHERE guild_id = ?').all(interaction.guildId);
    if (!rows.length) return interaction.reply({ content: 'No auto-replies to remove.', ephemeral: true });
    const select = new StringSelectMenuBuilder().setCustomId('select_autoreply_del').setPlaceholder('Pick one to remove').addOptions(
      rows.map(r => ({ label: r.trigger.length > 80 ? r.trigger.slice(0, 77) + '...' : r.trigger, value: r.trigger })),
    );
    return interaction.reply({ content: 'Select an auto-reply to remove:', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
  }
  if (id === 'panel_act_log') return interaction.showModal(createModal('modal_log', 'Set Log Channel', [{ id: 'channel', label: 'Channel ID', placeholder: 'Click channel > Copy ID', min: 17, max: 20 }]));
  if (id === 'panel_act_tag') return interaction.showModal(createModal('modal_tag', 'Set Tag Channel', [{ id: 'channel', label: 'Channel ID', placeholder: 'Click channel > Copy ID', min: 17, max: 20 }]));
  if (id === 'panel_act_ticket_cat') return interaction.showModal(createModal('modal_ticket_cat', 'Set Ticket Category', [{ id: 'cat', label: 'Category ID', placeholder: 'Category ID', min: 17, max: 20 }]));
  if (id === 'panel_act_ticket_role') return interaction.showModal(createModal('modal_ticket_role', 'Set Ticket Role', [{ id: 'role', label: 'Role ID', placeholder: 'Role ID', min: 17, max: 20 }]));
  if (id === 'panel_act_antispam_max') return interaction.showModal(createModal('modal_antispam_max', 'Spam: Max Messages', [{ id: 'val', label: 'Max messages in window', placeholder: '5', min: 1, max: 3 }]));
  if (id === 'panel_act_antispam_window') return interaction.showModal(createModal('modal_antispam_window', 'Spam: Window (seconds)', [{ id: 'val', label: 'Time window in seconds', placeholder: '4', min: 1, max: 3 }]));
  if (id === 'panel_act_antispam_mute') return interaction.showModal(createModal('modal_antispam_mute', 'Spam: Mute Duration (s)', [{ id: 'val', label: 'Mute duration in seconds', placeholder: '300', min: 1, max: 5 }]));
  if (id === 'panel_act_invite_warns') return interaction.showModal(createModal('modal_invite_warns', 'Invite: Warns to Add', [{ id: 'val', label: 'Number of warns per invite', placeholder: '2', min: 1, max: 2 }]));
  if (id === 'panel_act_invite_mute') return interaction.showModal(createModal('modal_invite_mute', 'Invite: Mute Duration (s)', [{ id: 'val', label: 'Mute duration in seconds', placeholder: '600', min: 1, max: 5 }]));
  if (id === 'panel_act_invite_whitelist') return interaction.showModal(createModal('modal_invite_whitelist', 'Add Whitelist Domain', [{ id: 'domain', label: 'Domain (e.g. discord.gg/myserver)', placeholder: 'discord.gg/myserver', min: 3, max: 100 }]));
  if (id === 'panel_act_ai') return interaction.showModal(createModal('modal_ai', 'Configure AI', [
    { id: 'provider', label: 'Provider (deepseek/openai/gemini/grok/claude)', placeholder: 'deepseek', min: 3, max: 20 },
    { id: 'api_key', label: 'API Key', placeholder: 'sk-...', min: 8, max: 200 },
    { id: 'model', label: 'Model (leave blank for default)', placeholder: 'deepseek-chat', min: 1, max: 50 },
    { id: 'channel', label: 'Channel ID (blank=all channels)', placeholder: 'Optional', min: 1, max: 20 },
  ]));
  if (id === 'panel_act_long_threshold') return interaction.showModal(createModal('modal_long_threshold', 'Long Msg: Max Chars', [{ id: 'val', label: 'Character threshold', placeholder: '2000', min: 1, max: 5 }]));
  if (id === 'panel_act_long_warns') return interaction.showModal(createModal('modal_long_warns', 'Long Msg: Warns', [{ id: 'val', label: 'Warns per long message', placeholder: '2', min: 1, max: 2 }]));
  if (id === 'panel_act_long_mute') return interaction.showModal(createModal('modal_long_mute', 'Long Msg: Mute (s)', [{ id: 'val', label: 'Mute duration in seconds', placeholder: '3600', min: 1, max: 6 }]));
  if (id === 'panel_act_addmodrole') return interaction.showModal(createModal('modal_addmodrole', 'Add Mod Role', [{ id: 'role', label: 'Role ID', placeholder: 'Paste role ID', min: 17, max: 20 }]));
  if (id === 'panel_act_rmmodrole') {
    const rows = db.prepare('SELECT role_id FROM mod_roles WHERE guild_id = ?').all(interaction.guildId);
    if (!rows.length) return interaction.reply({ content: 'No mod roles configured.', ephemeral: true });
    const select = new StringSelectMenuBuilder().setCustomId('select_rmmodrole').setPlaceholder('Pick a role to remove').addOptions(
      rows.map(r => ({ label: `Role ${r.role_id}`, value: r.role_id })),
    );
    return interaction.reply({ content: 'Select a mod role to remove:', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
  }
  if (id === 'panel_act_setcmdperm') return interaction.showModal(createModal('modal_setcmdperm', 'Set Command Access', [
    { id: 'command', label: 'Command name (without /)', placeholder: 'warn', min: 2, max: 50 },
    { id: 'roles', label: 'Role IDs (comma-separated)', placeholder: '123,456,789', min: 1, max: 200 },
  ]));
  if (id === 'panel_act_giveaway') return interaction.showModal(createModal('modal_giveaway', 'New Giveaway', [
    { id: 'prize', label: 'Prize', placeholder: 'Discord Nitro', min: 2, max: 100 },
    { id: 'duration', label: 'Duration (e.g. 1h, 2d)', placeholder: '24h', min: 1, max: 10 },
    { id: 'winners', label: 'Winner count', placeholder: '1', min: 1, max: 2 },
  ]));
  if (id === 'panel_act_kw_add') return interaction.showModal(createModal('modal_kw_add', 'Add Keyword Trigger', [{ id: 'trigger', label: 'Keyword to log', placeholder: 'example.com', min: 2, max: 100 }]));
  if (id === 'panel_act_kw_del') {
    const keywords = db.prepare('SELECT trigger FROM keyword_logs WHERE guild_id = ?').all(interaction.guildId);
    if (!keywords.length) return interaction.reply({ content: 'No triggers to remove.', ephemeral: true });
    const select = new StringSelectMenuBuilder().setCustomId('select_kw_del').setPlaceholder('Pick a trigger to remove').addOptions(
      keywords.map(k => ({ label: k.trigger.length > 80 ? k.trigger.slice(0, 77) + '...' : k.trigger, value: k.trigger })),
    );
    return interaction.reply({ content: 'Select a keyword trigger to remove:', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
  }

  // Quick actions
  if (id.startsWith('panel_act_warnaction_')) {
    const act = id.replace('panel_act_warnaction_', '');
    if (!['kick', 'ban', 'mute'].includes(act)) return;
    db.prepare('INSERT OR REPLACE INTO warn_settings (guild_id, max_warns, action, mute_duration) VALUES (?,COALESCE((SELECT max_warns FROM warn_settings WHERE guild_id = ?),5),?,COALESCE((SELECT mute_duration FROM warn_settings WHERE guild_id = ?),\'1h\'))')
      .run(interaction.guildId, interaction.guildId, act, interaction.guildId);
    await interaction.update(panelWarns(interaction));
    await sendModLog(interaction.guild, { Action: 'Warn Action Changed', Moderator: interaction.user.tag, NewAction: act });
  }

  if (id === 'panel_act_tag_disable') {
    ensureConfig(interaction.guildId);
    setConfig(interaction.guildId, 'tag_channel_id', null);
    await interaction.update(panelTag(interaction));
  }

  if (id === 'panel_act_ai_disable') {
    db.prepare('DELETE FROM ai_config WHERE guild_id = ?').run(interaction.guildId);
    await interaction.update(panelAI(interaction));
  }

  if (id === 'panel_act_invite_toggle') {
    const cfg = db.prepare('SELECT anti_invite FROM config WHERE guild_id = ?').get(interaction.guildId) || {};
    const newVal = cfg.anti_invite !== 0 ? 0 : 1;
    ensureConfig(interaction.guildId);
    setConfig(interaction.guildId, 'anti_invite', newVal);
    await interaction.update(panelAntiSpam(interaction));
  }

  if (id === 'panel_act_long_toggle') {
    const cfg = db.prepare('SELECT long_msg_action FROM config WHERE guild_id = ?').get(interaction.guildId) || {};
    const newVal = cfg.long_msg_action === 'ban' ? 'mute' : 'ban';
    ensureConfig(interaction.guildId);
    setConfig(interaction.guildId, 'long_msg_action', newVal);
    await interaction.update(panelAntiSpam(interaction));
  }

  if (id === 'panel_act_log_reset') {
    db.prepare('DELETE FROM log_settings WHERE guild_id = ?').run(interaction.guildId);
    await interaction.update(panelLog(interaction));
  }
}

async function handlePanelModal(interaction) {
  try {
    const access = hasPanelAccess(interaction.member);
    if (!access) return interaction.reply({ content: 'You do not have permission to modify settings.', ephemeral: true });
    const id = interaction.customId;

  if (id === 'modal_warncount') {
    const count = parseInt(interaction.fields.getTextInputValue('count'));
    if (isNaN(count) || count < 1 || count > 100) return interaction.reply({ content: 'Invalid count (1-100).', ephemeral: true });
    db.prepare('INSERT OR REPLACE INTO warn_settings (guild_id, max_warns, action, mute_duration) VALUES (?,?,COALESCE((SELECT action FROM warn_settings WHERE guild_id = ?),\'kick\'),COALESCE((SELECT mute_duration FROM warn_settings WHERE guild_id = ?),\'1h\'))')
      .run(interaction.guildId, count, interaction.guildId, interaction.guildId);
    await interaction.update(panelWarns(interaction));
    await sendModLog(interaction.guild, { Action: 'Max Warns Changed', Moderator: interaction.user.tag, NewCount: count });
    return;
  }

  if (id === 'modal_mutedur') {
    const dur = interaction.fields.getTextInputValue('duration');
    const sec = getTimeSeconds(dur);
    if (!sec || sec < 60 || sec > 2419200) return interaction.reply({ content: 'Invalid duration (min 1m, max 28d).', ephemeral: true });
    db.prepare('INSERT OR REPLACE INTO warn_settings (guild_id, max_warns, action, mute_duration) VALUES (?,COALESCE((SELECT max_warns FROM warn_settings WHERE guild_id = ?),5),COALESCE((SELECT action FROM warn_settings WHERE guild_id = ?),\'kick\'),?)')
      .run(interaction.guildId, interaction.guildId, interaction.guildId, dur);
    await interaction.update(panelWarns(interaction));
    await sendModLog(interaction.guild, { Action: 'Mute Duration Changed', Moderator: interaction.user.tag, NewDuration: dur });
    return;
  }

  if (id === 'modal_banword') {
    const word = interaction.fields.getTextInputValue('word').toLowerCase();
    const duration = interaction.fields.getTextInputValue('duration')?.trim() || null;
    if (word.length < 2) return interaction.reply({ content: 'Word must be at least 2 chars.', ephemeral: true });
    if (duration && !getTimeSeconds(duration)) return interaction.reply({ content: 'Invalid duration format. Use e.g. 1h, 30m.', ephemeral: true });
    db.prepare('INSERT OR REPLACE INTO word_filters VALUES (?,?,?,?)').run(interaction.guildId, word, 'ban', duration);
    await interaction.update(panelWords(interaction));
    await sendModLog(interaction.guild, { Action: 'Ban Word Added', Moderator: interaction.user.tag, Word: word, Duration: duration || 'permanent' });
    return;
  }

  if (id === 'modal_muteword') {
    const word = interaction.fields.getTextInputValue('word').toLowerCase();
    const duration = interaction.fields.getTextInputValue('duration')?.trim() || null;
    if (word.length < 2) return interaction.reply({ content: 'Word must be at least 2 chars.', ephemeral: true });
    if (duration && !getTimeSeconds(duration)) return interaction.reply({ content: 'Invalid duration format. Use e.g. 1h, 30m.', ephemeral: true });
    db.prepare('INSERT OR REPLACE INTO word_filters VALUES (?,?,?,?)').run(interaction.guildId, word, 'mute', duration || null);
    await interaction.update(panelWords(interaction));
    await sendModLog(interaction.guild, { Action: 'Mute Word Added', Moderator: interaction.user.tag, Word: word, Duration: duration || '1h' });
    return;
  }

  if (id === 'modal_autoreply') {
    const trigger = interaction.fields.getTextInputValue('trigger').toLowerCase();
    const response = interaction.fields.getTextInputValue('response');
    if (trigger.length < 2 || trigger.length > 100) return interaction.reply({ content: 'Trigger must be 2-100 chars.', ephemeral: true });
    if (response.length < 1 || response.length > 500) return interaction.reply({ content: 'Response must be 1-500 chars.', ephemeral: true });
    db.prepare('INSERT OR REPLACE INTO auto_replies VALUES (?,?,?)').run(interaction.guildId, trigger, response);
    await interaction.update(panelAutoReply(interaction));
    await sendModLog(interaction.guild, { Action: 'Auto-Reply Added', Moderator: interaction.user.tag, Trigger: trigger });
    return;
  }

  if (id === 'modal_antispam_max') {
    const val = parseInt(interaction.fields.getTextInputValue('val'));
    if (isNaN(val) || val < 1 || val > 100) return interaction.reply({ content: 'Enter 1-100.', ephemeral: true });
    ensureConfig(interaction.guildId);
    setConfig(interaction.guildId, 'anti_spam_max', val);
    await interaction.update(panelAntiSpam(interaction));
    return;
  }

  if (id === 'modal_antispam_window') {
    const val = parseInt(interaction.fields.getTextInputValue('val'));
    if (isNaN(val) || val < 1 || val > 60) return interaction.reply({ content: 'Enter 1-60.', ephemeral: true });
    ensureConfig(interaction.guildId);
    setConfig(interaction.guildId, 'anti_spam_window', val);
    await interaction.update(panelAntiSpam(interaction));
    return;
  }

  if (id === 'modal_antispam_mute') {
    const val = parseInt(interaction.fields.getTextInputValue('val'));
    if (isNaN(val) || val < 1 || val > 86400) return interaction.reply({ content: 'Enter 1-86400.', ephemeral: true });
    ensureConfig(interaction.guildId);
    setConfig(interaction.guildId, 'anti_spam_mute', val);
    await interaction.update(panelAntiSpam(interaction));
    return;
  }

  if (id === 'modal_invite_warns') {
    const val = parseInt(interaction.fields.getTextInputValue('val'));
    if (isNaN(val) || val < 1 || val > 100) return interaction.reply({ content: 'Enter 1-100.', ephemeral: true });
    ensureConfig(interaction.guildId);
    setConfig(interaction.guildId, 'invite_warns', val);
    await interaction.update(panelAntiSpam(interaction));
    return;
  }

  if (id === 'modal_invite_mute') {
    const val = parseInt(interaction.fields.getTextInputValue('val'));
    if (isNaN(val) || val < 1 || val > 86400) return interaction.reply({ content: 'Enter 1-86400.', ephemeral: true });
    ensureConfig(interaction.guildId);
    setConfig(interaction.guildId, 'invite_mute', val);
    await interaction.update(panelAntiSpam(interaction));
    return;
  }

  if (id === 'modal_invite_whitelist') {
    const domain = interaction.fields.getTextInputValue('domain').toLowerCase().trim();
    if (domain.length < 2) return interaction.reply({ content: 'Invalid domain.', ephemeral: true });
    db.prepare('INSERT OR REPLACE INTO invite_whitelist VALUES (?,?)').run(interaction.guildId, domain);
    await interaction.update(panelAntiSpam(interaction));
    return;
  }

  if (id === 'modal_log') {
    const channelId = interaction.fields.getTextInputValue('channel').replace(/[<#>]/g, '');
    try {
      const channel = await interaction.guild.channels.fetch(channelId);
      if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
        return interaction.reply({ content: 'Invalid channel ID or not a text channel.', ephemeral: true });
      }
      ensureConfig(interaction.guildId);
      setConfig(interaction.guildId, 'log_channel_id', channelId);
      await interaction.update(panelLog(interaction));
      await sendModLog(interaction.guild, { Action: 'Log Channel Set', Moderator: interaction.user.tag, Channel: `<#${channelId}>` });
    } catch {
      await interaction.reply({ content: 'Could not find that channel. Use a valid text channel ID.', ephemeral: true });
    }
    return;
  }

  if (id === 'modal_tag') {
    const channelId = interaction.fields.getTextInputValue('channel').replace(/[<#>]/g, '');
    try {
      const channel = await interaction.guild.channels.fetch(channelId);
      if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
        return interaction.reply({ content: 'Invalid channel ID.', ephemeral: true });
      }
      ensureConfig(interaction.guildId);
      setConfig(interaction.guildId, 'tag_channel_id', channelId);
      await interaction.update(panelTag(interaction));
      await sendModLog(interaction.guild, { Action: 'Tag Channel Set', Moderator: interaction.user.tag, Channel: `<#${channelId}>` });
    } catch {
      await interaction.reply({ content: 'Could not find that channel.', ephemeral: true });
    }
    return;
  }

  if (id === 'modal_ticket_cat') {
    const catId = interaction.fields.getTextInputValue('cat');
    try {
      const cat = await interaction.guild.channels.fetch(catId);
      if (!cat || cat.type !== ChannelType.GuildCategory) {
        return interaction.reply({ content: 'Invalid category ID.', ephemeral: true });
      }
      db.prepare('INSERT OR REPLACE INTO ticket_config (guild_id, category_id, role_id) VALUES (?,?,COALESCE((SELECT role_id FROM ticket_config WHERE guild_id = ?),NULL))')
        .run(interaction.guildId, catId, interaction.guildId);
      await interaction.update(panelTicket(interaction));
    } catch {
      await interaction.reply({ content: 'Could not find that category.', ephemeral: true });
    }
    return;
  }

  if (id === 'modal_ticket_role') {
    const roleId = interaction.fields.getTextInputValue('role');
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) return interaction.reply({ content: 'Invalid role ID.', ephemeral: true });
    db.prepare('INSERT OR REPLACE INTO ticket_config (guild_id, category_id, role_id) VALUES (?,COALESCE((SELECT category_id FROM ticket_config WHERE guild_id = ?),NULL),?)')
      .run(interaction.guildId, interaction.guildId, roleId);
    await interaction.update(panelTicket(interaction));
    return;
  }

  if (id === 'modal_ai') {
    const provider = interaction.fields.getTextInputValue('provider');
    const apiKey = interaction.fields.getTextInputValue('api_key');
    const model = interaction.fields.getTextInputValue('model');
    const channelIdStr = interaction.fields.getTextInputValue('channel').trim();
    if (!apiKey) return interaction.reply({ content: 'API key is required.', ephemeral: true });
    const existing = db.prepare('SELECT channel_id FROM ai_config WHERE guild_id = ?').get(interaction.guildId);
    const finalChannel = channelIdStr || existing?.channel_id || null;
    db.prepare('INSERT OR REPLACE INTO ai_config (guild_id, provider, api_key, model, channel_id) VALUES (?,?,?,?,?)')
      .run(interaction.guildId, provider, apiKey, model || '', finalChannel);
    await interaction.update(panelAI(interaction));
    await sendModLog(interaction.guild, { Action: 'AI Configured', Moderator: interaction.user.tag, Provider: provider });
    return;
  }

  if (id === 'modal_long_threshold') {
    const val = parseInt(interaction.fields.getTextInputValue('val'));
    if (isNaN(val) || val < 100 || val > 10000) return interaction.reply({ content: 'Enter 100-10000.', ephemeral: true });
    ensureConfig(interaction.guildId);
    setConfig(interaction.guildId, 'long_msg_threshold', val);
    await interaction.update(panelAntiSpam(interaction));
    return;
  }

  if (id === 'modal_long_warns') {
    const val = parseInt(interaction.fields.getTextInputValue('val'));
    if (isNaN(val) || val < 1 || val > 100) return interaction.reply({ content: 'Enter 1-100.', ephemeral: true });
    ensureConfig(interaction.guildId);
    setConfig(interaction.guildId, 'long_msg_warns', val);
    await interaction.update(panelAntiSpam(interaction));
    return;
  }

  if (id === 'modal_long_mute') {
    const val = parseInt(interaction.fields.getTextInputValue('val'));
    if (isNaN(val) || val < 1 || val > 86400) return interaction.reply({ content: 'Enter 1-86400.', ephemeral: true });
    ensureConfig(interaction.guildId);
    setConfig(interaction.guildId, 'long_msg_mute', val);
    await interaction.update(panelAntiSpam(interaction));
    return;
  }

  if (id === 'modal_addmodrole') {
    const roleId = interaction.fields.getTextInputValue('role');
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) return interaction.reply({ content: 'Invalid role ID.', ephemeral: true });
    db.prepare('INSERT OR REPLACE INTO mod_roles VALUES (?,?,?)').run(interaction.guildId, roleId, '{}');
    await interaction.update(panelPermissions(interaction));
    return;
  }

  if (id === 'modal_setcmdperm') {
    const command = interaction.fields.getTextInputValue('command').toLowerCase().replace('/', '');
    const rolesStr = interaction.fields.getTextInputValue('roles');
    const roleIds = rolesStr.split(',').map(s => s.trim()).filter(s => s.length > 0 && interaction.guild.roles.cache.has(s));
    if (!roleIds.length) return interaction.reply({ content: 'No valid role IDs provided.', ephemeral: true });
    setCommandAccess(interaction.guildId, command, roleIds);
    await interaction.update(panelPermissions(interaction));
    return;
  }

  if (id === 'modal_giveaway') {
    try {
      const prize = interaction.fields.getTextInputValue('prize');
      const duration = interaction.fields.getTextInputValue('duration');
      const winnersStr = interaction.fields.getTextInputValue('winners');
      const winners = parseInt(winnersStr);
      const sec = getTimeSeconds(duration);
      if (!prize || !sec || sec < 60 || isNaN(winners) || winners < 1) {
        return interaction.reply({ content: 'Invalid inputs. Prize required, duration min 1m, winners min 1.', ephemeral: true });
      }
      await interaction.deferUpdate();
      const endsAt = Date.now() + sec * 1000;
      const msg = await interaction.channel.send({ content: `\uD83C\uDF89 **Giveaway: ${prize}**\nReact \uD83C\uDF89 to enter!\nEnds: <t:${Math.floor(endsAt / 1000)}:R>` });
      await msg.react('\uD83C\uDF89');
      db.prepare('INSERT INTO giveaways VALUES (?,?,?,?,?,?,?,?)').run(msg.id, interaction.guildId, interaction.channel.id, prize, winners, endsAt, interaction.user.id, '[]');
    } catch {}
    try { await interaction.editReply({ embeds: [panelGiveaway(interaction).embeds[0]], components: panelGiveaway(interaction).components }); } catch {}
    return;
  }

  if (id === 'modal_kw_add') {
    const trigger = interaction.fields.getTextInputValue('trigger').toLowerCase().trim();
    if (trigger.length < 2) return interaction.reply({ content: 'Trigger must be at least 2 characters.', ephemeral: true });
    db.prepare('INSERT OR REPLACE INTO keyword_logs VALUES (?,?)').run(interaction.guildId, trigger);
    await interaction.update(panelKeywordLog(interaction));
    await sendModLog(interaction.guild, { Action: 'Keyword Trigger Added', Moderator: interaction.user.tag, Trigger: trigger });
    return;
  }

  if (id.startsWith('log_channel_modal_')) {
    const logType = id.replace('log_channel_modal_', '');
    const channelId = interaction.fields.getTextInputValue('channel').replace(/[<#>]/g, '');
    try {
      let channel = interaction.guild.channels.cache.get(channelId);
      if (!channel) channel = await interaction.guild.channels.fetch(channelId);
      if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement && channel.type !== ChannelType.GuildForum && channel.type !== ChannelType.GuildMedia)) {
        return interaction.reply({ content: 'Invalid channel ID or not a text channel.', ephemeral: true });
      }
      db.prepare('INSERT OR REPLACE INTO log_settings VALUES (?,?,COALESCE((SELECT enabled FROM log_settings WHERE guild_id = ? AND log_type = ?),1),?)').run(interaction.guildId, logType, interaction.guildId, logType, channelId);
      await interaction.reply({ content: `${LOG_NAMES[logType] || logType} will log to <#${channelId}>.`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: `Error: could not find that channel. Use a valid text channel ID.`, ephemeral: true });
    }
    return;
  }
  } catch {}
}

// â”€â”€ Permission helpers â”€â”€
function hasPanelAccess(member) {
  if (member.id === OWNER_ID) return 'owner';
  const rows = db.prepare('SELECT role_id FROM mod_roles WHERE guild_id = ?').all(member.guild.id);
  if (!rows.length) return false;
  const has = rows.some(r => member.roles.cache.has(r.role_id));
  return has ? 'mod' : false;
}

function getModRoles(guildId) {
  return db.prepare('SELECT mr.role_id, mr.permissions, r.name FROM mod_roles mr LEFT JOIN roles r ON r.id = mr.role_id WHERE mr.guild_id = ?').all(guildId);
}

function canAccessCommand(member, command) {
  if (member.id === OWNER_ID) return true;
  const row = db.prepare('SELECT allowed_roles FROM command_permissions WHERE guild_id = ? AND command_name = ?').get(member.guild.id, command);
  if (!row) return false;
  const roles = JSON.parse(row.allowed_roles || '[]');
  return roles.some(rId => member.roles.cache.has(rId));
}

function getCommandAccess(guildId, command) {
  const row = db.prepare('SELECT allowed_roles FROM command_permissions WHERE guild_id = ? AND command_name = ?').get(guildId, command);
  return row ? JSON.parse(row.allowed_roles || '[]') : [];
}

function setCommandAccess(guildId, command, roles) {
  db.prepare('INSERT OR REPLACE INTO command_permissions VALUES (?,?,?)').run(guildId, command, JSON.stringify(roles));
}

const slashCommands = [
  { name: 'help', description: 'Show all commands' },
  { name: 'poll', description: 'Create a voting poll', options: [
    { name: 'options', description: 'Choices separated by comma', type: 3, required: true },
    { name: 'time', description: 'Duration (e.g. 30s, 1h, 2d, 1w)', type: 3, required: false },
    { name: 'description', description: 'What is this poll about?', type: 3, required: false },
    { name: 'ping', description: 'Ping when poll ends', type: 3, required: false, choices: [
      { name: 'No ping', value: 'none' }, { name: '@here', value: 'here' }, { name: '@everyone', value: 'everyone' },
    ]},
  ]},
  { name: 'endpoll', description: 'End a poll', options: [{ name: 'message_id', description: 'Poll message ID', type: 3, required: true }] },
  { name: 'setlog', description: 'Set log channel', options: [{ name: 'channel', description: 'Channel', type: 7, required: true }] },
  { name: 'activepolls', description: 'List active polls' },
  { name: 'history', description: 'Show past poll results' },
  { name: 'subscribe', description: 'Toggle DM notifications for new polls' },
  { name: 'announce', description: 'Announce the winner', options: [
    { name: 'message_id', description: 'Poll message ID', type: 3, required: true },
    { name: 'ping', description: 'Ping type', type: 3, required: false, choices: [
      { name: 'No ping', value: 'none' }, { name: '@here', value: 'here' }, { name: '@everyone', value: 'everyone' },
    ]},
  ]},
  { name: 'warncount', description: 'Set max warns before action', options: [
    { name: 'count', description: 'Number of warns', type: 4, required: true },
  ]},
  { name: 'warnsetting', description: 'Set action when warn limit reached', options: [
    { name: 'action', description: 'Action', type: 3, required: true, choices: [
      { name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' }, { name: 'Mute', value: 'mute' },
    ]},
    { name: 'duration', description: 'Mute duration (e.g. 1h, 30m, 1d)', type: 3, required: false },
  ]},
  { name: 'warnsettings', description: 'Show warn settings' },
  { name: 'banword', description: 'Manage banned words', options: [
    { name: 'action', description: 'Action', type: 3, required: true, choices: [
      { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'List', value: 'list' },
    ]},
    { name: 'word', description: 'Word to add/remove', type: 3, required: false },
    { name: 'duration', description: 'Mute duration for muteword (e.g. 1h, 30m)', type: 3, required: false },
  ]},
  { name: 'muteword', description: 'Manage mute-triggering words', options: [
    { name: 'action', description: 'Action', type: 3, required: true, choices: [
      { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'List', value: 'list' },
    ]},
    { name: 'word', description: 'Word to add/remove', type: 3, required: false },
    { name: 'duration', description: 'Mute duration (e.g. 1h, 30m)', type: 3, required: false },
  ]},
  { name: 'giverole', description: 'Give or remove a role from a user', options: [
    { name: 'user', description: 'Target user', type: 6, required: true },
    { name: 'role', description: 'Role name or ID', type: 3, required: true },
  ]},
  { name: 'automessage', description: 'Add/remove/list auto-reply triggers', options: [
    { name: 'action', description: 'Action', type: 3, required: true, choices: [
      { name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'List', value: 'list' },
    ]},
    { name: 'trigger', description: 'Word that triggers the reply', type: 3, required: false },
    { name: 'response', description: 'What the bot should reply', type: 3, required: false },
  ]},
  { name: 'bantime', description: 'Change ban duration for a tempbanned user', options: [
    { name: 'user_id', description: 'User ID of the banned user', type: 3, required: true },
    { name: 'duration', description: 'New duration (e.g. 1h, 2d, 1w)', type: 3, required: true },
  ]},
  { name: 'tagchannel', description: 'Set welcome mention channel', options: [
    { name: 'channel', description: 'Channel to mention new members', type: 7, required: false },
  ]},
  { name: 'afk', description: 'Set yourself as AFK', options: [
    { name: 'reason', description: 'Why are you AFK?', type: 3, required: false },
  ]},
  { name: 'ticket', description: 'Open a support ticket' },
  { name: 'ai', description: 'Configure AI chat', options: [
    { name: 'provider', description: 'AI provider', type: 3, required: true, choices: [
      { name: 'DeepSeek', value: 'deepseek' }, { name: 'OpenAI', value: 'openai' },
      { name: 'Gemini', value: 'gemini' }, { name: 'Grok', value: 'grok' },
      { name: 'Claude', value: 'claude' }, { name: 'Custom', value: 'custom' },
    ]},
    { name: 'api_key', description: 'API key for the provider', type: 3, required: true },
    { name: 'model', description: 'Model name (e.g. deepseek-chat, gpt-4o)', type: 3, required: false },
    { name: 'channel', description: 'Restrict to one channel', type: 7, required: false },
  ]},
  { name: 'settings', description: 'Show bot settings panel' },
  { name: 'panel', description: 'Owner-only admin panel' },
  { name: 'sendmessage', description: 'Send a message as the bot (owner only)', options: [
    { name: 'message', description: 'Message content', type: 3, required: true },
  ]},
  { name: 'rules', description: 'Send server rules (owner only)' },
  { name: 'roleall', description: 'Give a role to all members (owner only)', options: [
    { name: 'role', description: 'Role to give', type: 8, required: true },
  ]},
  { name: 'removeall', description: 'Remove a role from all members (owner only)', options: [
    { name: 'role', description: 'Role to remove', type: 8, required: true },
  ]},
  { name: 'slowmode', description: 'Set channel slowmode (owner only)', options: [
    { name: 'duration', description: 'Duration in seconds (0 to disable)', type: 4, required: true },
  ]},
  { name: 'lock', description: 'Lock channel for everyone (owner only)' },
  { name: 'unlock', description: 'Unlock channel for everyone (owner only)' },
  { name: 'nick', description: 'Change a user nickname (owner only)', options: [
    { name: 'user', description: 'Target user', type: 6, required: true },
    { name: 'name', description: 'New nickname', type: 3, required: true },
  ]},
  { name: 'emoji', description: 'Add a custom emoji (owner only)', options: [
    { name: 'name', description: 'Emoji name', type: 3, required: true },
    { name: 'url', description: 'Image URL for the emoji', type: 3, required: true },
  ]},
  { name: 'userinfo', description: 'Show user information', options: [
    { name: 'user', description: 'Target user', type: 6, required: false },
  ]},
  { name: 'serverinfo', description: 'Show server information' },
  { name: 'say', description: 'Send a message to a channel (owner only)', options: [
    { name: 'channel', description: 'Target channel', type: 7, required: true },
    { name: 'message', description: 'Message content', type: 3, required: true },
  ]},
  { name: 'remind', description: 'Set a reminder (DM)', options: [
    { name: 'duration', description: 'Duration (e.g. 10m, 1h, 1d)', type: 3, required: true },
    { name: 'message', description: 'Reminder message', type: 3, required: true },
  ]},
  { name: 'purge', description: 'Delete messages from a user', options: [
    { name: 'user', description: 'Target user', type: 6, required: false },
    { name: 'amount', description: 'Number of messages', type: 4, required: false },
  ]},
  { name: 'giveaway', description: 'Start a giveaway (owner only)', options: [
    { name: 'duration', description: 'Duration (e.g. 1h, 2d, 1w)', type: 3, required: true },
    { name: 'prize', description: 'Prize to give away', type: 3, required: true },
    { name: 'winners', description: 'Number of winners (default 1)', type: 4, required: false },
    { name: 'channel', description: 'Channel to post (default current)', type: 7, required: false },
  ]},
  { name: 'endgiveaway', description: 'End a giveaway early (owner only)', options: [
    { name: 'message_id', description: 'Giveaway message ID', type: 3, required: true },
  ]},
  { name: 'reroll', description: 'Reroll giveaway winners (owner only)', options: [
    { name: 'message_id', description: 'Giveaway message ID', type: 3, required: true },
  ]},
  { name: 'entervc', description: 'Bot joins a voice channel', options: [
    { name: 'channel', description: 'Voice channel', type: 7, required: true },
  ]},
  { name: 'leavevc', description: 'Bot leaves the voice channel', options: [
    { name: 'channel', description: 'Voice channel (optional)', type: 7, required: false },
  ]},
  { name: 'avatar', description: 'Show a user avatar', options: [
    { name: 'user', description: 'Target user', type: 6, required: false },
  ]},
  { name: 'banner', description: 'Show a user banner', options: [
    { name: 'user', description: 'Target user', type: 6, required: false },
  ]},
];

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ CLIENT EVENTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

client.once('ready', async () => {
  console.log(`[ONLINE] ${client.user.tag}`);
  generateBanner();
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    console.log(`[ERROR] Bot not in guild ${GUILD_ID}`);
    console.log(`[INVITE] https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&permissions=${PermissionFlagsBits.Administrator}&scope=bot%20applications.commands`);
    return;
  }
  console.log(`[GUILD] ${guild.name}`);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: slashCommands })
    .then(() => console.log('[CMDS] Registered'))
    .catch(e => console.log('[CMDS]', e.message));
  loadPolls();
  loadGiveaways();
  checkTempBans();
  setInterval(checkTempBans, 60000);
  console.log(`[CACHE] ${cache.size} polls, temp ban checker active`);
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ COMPREHENSIVE LOGGING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

client.on('messageDelete', (msg) => {
  if (msg.author?.bot || !msg.guild) return;
  // Always store in snipe cache
  snipe.add(msg.guild.id, msg.channel.id, {
    authorId: msg.author.id, author: msg.author.tag, content: msg.content || '(no text)',
    timestamp: Date.now(),
  });
  const e = new EmbedBuilder().setColor(0xe74c3c).setTitle('Message Deleted').setDescription(`**Author:** <@${msg.author.id}> (\`${msg.author.tag}\`)\n**Channel:** <#${msg.channel.id}>\n**Content:** ${msg.content || '*No text content*'}`).setFooter({ text: `Author: ${msg.author.id}` }).setTimestamp(msg.createdTimestamp);
  sendLog(msg.guild, LOG_TYPES.MESSAGE_DELETE, e);
});

client.on('messageUpdate', (oldMsg, newMsg) => {
  if (!oldMsg.content || !newMsg.content || oldMsg.content === newMsg.content || oldMsg.author?.bot || !oldMsg.guild) return;
  const e = new EmbedBuilder().setColor(0xf1c40f).setTitle('Message Edited').setDescription(`**Author:** <@${oldMsg.author.id}> (\`${oldMsg.author.tag}\`)\n**Channel:** <#${oldMsg.channel.id}>\n**Before:** ${oldMsg.content}\n**After:** ${newMsg.content}`).setFooter({ text: `Author: ${oldMsg.author.id}` }).setTimestamp();
  sendLog(oldMsg.guild, LOG_TYPES.MESSAGE_EDIT, e);
});

client.on('messageDeleteBulk', (messages) => {
  const first = messages.first();
  if (!first?.guild) return;
  const count = messages.size;
  const users = [...new Set(messages.map(m => m.author?.tag).filter(Boolean))].slice(0, 20).join(', ');
  const e = new EmbedBuilder().setColor(0xe74c3c).setTitle('Bulk Message Delete').setDescription(`**Channel:** <#${first.channel.id}>\n**Count:** ${count} messages\n**Users:** ${users || 'Unknown'}`).setTimestamp();
  sendLog(first.guild, LOG_TYPES.BULK_DELETE, e);
});

client.on('guildMemberAdd', async (member) => {
  // Tag/auto-welcome
  const tagChanId = db.prepare('SELECT tag_channel_id FROM config WHERE guild_id = ?').get(member.guild.id)?.tag_channel_id;
  if (tagChanId) {
    try {
      const chan = await member.guild.channels.fetch(tagChanId);
      const m = await chan.send({ content: `${member}` });
      setTimeout(() => m.delete().catch(() => {}), 100);
    } catch {}
  }
  // Log
  const created = Math.floor(member.user.createdTimestamp / 1000);
  const age = member.user.createdAt > Date.now() - 604800000 ? 'âš ï¸ Account < 7 days old' : 'âœ… Account age OK';
  const e = new EmbedBuilder().setColor(0x2ecc71).setTitle('Member Joined').setDescription(`**User:** ${member.user.tag} (<@${member.user.id}>)\n**Account Created:** <t:${created}:R>\n**Age Check:** ${age}`).setFooter({ text: `ID: ${member.user.id}` }).setTimestamp();
  sendLog(member.guild, LOG_TYPES.MEMBER_JOIN, e);
});

client.on('guildMemberRemove', async (member) => {
  db.prepare('DELETE FROM afk WHERE guild_id = ? AND user_id = ?').run(member.guild.id, member.user.id);
  const roles = member.roles?.cache?.filter(r => r.name !== '@everyone').map(r => r.name).join(', ') || 'None';
  const e = new EmbedBuilder().setColor(0xe74c3c).setTitle('Member Left').setDescription(`**User:** ${member.user.tag} (<@${member.user.id}>)\n**Roles:** ${roles}`).setFooter({ text: `ID: ${member.user.id}` }).setTimestamp();
  sendLog(member.guild, LOG_TYPES.MEMBER_LEAVE, e);
});

client.on('guildBanAdd', async (ban) => {
  const e = new EmbedBuilder().setColor(0xe74c3c).setTitle('Member Banned').setDescription(`**User:** ${ban.user.tag} (<@${ban.user.id}>)\n**Reason:** ${ban.reason || 'No reason'}`).setFooter({ text: `ID: ${ban.user.id}` }).setTimestamp();
  sendLog(ban.guild, LOG_TYPES.MEMBER_BAN, e);
});

client.on('guildBanRemove', async (ban) => {
  const e = new EmbedBuilder().setColor(0x2ecc71).setTitle('Member Unbanned').setDescription(`**User:** ${ban.user.tag} (<@${ban.user.id}>)`).setFooter({ text: `ID: ${ban.user.id}` }).setTimestamp();
  sendLog(ban.guild, LOG_TYPES.MEMBER_UNBAN, e);
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (oldMember.user.bot) return;

  // Role changes
  const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id) && r.name !== '@everyone');
  const removedRoles = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id) && r.name !== '@everyone');
  if (addedRoles.size || removedRoles.size) {
    const lines = [];
    if (addedRoles.size) lines.push(`**Added:** ${addedRoles.map(r => `<@&${r.id}>`).join(', ')}`);
    if (removedRoles.size) lines.push(`**Removed:** ${removedRoles.map(r => `<@&${r.id}>`).join(', ')}`);
    const e = new EmbedBuilder().setColor(0x3498db).setTitle('Role Updated').setDescription(`**User:** ${newMember.user.tag} (<@${newMember.user.id}>)\n${lines.join('\n')}`).setFooter({ text: `ID: ${newMember.user.id}` }).setTimestamp();
    sendLog(newMember.guild, LOG_TYPES.MEMBER_ROLE, e);
  }

  // Nickname changes
  if (oldMember.nickname !== newMember.nickname) {
    const e = new EmbedBuilder().setColor(0x9b59b6).setTitle('Nickname Changed').setDescription(`**User:** ${newMember.user.tag} (<@${newMember.user.id}>)\n**Before:** ${oldMember.nickname || '*None*'}\n**After:** ${newMember.nickname || '*None*'}`).setFooter({ text: `ID: ${newMember.user.id}` }).setTimestamp();
    sendLog(newMember.guild, LOG_TYPES.MEMBER_NICKNAME, e);
  }

  // Timeout/mute changes
  const oldTimedOut = oldMember.communicationDisabledUntil?.getTime() || 0;
  const newTimedOut = newMember.communicationDisabledUntil?.getTime() || 0;
  if (oldTimedOut !== newTimedOut) {
    let desc;
    if (newTimedOut > Date.now()) {
      desc = `**User:** ${newMember.user.tag} (<@${newMember.user.id}>)\n**Duration:** <t:${Math.floor(newTimedOut / 1000)}:R>`;
    } else if (oldTimedOut > Date.now() && newTimedOut === 0) {
      desc = `**User:** ${newMember.user.tag} (<@${newMember.user.id}>)\n**Action:** Timeout removed`;
    } else {
      return;
    }
    const e = new EmbedBuilder().setColor(0xe67e22).setTitle('Timeout/Mute').setDescription(desc).setFooter({ text: `ID: ${newMember.user.id}` }).setTimestamp();
    sendLog(newMember.guild, LOG_TYPES.MEMBER_TIMEOUT, e);
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;
  const guild = member.guild;
  let desc;
  let color;
  let title;

  if (!oldState.channelId && newState.channelId) {
    title = 'Voice: Joined';
    color = 0x2ecc71;
    desc = `**User:** ${member.user.tag} (<@${member.user.id}>)\n**Channel:** <#${newState.channelId}>`;
  } else if (oldState.channelId && !newState.channelId) {
    title = 'Voice: Left';
    color = 0xe74c3c;
    desc = `**User:** ${member.user.tag} (<@${member.user.id}>)\n**Channel:** <#${oldState.channelId}>`;
  } else if (oldState.channelId !== newState.channelId) {
    title = 'Voice: Moved';
    color = 0x3498db;
    desc = `**User:** ${member.user.tag} (<@${member.user.id}>)\n**From:** <#${oldState.channelId}>\n**To:** <#${newState.channelId}>`;
  } else if (oldState.mute !== newState.mute || oldState.deaf !== newState.deaf) {
    const changes = [];
    if (oldState.mute !== newState.mute) changes.push(newState.mute ? 'Muted' : 'Unmuted');
    if (oldState.deaf !== newState.deaf) changes.push(newState.deaf ? 'Deafened' : 'Undeafened');
    title = 'Voice: Updated';
    color = 0xf1c40f;
    desc = `**User:** ${member.user.tag} (<@${member.user.id}>)\n**Channel:** <#${newState.channelId || oldState.channelId}>\n**Changes:** ${changes.join(', ')}`;
  } else return;

  const e = new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc).setFooter({ text: `ID: ${member.user.id}` }).setTimestamp();
  sendLog(guild, LOG_TYPES.VOICE, e);
});

client.on('channelCreate', async (channel) => {
  if (!channel.guild) return;
  const typeName = { 0: 'Text', 2: 'Voice', 4: 'Category', 5: 'Announcement', 13: 'Stage', 15: 'Forum' }[channel.type] || 'Other';
  const e = new EmbedBuilder().setColor(0x2ecc71).setTitle('Channel Created').setDescription(`**Name:** ${channel.name}\n**Type:** ${typeName}\n**ID:** \`${channel.id}\``).setTimestamp();
  sendLog(channel.guild, LOG_TYPES.CHANNEL_CREATE, e);
});

client.on('channelDelete', async (channel) => {
  if (!channel.guild) return;
  const typeName = { 0: 'Text', 2: 'Voice', 4: 'Category', 5: 'Announcement', 13: 'Stage', 15: 'Forum' }[channel.type] || 'Other';
  const e = new EmbedBuilder().setColor(0xe74c3c).setTitle('Channel Deleted').setDescription(`**Name:** ${channel.name}\n**Type:** ${typeName}\n**ID:** \`${channel.id}\``).setTimestamp();
  sendLog(channel.guild, LOG_TYPES.CHANNEL_DELETE, e);
});

client.on('channelUpdate', (oldChannel, newChannel) => {
  if (!oldChannel.guild || !newChannel.guild) return;
  const changes = [];
  if (oldChannel.name !== newChannel.name) changes.push(`Name: \`${oldChannel.name}\` â†’ \`${newChannel.name}\``);
  if (oldChannel.topic !== newChannel.topic) changes.push(`Topic changed`);
  if (oldChannel.nsfw !== newChannel.nsfw) changes.push(`NSFW: ${newChannel.nsfw ? 'Yes' : 'No'}`);
  if (oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) changes.push(`Slowmode: ${newChannel.rateLimitPerUser}s`);
  if (oldChannel.userLimit !== newChannel.userLimit) changes.push(`User Limit: ${newChannel.userLimit}`);
  if (oldChannel.bitrate !== newChannel.bitrate) changes.push(`Bitrate: ${newChannel.bitrate}`);
  if (!changes.length) return;
  const e = new EmbedBuilder().setColor(0x3498db).setTitle('Channel Updated').setDescription(`**Channel:** <#${newChannel.id}> (\`${newChannel.name}\`)\n${changes.join('\n')}`).setTimestamp();
  sendLog(newChannel.guild, LOG_TYPES.CHANNEL_UPDATE, e);
});

client.on('inviteCreate', async (invite) => {
  if (!invite.guild) return;
  const maxAge = invite.maxAge === 0 ? 'Never' : `${invite.maxAge}s`;
  const e = new EmbedBuilder().setColor(0x2ecc71).setTitle('Invite Created').setDescription(`**Inviter:** ${invite.inviter?.tag || 'Unknown'} (<@${invite.inviter?.id || '?'}>)\n**Code:** \`${invite.code}\`\n**Max Age:** ${maxAge}\n**Max Uses:** ${invite.maxUses || 'Unlimited'}\n**Channel:** <#${invite.channel?.id || '?'}>`).setTimestamp();
  sendLog(invite.guild, LOG_TYPES.INVITE_CREATE, e);
});

client.on('inviteDelete', async (invite) => {
  if (!invite.guild) return;
  const e = new EmbedBuilder().setColor(0xe74c3c).setTitle('Invite Deleted').setDescription(`**Code:** \`${invite.code}\`\n**Channel:** <#${invite.channel?.id || '?'}>`).setTimestamp();
  sendLog(invite.guild, LOG_TYPES.INVITE_DELETE, e);
});

client.on('emojiCreate', (emoji) => {
  if (!emoji.guild) return;
  const e = new EmbedBuilder().setColor(0x2ecc71).setTitle('Emoji Created').setDescription(`**Name:** ${emoji.name}\n**ID:** \`${emoji.id}\`\n**Animated:** ${emoji.animated ? 'Yes' : 'No'}`).setTimestamp();
  sendLog(emoji.guild, LOG_TYPES.EMOJI, e);
});

client.on('emojiDelete', (emoji) => {
  if (!emoji.guild) return;
  const e = new EmbedBuilder().setColor(0xe74c3c).setTitle('Emoji Deleted').setDescription(`**Name:** ${emoji.name}\n**ID:** \`${emoji.id}\``).setTimestamp();
  sendLog(emoji.guild, LOG_TYPES.EMOJI, e);
});

client.on('emojiUpdate', (oldEmoji, newEmoji) => {
  if (!oldEmoji.guild) return;
  if (oldEmoji.name === newEmoji.name) return;
  const e = new EmbedBuilder().setColor(0x3498db).setTitle('Emoji Renamed').setDescription(`**Before:** ${oldEmoji.name}\n**After:** ${newEmoji.name}\n**ID:** \`${newEmoji.id}\``).setTimestamp();
  sendLog(newEmoji.guild, LOG_TYPES.EMOJI, e);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    await handleSlash(interaction);
    return;
  }
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('panel_')) { await handlePanelButton(interaction).catch(() => {}); return; }
    if (interaction.customId.startsWith('log_toggle_') || interaction.customId.startsWith('log_channel_') || interaction.customId.startsWith('log_reset_')) {
      const access = hasPanelAccess(interaction.member);
      if (!access) return interaction.reply({ content: 'No permission.', ephemeral: true });
      const parts = interaction.customId.split('_');
      const action = parts[0] + '_' + parts[1]; // log_toggle, log_channel, log_reset
      const logType = parts.slice(2).join('_');
      if (action === 'log_toggle') {
        const s = db.prepare('SELECT * FROM log_settings WHERE guild_id = ? AND log_type = ?').get(interaction.guildId, logType);
        const currentEnabled = s ? s.enabled === 1 : true;
        db.prepare('INSERT OR REPLACE INTO log_settings VALUES (?,?,?,COALESCE((SELECT channel_id FROM log_settings WHERE guild_id = ? AND log_type = ?),NULL))').run(interaction.guildId, logType, currentEnabled ? 0 : 1, interaction.guildId, logType);
        await interaction.reply({ content: `${LOG_NAMES[logType] || logType} ${currentEnabled ? 'ğŸ”´ disabled' : 'ğŸŸ¢ enabled'}.`, ephemeral: true });
      } else if (action === 'log_channel') {
        return interaction.showModal(createModal(`log_channel_modal_${logType}`, `Set Channel for ${LOG_NAMES[logType] || logType}`, [{ id: 'channel', label: 'Channel ID', placeholder: 'Click channel > Copy ID', min: 17, max: 20 }]));
      } else if (action === 'log_reset') {
        db.prepare('DELETE FROM log_settings WHERE guild_id = ? AND log_type = ?').run(interaction.guildId, logType);
        await interaction.reply({ content: `${LOG_NAMES[logType] || logType} reset to defaults.`, ephemeral: true });
      }
      return;
    }
    if (interaction.customId === 'ticket_open') {
      // Per-user lock to prevent duplicate tickets from rapid double-clicks
      if (ticketLocks.has(interaction.user.id)) {
        return interaction.reply({ content: 'Please wait, your ticket is already being created.', ephemeral: true });
      }
      ticketLocks.add(interaction.user.id);
      try {
        // Check for existing open ticket via DB
        const existingTicket = db.prepare("SELECT channel_id FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open'").get(interaction.guildId, interaction.user.id);
        if (existingTicket) {
          const existingChan = interaction.guild.channels.cache.get(existingTicket.channel_id);
          if (existingChan) return interaction.reply({ content: `You already have an open ticket: ${existingChan}`, ephemeral: true });
          // Channel was deleted, clean up DB
          db.prepare('DELETE FROM tickets WHERE channel_id = ?').run(existingTicket.channel_id);
        }
        const cfg = db.prepare('SELECT * FROM ticket_config WHERE guild_id = ?').get(interaction.guildId);
        const perms = [
          { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
        ];
        if (cfg?.role_id) perms.push({ id: cfg.role_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
        let ticketChan;
        try {
          ticketChan = await interaction.guild.channels.create({
            name: `ticket-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}-${interaction.user.id.slice(-4)}`,
            type: ChannelType.GuildText,
            parent: cfg?.category_id || undefined,
            permissionOverwrites: perms,
          });
        } catch {
          return interaction.reply({ content: 'Failed to create ticket channel. Check bot permissions.', ephemeral: true });
        }
        db.prepare('INSERT OR REPLACE INTO tickets VALUES (?,?,?,?,?,?,?)').run(ticketChan.id, interaction.guildId, interaction.user.id, 'open', Date.now(), null, null);
        const ticketEmbed = new EmbedBuilder().setColor(0x2b2d31)
          .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
          .setDescription(`**Ticket Opened**\n${interaction.user}, thank you for reaching out.\nSupport will be with you shortly.\n\n\u2022 **User:** ${interaction.user.tag} (\`${interaction.user.id}\`)\n\u2022 **Opened:** <t:${Math.floor(Date.now() / 1000)}:R>`)
          .setFooter({ text: 'Click the button below to close this ticket' });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim').setStyle(ButtonStyle.Primary),
        );
        await ticketChan.send({ content: `${interaction.user} ${cfg?.role_id ? `<@&${cfg.role_id}>` : ''}`, embeds: [ticketEmbed], components: [row] });
        await interaction.reply({ content: `Ticket created: ${ticketChan}`, ephemeral: true });
        return;
      } finally {
        ticketLocks.delete(interaction.user.id);
      }
    }
    if (interaction.customId === 'ticket_close') {
      const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(interaction.channelId);
      if (!ticket || ticket.status !== 'open') return interaction.reply({ content: 'This ticket is already closed.', ephemeral: true });
      const cfg = db.prepare('SELECT role_id FROM ticket_config WHERE guild_id = ?').get(interaction.guildId);
      const isSupport = cfg?.role_id ? interaction.member.roles.cache.has(cfg.role_id) : false;
      if (ticket.user_id !== interaction.user.id && !isSupport && interaction.user.id !== OWNER_ID) {
        return interaction.reply({ content: 'Only the ticket owner or support can close this.', ephemeral: true });
      }
      db.prepare('UPDATE tickets SET status = ?, closed_by = ?, closed_at = ? WHERE channel_id = ?').run('closed', interaction.user.id, Date.now(), interaction.channelId);
      const closeEmbed = new EmbedBuilder().setColor(0xCC3333)
        .setDescription(`**Ticket Closed**\nClosed by ${interaction.user}\nChannel will be deleted shortly.`);
      await interaction.reply({ embeds: [closeEmbed] });
      // DM the user
      const owner = await client.users.fetch(ticket.user_id).catch(() => null);
      if (owner) owner.send({ embeds: [smallEmbed(`Your ticket has been closed by ${interaction.user.tag}.`)] }).catch(() => {});
      setTimeout(() => interaction.channel.delete().catch(() => {}), 10000);
      return;
    }
    if (interaction.customId === 'ticket_claim') {
      const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(interaction.channelId);
      if (!ticket || ticket.status !== 'open') return interaction.reply({ content: 'Ticket not open.', ephemeral: true });
      const claimedBy = db.prepare('SELECT closed_by FROM tickets WHERE channel_id = ?').get(interaction.channelId);
      if (claimedBy && claimedBy.closed_by) return interaction.reply({ content: 'Ticket already claimed.', ephemeral: true });
      db.prepare('UPDATE tickets SET closed_by = ? WHERE channel_id = ?').run(interaction.user.id, interaction.channelId);
      await interaction.reply({ embeds: [smallEmbed(`Ticket claimed by ${interaction.user}.`)] });
      return;
    }
    if (interaction.customId === 'giveaway_join') {
      const g = giveaways.get(interaction.message.id);
      if (!g) return interaction.reply({ content: 'This giveaway has ended.', ephemeral: true });
      if (g.entries.includes(interaction.user.id)) {
        g.entries = g.entries.filter(id => id !== interaction.user.id);
        db.prepare('UPDATE giveaways SET entries = ? WHERE message_id = ?').run(JSON.stringify(g.entries), g.msgId);
        await interaction.reply({ content: 'You have left the giveaway.', ephemeral: true });
      } else {
        g.entries.push(interaction.user.id);
        db.prepare('UPDATE giveaways SET entries = ? WHERE message_id = ?').run(JSON.stringify(g.entries), g.msgId);
        await interaction.reply({ content: 'You have entered the giveaway!', ephemeral: true });
      }
      return;
    }
    return;
  }
  if (interaction.isModalSubmit()) {
    await handlePanelModal(interaction).catch(() => {});
    return;
  }
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_log_type') {
    const logType = interaction.values[0];
    const access = hasPanelAccess(interaction.member);
    if (!access) return interaction.reply({ content: 'No permission.', ephemeral: true });
    const s = db.prepare('SELECT * FROM log_settings WHERE guild_id = ? AND log_type = ?').get(interaction.guildId, logType);
    const enabled = s ? s.enabled === 1 : true;
    const name = LOG_NAMES[logType] || logType;
    const reply = {
      content: `**${name}**\nStatus: ${enabled ? 'ğŸŸ¢ Enabled' : 'ğŸ”´ Disabled'}${s?.channel_id ? `\nChannel: <#${s.channel_id}>` : ''}`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`log_toggle_${logType}`).setLabel(enabled ? 'ğŸ”´ Disable' : 'ğŸŸ¢ Enable').setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`log_channel_${logType}`).setLabel('\uD83D\uDCCD Set Separate Channel').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`log_reset_${logType}`).setLabel('\uD83D\uDD04 Reset').setStyle(ButtonStyle.Secondary),
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('panel_log').setLabel('\u2190 Back to Log Overview').setStyle(ButtonStyle.Secondary),
        ),
      ],
      ephemeral: true,
    };
    await interaction.reply(reply);
    return;
  }
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_rmmodrole') {
    const roleId = interaction.values[0];
    const access = hasPanelAccess(interaction.member);
    if (!access) return interaction.reply({ content: 'No permission.', ephemeral: true });
    db.prepare('DELETE FROM mod_roles WHERE guild_id = ? AND role_id = ?').run(interaction.guildId, roleId);
    await interaction.reply({ content: `Mod role removed.`, ephemeral: true });
    return;
  }
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_kw_del') {
    const trigger = interaction.values[0];
    if (!hasPanelAccess(interaction.member)) return interaction.reply({ content: 'No permission.', ephemeral: true });
    db.prepare('DELETE FROM keyword_logs WHERE guild_id = ? AND trigger = ?').run(interaction.guildId, trigger);
    await interaction.reply({ content: `Trigger \`${trigger}\` removed.`, ephemeral: true });
    return;
  }
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_autoreply_del') {
    const trigger = interaction.values[0];
    if (!hasPanelAccess(interaction.member)) return interaction.reply({ content: 'No permission.', ephemeral: true });
    db.prepare('DELETE FROM auto_replies WHERE guild_id = ? AND trigger = ?').run(interaction.guildId, trigger);
    await interaction.reply({ content: `Auto-reply \`${trigger}\` removed.`, ephemeral: true });
    return;
  }
  if (interaction.isStringSelectMenu() && interaction.customId === 'vote') {
    const poll = cache.get(interaction.message.id);
    if (!poll) return interaction.reply({ content: 'This poll is no longer active.', ephemeral: true });
    const choice = parseInt(interaction.values[0]);
    const userId = interaction.user.id;
    const prev = poll.voters.get(userId);
    if (prev !== undefined) poll.counts[prev]--;
    poll.counts[choice]++;
    poll.voters.set(userId, choice);
    const n = interaction.message.embeds[0].footer.text.split('\u2022 Created by ')[1] || 'Unknown';
    await interaction.message.edit({ embeds: [buildPollEmbed(poll, n)] });
    savePoll(interaction.message.id, poll);
    const label = poll.options[choice];
    await interaction.reply({
      content: prev === undefined ? `Vote recorded for **${label}**.` : prev === choice ? `Already voting for **${label}**.` : `Vote changed to **${label}**.`,
      ephemeral: true,
    });
  }
});

async function handleSlash(interaction) {
  const cmd = interaction.commandName;

  if (cmd === 'help') {
    const embed = new EmbedBuilder().setColor(0x000000).setTitle('NEXUS').setDescription('Your all-in-one Discord bot').setFooter({ text: 'Prefix: ,' });
    embed.addFields(
      { name: 'Everyone', value: '`/help` `,help` \u2022 `/panel` `,panel` \u2022 `/userinfo` `,ui` \u2022 `/serverinfo` `,si` \u2022 `/avatar` `,av` \u2022 `/banner` \u2022 `/afk` `,afk` \u2022 `/remind` `,remind` \u2022 `/ticket` `,ticket` \u2022 `/entervc` `,entervc` \u2022 `/leavevc` `,leavevc` \u2022 `/subscribe` `,subscribe` \u2022 `/lastwarn` `,lastwarn` \u2022 `/lastban` `,lastban` \u2022 `/lastmuted` `,lastmuted`', inline: false },
      { name: 'Polls', value: '`/poll` `,poll` \u2022 `/endpoll` `,endpoll` \u2022 `/activepolls` `,activepolls` \u2022 `/history` `,history` (Owner + Staff only)', inline: false },
      { name: 'Giveaways', value: '`/giveaway` `,giveaway` \u2022 `/endgiveaway` `,endgiveaway` \u2022 `/reroll` `,reroll` (Owner only) \u2014 Panel: Log > Giveaways tab', inline: false },
      { name: 'Moderation', value: '`,w`(warn) `,b`(ban) `,tb`(tempban) `,k`(kick) `,m`(mute) `,t`(timeout) `,cl`(clear) `,n`(nuke) `,r`(role) `,l`(lock) `,ul`(unlock) `,sm`(slowmode) `,vk`(voicekick) `,s`(snipe) `,d`(deafen) \u2022 `,deletewarn` `,dw` \u2022 `/deletewarn`', inline: false },
      { name: 'Auto-Mod', value: '`,warnword` \u2022 `,muteword` \u2022 `,addword` `,addword` \u2022 `/banword` \u2022 `/muteword` \u2014 Panel: Protect > Filters', inline: false },
      { name: 'Settings', value: '`/panel` \u2192 All config (log types, anti-spam, tickets, AI, perms, keyword triggers, auto-replies) \u2022 `/settings` `,settings`', inline: false },
      { name: 'Owner', value: '`,roleall` \u2022 `,removeall` \u2022 `,say` \u2022 `,emoji` \u2022 `/rules` `,rules` \u2022 `/announce` \u2022 `/sendmessage` \u2022 `/roleall` \u2022 `/removeall`', inline: false },
    );
    const bannerPath = require('path').join(__dirname, 'assets', 'banner.png');
    const bannerFile = require('fs').existsSync(bannerPath) ? new AttachmentBuilder(bannerPath) : null;
    if (bannerFile) embed.setImage('attachment://banner.png');
    await interaction.reply({ embeds: [embed], files: bannerFile ? [bannerFile] : [] });
    return;
  }

  // â”€â”€ Poll commands â”€â”€
  if (cmd === 'poll' || cmd === 'endpoll' || cmd === 'activepolls' || cmd === 'history') {
    if (!hasPanelAccess(interaction.member)) return interaction.reply({ content: 'Only the bot owner or authorized staff can use poll commands.', ephemeral: true });
  }
  if (cmd === 'poll') {
    const raw = interaction.options.getString('options');
    const timeStr = interaction.options.getString('time');
    const description = interaction.options.getString('description');
    const ping = interaction.options.getString('ping') || 'none';
    const options = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (options.length < 2) return interaction.reply({ content: 'At least 2 options required.', ephemeral: true });
    if (options.length > 25) return interaction.reply({ content: 'Maximum 25 options.', ephemeral: true });
    const duration = parseDuration(timeStr);
    if (timeStr && !duration) return interaction.reply({ content: 'Invalid time. Use e.g. 30s, 5m, 1h, 2d, 1w', ephemeral: true });
    const pollData = {
      guildId: interaction.guildId, channelId: interaction.channelId, options, ping, description: description || null,
      counts: new Array(options.length).fill(0), voters: new Map(),
      authorId: interaction.user.id, endsAt: duration ? Date.now() + duration : null, createdBy: interaction.user.displayName,
    };
    const select = new StringSelectMenuBuilder().setCustomId('vote').setPlaceholder('Cast your vote...')
      .addOptions(options.map((o, i) => ({ label: o.length > 100 ? o.slice(0, 97) + '...' : o, value: String(i) })));
    const msg = await interaction.reply({ embeds: [buildPollEmbed(pollData, interaction.user.displayName)], components: [new ActionRowBuilder().addComponents(select)], withResponse: true }).then(r => r.resource.message);
    cache.set(msg.id, pollData);
    savePoll(msg.id, pollData);
    if (duration) scheduleEnd(msg.id, pollData);
    await notifySubscribers(pollData, msg.url, interaction.guild);
    return;
  }

  if (cmd === 'endpoll') {
    const msgId = interaction.options.getString('message_id');
    const poll = cache.get(msgId);
    if (!poll) return interaction.reply({ content: 'Poll not found.', ephemeral: true });
    const total = poll.counts.reduce((a, b) => a + b, 0);
    if (total === 0) {
      cache.delete(msgId); db.prepare('DELETE FROM polls WHERE message_id = ?').run(msgId);
      if (timers.has(msgId)) clearTimeout(timers.get(msgId));
      return interaction.reply({ content: 'No votes were cast.', ephemeral: true });
    }
    if (timers.has(msgId)) clearTimeout(timers.get(msgId));
    cache.delete(msgId); db.prepare('DELETE FROM polls WHERE message_id = ?').run(msgId);
    archivePoll(poll.options, poll.counts, interaction.guildId, poll.createdBy);
    const maxV = Math.max(...poll.counts);
    const idx = poll.counts.indexOf(maxV);
    const winner = poll.options[idx];
    const resultEmbed = new EmbedBuilder().setColor(0x2b2d31).setTitle('Poll Closed \u2014 Result')
      .setDescription(`After **${total}** vote${total !== 1 ? 's' : ''}, the winner is:\n\n**${winner}** with **${maxV}** vote${maxV !== 1 ? 's' : ''}!`)
      .setFooter({ text: `Closed by ${interaction.user.displayName}` }).setTimestamp();
    try {
      const channel = await client.channels.fetch(poll.channelId);
      const msg = await channel.messages.fetch(msgId);
      await msg.edit({ components: [], embeds: [resultEmbed] });
    } catch {}
    await interaction.reply({ embeds: [resultEmbed] });
    return;
  }

  if (cmd === 'setlog') {
    const channel = interaction.options.getChannel('channel');
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement && channel.type !== ChannelType.GuildForum && channel.type !== ChannelType.GuildMedia)) {
      return interaction.reply({ content: 'Select a text/news/forum channel.', ephemeral: true });
    }
    ensureConfig(interaction.guildId);
    setConfig(interaction.guildId, 'log_channel_id', channel.id);
    await interaction.reply({ content: `Log channel set to ${channel}.`, ephemeral: true });
  }

  if (cmd === 'activepolls') {
    const list = [...cache.entries()].filter(([_, p]) => p.guildId === interaction.guildId);
    if (list.length === 0) return interaction.reply({ content: 'No active polls.', ephemeral: true });
    const lines = list.map(([id, p]) => {
      const total = p.counts.reduce((a, b) => a + b, 0);
      const remain = p.endsAt ? discordTimestamp(p.endsAt) : 'no limit';
      const voterLines = [...p.voters.entries()].sort((a, b) => a[1] - b[1])
        .map(([uid, choice]) => `<@${uid}> \u2192 **${p.options[choice]}**`);
      return `**${p.options.join(', ')}** \u2014 ${total} vote${total !== 1 ? 's' : ''} (ends ${remain})${voterLines.length ? '\n' + voterLines.join('\n') : ''}`;
    });
    await interaction.reply({ embeds: [embed(`Active Polls (${list.length})`, lines.join('\n\n'))], ephemeral: true });
  }

  if (cmd === 'history') {
    const rows = db.prepare('SELECT * FROM history WHERE guild_id = ? ORDER BY id DESC LIMIT 10').all(interaction.guildId);
    if (rows.length === 0) return interaction.reply({ content: 'No poll history.', ephemeral: true });
    const lines = rows.map(r => {
      const opts = JSON.parse(r.options);
      const counts = JSON.parse(r.counts);
      const total = counts.reduce((a, b) => a + b, 0);
      const details = opts.map((o, j) => `  ${j + 1}. ${o} \u2014 ${counts[j]} votes`).join('\n');
      return `**#${r.id}** \u2014 **${r.winner}** (${total} votes)\n${details}\nBy ${r.created_by || 'Unknown'} \u2022 ${r.closed_at ? new Date(r.closed_at).toLocaleDateString() : ''}`;
    });
    await interaction.reply({ embeds: [embed('Poll History (Last 10)', lines.join('\n\n'))], ephemeral: true });
  }

  if (cmd === 'subscribe') {
    const existing = db.prepare('SELECT user_id FROM subscribers WHERE user_id = ? AND guild_id = ?').get(interaction.user.id, interaction.guildId);
    if (existing) {
      db.prepare('DELETE FROM subscribers WHERE user_id = ? AND guild_id = ?').run(interaction.user.id, interaction.guildId);
      await interaction.reply({ content: 'DM notifications disabled.', ephemeral: true });
    } else {
      db.prepare('INSERT OR REPLACE INTO subscribers (user_id, guild_id) VALUES (?, ?)').run(interaction.user.id, interaction.guildId);
      await interaction.reply({ content: 'DM notifications enabled.', ephemeral: true });
    }
  }

  if (cmd === 'announce') {
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Owner only.', ephemeral: true });
    const msgId = interaction.options.getString('message_id');
    const ping = interaction.options.getString('ping') || 'none';
    const poll = cache.get(msgId);
    if (!poll) return interaction.reply({ content: 'Poll not found.', ephemeral: true });
    const total = poll.counts.reduce((a, b) => a + b, 0);
    if (total === 0) return interaction.reply({ content: 'No votes cast.', ephemeral: true });
    const maxV = Math.max(...poll.counts);
    const idx = poll.counts.indexOf(maxV);
    const winner = poll.options[idx];
    let content = ping === 'here' ? '@here ' : ping === 'everyone' ? '@everyone ' : '';
    content += `**${interaction.user.displayName}** announced the winner!\n\n**${winner}** \u2014 **${maxV}** votes`;
    await interaction.channel.send({ content });
    await interaction.reply({ content: 'Announcement sent.', ephemeral: true });
  }

  // â”€â”€ Moderation slash commands â”€â”€

  if (cmd === 'warncount') {
    if (!checkPerms(interaction.member, PermissionFlagsBits.Administrator)) {
      return interaction.reply({ embeds: [errorEmbed('Admin only.')], ephemeral: true });
    }
    const count = interaction.options.getInteger('count');
    if (count < 1 || count > 100) return interaction.reply({ content: 'Count must be 1-100.', ephemeral: true });
    db.prepare('INSERT OR REPLACE INTO warn_settings (guild_id, max_warns, action, mute_duration) VALUES (?,?,COALESCE((SELECT action FROM warn_settings WHERE guild_id = ?),\'kick\'),COALESCE((SELECT mute_duration FROM warn_settings WHERE guild_id = ?),\'1h\'))')
      .run(interaction.guildId, count, interaction.guildId, interaction.guildId);
    await interaction.reply({ embeds: [smallEmbed(`Max warns set to **${count}**.`)], ephemeral: true });
  }

  if (cmd === 'warnsetting') {
    if (!checkPerms(interaction.member, PermissionFlagsBits.Administrator)) {
      return interaction.reply({ embeds: [errorEmbed('Admin only.')], ephemeral: true });
    }
    const action = interaction.options.getString('action');
    const duration = interaction.options.getString('duration');
    if (action === 'mute' && !duration) return interaction.reply({ content: 'Provide a mute duration (e.g., 1h, 30m, 1d).', ephemeral: true });
    if (duration && !getTimeSeconds(duration)) return interaction.reply({ content: 'Invalid duration. Use e.g., 1h, 30m, 1d.', ephemeral: true });
    db.prepare('INSERT OR REPLACE INTO warn_settings (guild_id, max_warns, action, mute_duration) VALUES (?,COALESCE((SELECT max_warns FROM warn_settings WHERE guild_id = ?),5),?,?)')
      .run(interaction.guildId, interaction.guildId, action, duration || '1h');
    let desc = `Action set to **${action}**`;
    if (action === 'mute') desc += ` for **${duration || '1h'}**`;
    await interaction.reply({ embeds: [smallEmbed(desc)], ephemeral: true });
  }

  if (cmd === 'warnsettings') {
    const ws = db.prepare('SELECT * FROM warn_settings WHERE guild_id = ?').get(interaction.guildId);
    if (!ws) return interaction.reply({ embeds: [smallEmbed('Default settings: max 5 warns \u2192 kick.')], ephemeral: true });
    await interaction.reply({ embeds: [embed('Warn Settings', `Max warns: **${ws.max_warns}**\nAction: **${ws.action}**${ws.action === 'mute' ? `\nMute duration: **${ws.mute_duration}**` : ''}`)], ephemeral: true });
  }

  if (cmd === 'banword' || cmd === 'muteword') {
    if (!checkPerms(interaction.member, PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ embeds: [errorEmbed('Manage Messages required.')], ephemeral: true });
    }
    const action = interaction.options.getString('action');
    const word = interaction.options.getString('word')?.toLowerCase();
    const type = cmd === 'banword' ? 'ban' : 'mute';

    if (action === 'add') {
      if (!word) return interaction.reply({ content: 'Provide a word.', ephemeral: true });
      const duration = cmd === 'muteword' ? interaction.options.getString('duration') || null : null;
      db.prepare('INSERT OR REPLACE INTO word_filters VALUES (?,?,?,?)').run(interaction.guildId, word, type, duration);
      await interaction.reply({ embeds: [smallEmbed(`Added **${word}** to ${type} filter${duration ? ` for ${duration}` : ''}.`)], ephemeral: true });
    } else if (action === 'remove') {
      if (!word) return interaction.reply({ content: 'Provide a word.', ephemeral: true });
      db.prepare('DELETE FROM word_filters WHERE guild_id = ? AND word = ?').run(interaction.guildId, word);
      await interaction.reply({ embeds: [smallEmbed(`Removed **${word}** from ${type} filter.`)], ephemeral: true });
    } else if (action === 'list') {
      const words = db.prepare('SELECT word, duration FROM word_filters WHERE guild_id = ? AND action = ?').all(interaction.guildId, type);
      if (words.length === 0) return interaction.reply({ embeds: [smallEmbed(`No ${type} words configured.`)], ephemeral: true });
      await interaction.reply({ embeds: [embed(`${type === 'ban' ? 'Ban' : 'Mute'} Words (${words.length})`, words.map(w => `\u2022 ${w.word}${w.duration ? ` (${w.duration})` : ''}`).join('\n'))], ephemeral: true });
    }
  }

  if (cmd === 'panel') {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ embeds: [errorEmbed('This panel is for the bot owner only.')], ephemeral: true });
    }
    await interaction.reply({ ...panelMain(interaction), ephemeral: true });
    return;
  }

  if (cmd === 'giverole') {
    if (!checkPerms(interaction.member, PermissionFlagsBits.ManageRoles)) {
      return interaction.reply({ embeds: [errorEmbed('Manage Roles permission required.')], ephemeral: true });
    }
    const user = interaction.options.getUser('user');
    const roleArg = interaction.options.getString('role');
    const tMember = await getMember(interaction.guild, user.id);
    if (!tMember) return interaction.reply({ content: 'User is not in the server.', ephemeral: true });
    let role = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === roleArg.toLowerCase() || r.id === roleArg.replace(/[<@&>]/g, ''));
    if (!role) return interaction.reply({ content: 'Role not found.', ephemeral: true });
    if (role.position >= interaction.member.roles.highest.position && interaction.user.id !== interaction.guild.ownerId) {
      return interaction.reply({ content: 'Cannot manage this role.', ephemeral: true });
    }
    if (tMember.roles.cache.has(role.id)) {
      await tMember.roles.remove(role);
      await interaction.reply({ embeds: [smallEmbed(`\uD83D\uDD34 Removed **${role.name}** from ${user.tag}.`)] });
    } else {
      await tMember.roles.add(role);
      await interaction.reply({ embeds: [smallEmbed(`\uD83D\uDFE2 Added **${role.name}** to ${user.tag}.`)] });
    }
    return;
  }

  if (cmd === 'bantime') {
    if (!checkPerms(interaction.member, PermissionFlagsBits.BanMembers)) {
      return interaction.reply({ embeds: [errorEmbed('Ban Members permission required.')], ephemeral: true });
    }
    const userId = interaction.options.getString('user_id');
    const duration = interaction.options.getString('duration');
    const sec = getTimeSeconds(duration);
    if (!sec || sec > 604800 * 52) return interaction.reply({ content: 'Invalid duration. Use e.g. 1h, 2d, 1w (max 1 year).', ephemeral: true });
    const existing = db.prepare('SELECT * FROM tempbans WHERE guild_id = ? AND user_id = ?').get(interaction.guildId, userId);
    if (!existing) return interaction.reply({ content: 'This user is not banned.', ephemeral: true });
    db.prepare('UPDATE tempbans SET ends_at = ? WHERE guild_id = ? AND user_id = ?').run(Date.now() + sec * 1000, interaction.guildId, userId);
    await interaction.reply({ embeds: [smallEmbed(`Ban duration for <@${userId}> changed to **${timeLabel(sec)}** (ends <t:${Math.floor((Date.now() + sec * 1000) / 1000)}:R>).`)] });
    return;
  }

  if (cmd === 'automessage' || cmd === 'addword') {
    if (!checkPerms(interaction.member, PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ embeds: [errorEmbed('Manage Messages required.')], ephemeral: true });
    }
    const action = interaction.options.getString('action');
    const trigger = interaction.options.getString('trigger')?.toLowerCase();
    const response = interaction.options.getString('response');

    if (action === 'add') {
      if (!trigger || !response) return interaction.reply({ content: 'Provide both trigger and response.', ephemeral: true });
      if (trigger.length < 2) return interaction.reply({ content: 'Trigger must be at least 2 characters.', ephemeral: true });
      if (trigger.length > 100 || response.length > 500) return interaction.reply({ content: 'Trigger max 100 chars, response max 500.', ephemeral: true });
      db.prepare('INSERT OR REPLACE INTO auto_replies VALUES (?,?,?)').run(interaction.guildId, trigger, response);
      await interaction.reply({ embeds: [smallEmbed(`Auto-reply added: **${trigger}** \u2192 ${response}`)], ephemeral: true });
    } else if (action === 'remove') {
      if (!trigger) return interaction.reply({ content: 'Provide a trigger word.', ephemeral: true });
      db.prepare('DELETE FROM auto_replies WHERE guild_id = ? AND trigger = ?').run(interaction.guildId, trigger);
      await interaction.reply({ embeds: [smallEmbed(`Auto-reply removed: **${trigger}**`)], ephemeral: true });
    } else if (action === 'list') {
      const rows = db.prepare('SELECT * FROM auto_replies WHERE guild_id = ?').all(interaction.guildId);
      if (rows.length === 0) return interaction.reply({ embeds: [smallEmbed('No auto-replies configured.')], ephemeral: true });
      const lines = rows.map(r => `\u2022 **${r.trigger}** \u2192 ${r.response}`);
      await interaction.reply({ embeds: [embed(`Auto-Replies (${rows.length})`, lines.join('\n'))], ephemeral: true });
    }
    return;
  }

  if (cmd === 'tagchannel') {
    const channel = interaction.options.getChannel('channel');
    if (!channel) {
      const current = db.prepare('SELECT tag_channel_id FROM config WHERE guild_id = ?').get(interaction.guildId)?.tag_channel_id;
      if (current) { db.prepare('UPDATE config SET tag_channel_id = NULL WHERE guild_id = ?').run(interaction.guildId); return interaction.reply({ content: 'Tag channel disabled.', ephemeral: true }); }
      return interaction.reply({ content: 'Provide a channel or re-run to disable.', ephemeral: true });
    }
    if (channel.type !== ChannelType.GuildText) return interaction.reply({ content: 'Select a text channel.', ephemeral: true });
    ensureConfig(interaction.guildId);
    setConfig(interaction.guildId, 'tag_channel_id', channel.id);
    await interaction.reply({ content: `New members will be mentioned in ${channel}.`, ephemeral: true });
    return;
  }

  if (cmd === 'afk') {
    const reason = interaction.options.getString('reason') || 'AFK';
    db.prepare('INSERT OR REPLACE INTO afk VALUES (?,?,?,?)').run(interaction.guildId, interaction.user.id, reason, Date.now());
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xCC3333).setDescription(`\uD83D\uDCA4 ${interaction.user} is now **AFK**: ${reason} \u2014 ${timeStr}`)] });
    return;
  }

  if (cmd === 'ticket') {
    const btn = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_open').setLabel('\uD83C\uDFAB Open Ticket').setStyle(ButtonStyle.Primary),
    );
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('Support Tickets').setDescription('Click the button below to open a support ticket.')], components: [btn] });
    return;
  }

  if (cmd === 'ai') {
    const provider = interaction.options.getString('provider');
    const apiKey = interaction.options.getString('api_key');
    const model = interaction.options.getString('model');
    const channel = interaction.options.getChannel('channel');
    if (!apiKey) return interaction.reply({ content: 'API key is required.', ephemeral: true });
    const existing = db.prepare('SELECT channel_id FROM ai_config WHERE guild_id = ?').get(interaction.guildId);
    const channelId = channel?.id || existing?.channel_id || null;
    db.prepare('INSERT OR REPLACE INTO ai_config (guild_id, provider, api_key, model, channel_id) VALUES (?,?,?,?,?)').run(interaction.guildId, provider, apiKey, model || '', channelId);
    await interaction.reply({ embeds: [smallEmbed(`AI configured: **${provider}**${model ? ` (${model})` : ''}${channel ? ` in ${channel}` : ' all channels'}.`)], ephemeral: true });
    return;
  }

  if (cmd === 'settings') {
    const ws = db.prepare('SELECT * FROM warn_settings WHERE guild_id = ?').get(interaction.guildId);
    const logChanId = db.prepare('SELECT log_channel_id FROM config WHERE guild_id = ?').get(interaction.guildId);
    const banWords = db.prepare('SELECT word FROM word_filters WHERE guild_id = ? AND action = \'ban\'').all(interaction.guildId);
    const muteWords = db.prepare('SELECT word FROM word_filters WHERE guild_id = ? AND action = \'mute\'').all(interaction.guildId);
    const activePolls = [...cache.values()].filter(p => p.guildId === interaction.guildId).length;

    const lines = [
      `**Polls** \u2014 ${activePolls} active`,
      `**Log Channel** \u2014 ${logChanId ? `<#${logChanId.log_channel_id}>` : 'Not set'}`,
      '',
      `**Warn Settings**`,
      `  Max warns: **${ws?.max_warns || 5}**`,
      `  Action: **${ws?.action || 'kick'}**${ws?.action === 'mute' ? ` (${ws?.mute_duration || '1h'})` : ''}`,
      '',
      `**Word Filters**`,
      `  Ban words: **${banWords.length}**`,
      `  Mute words: **${muteWords.length}**`,
    ];
    await interaction.reply({ embeds: [embed('Bot Settings', lines.join('\n'))], ephemeral: true });
    return;
  }

  if (cmd === 'sendmessage') {
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Owner only.', ephemeral: true });
    const content = interaction.options.getString('message');
    await interaction.channel.send(content);
    await interaction.reply({ embeds: [smallEmbed('Message sent.')], ephemeral: true });
    return;
  }

  if (cmd === 'rules') {
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Owner only.', ephemeral: true });
    const saved = db.prepare('SELECT rules_content FROM config WHERE guild_id = ?').get(interaction.guildId)?.rules_content;
    if (!saved) return interaction.reply({ content: 'No rules saved yet. Use `,rules` then send the rules as your next message.', ephemeral: true });
    await interaction.channel.send(saved);
    await interaction.reply({ embeds: [smallEmbed('Rules sent.')], ephemeral: true });
    return;
  }

  if (cmd === 'roleall' || cmd === 'removeall') {
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Owner only.', ephemeral: true });
    const role = interaction.options.getRole('role');
    if (!role) return interaction.reply({ content: 'Invalid role.', ephemeral: true });
    if (role.managed) return interaction.reply({ content: 'Cannot give/remove managed roles.', ephemeral: true });
    const isGive = cmd === 'roleall';
    await interaction.reply({ embeds: [smallEmbed(`${isGive ? 'Giving' : 'Removing'} role **${role.name}** to/from all members...`)], ephemeral: true });
    const members = await interaction.guild.members.fetch();
    const membersArr = [...members.values()];
    const totalNeeded = membersArr.filter(m => isGive ? !m.roles.cache.has(role.id) : m.roles.cache.has(role.id)).length;
    if (totalNeeded === 0) {
      await interaction.editReply({ embeds: [smallEmbed(`All members already ${isGive ? 'have' : 'don\'t have'} **${role.name}**.`)] });
      return;
    }
    await interaction.editReply({ embeds: [smallEmbed(`Processing **${totalNeeded}** members... (may take a while due to Discord rate limits)`)] });
    (async () => {
      let success = 0, fail = 0;
      for (const [, m] of membersArr) {
        try {
          if (isGive) { if (!m.roles.cache.has(role.id)) { await m.roles.add(role.id); success++; } }
          else { if (m.roles.cache.has(role.id)) { await m.roles.remove(role.id); success++; } }
        } catch { fail++; }
      }
      await interaction.editReply({ embeds: [smallEmbed(`${isGive ? 'Given' : 'Removed'} **${role.name}** to/from **${success}** members.${fail ? ` Failed: ${fail}` : ''}`)] });
      await sendModLog(interaction.guild, { Action: isGive ? 'Role All' : 'Remove All', Moderator: interaction.user.tag, Role: role.name, Success: success, Failed: fail });
    })();
    return;
  }

  if (cmd === 'slowmode') {
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Owner only.', ephemeral: true });
    const dur = interaction.options.getInteger('duration');
    if (dur < 0 || dur > 21600) return interaction.reply({ content: 'Duration must be 0-21600 seconds.', ephemeral: true });
    await interaction.channel.setRateLimitPerUser(dur);
    await interaction.reply({ embeds: [smallEmbed(dur ? `Slowmode set to **${dur}s**.` : 'Slowmode disabled.')], ephemeral: true });
    return;
  }

  if (cmd === 'lock') {
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Owner only.', ephemeral: true });
    await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false });
    await interaction.reply({ embeds: [smallEmbed('Channel locked.')], ephemeral: true });
    return;
  }

  if (cmd === 'unlock') {
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Owner only.', ephemeral: true });
    await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: null });
    await interaction.reply({ embeds: [smallEmbed('Channel unlocked.')], ephemeral: true });
    return;
  }

  if (cmd === 'nick') {
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Owner only.', ephemeral: true });
    const user = interaction.options.getUser('user');
    const name = interaction.options.getString('name');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.reply({ content: 'User not in server.', ephemeral: true });
    await member.setNickname(name);
    await interaction.reply({ embeds: [smallEmbed(`Nickname changed to **${name}**.`)], ephemeral: true });
    return;
  }

  if (cmd === 'emoji') {
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Owner only.', ephemeral: true });
    const name = interaction.options.getString('name');
    const url = interaction.options.getString('url');
    try {
      await interaction.guild.emojis.create({ name, attachment: url });
      await interaction.reply({ embeds: [smallEmbed(`Emoji **:${name}:** created.`)], ephemeral: true });
    } catch { await interaction.reply({ content: 'Failed to create emoji. Check URL and name.', ephemeral: true }); }
    return;
  }

  if (cmd === 'userinfo') {
    const user = interaction.options.getUser('user') || interaction.user;
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    const warns = db.prepare('SELECT COUNT(*) as c FROM warns WHERE guild_id = ? AND user_id = ?').get(interaction.guildId, user.id).c;
    const lines = [
      `**User:** ${user.tag} (${user.id})`,
      `**Joined:** ${member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Not in server'}`,
      `**Registered:** <t:${Math.floor(user.createdTimestamp / 1000)}:R>`,
      `**Warns:** ${warns}`,
      `**Roles:** ${member ? member.roles.cache.filter(r => r.id !== interaction.guild.id).size : '-'}`,
    ];
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('User Info').setDescription(lines.join('\n')).setThumbnail(user.displayAvatarURL())] });
    return;
  }

  if (cmd === 'serverinfo') {
    const guild = interaction.guild;
    const lines = [
      `**Name:** ${guild.name}`,
      `**ID:** ${guild.id}`,
      `**Owner:** ${(await guild.fetchOwner()).user.tag}`,
      `**Members:** ${guild.memberCount}`,
      `**Channels:** ${guild.channels.cache.size}`,
      `**Roles:** ${guild.roles.cache.size}`,
      `**Boost Level:** ${guild.premiumTier}`,
      `**Created:** <t:${Math.floor(guild.createdTimestamp / 1000)}:R>`,
    ];
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('Server Info').setDescription(lines.join('\n')).setThumbnail(guild.iconURL())] });
    return;
  }

  if (cmd === 'say') {
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Owner only.', ephemeral: true });
    const channel = interaction.options.getChannel('channel');
    const content = interaction.options.getString('message');
    if (!channel.isTextBased()) return interaction.reply({ content: 'Not a text channel.', ephemeral: true });
    await channel.send(content);
    await interaction.reply({ embeds: [smallEmbed('Message sent.')], ephemeral: true });
    return;
  }

  if (cmd === 'remind') {
    const durStr = interaction.options.getString('duration');
    const msg = interaction.options.getString('message');
    const sec = getTimeSeconds(durStr);
    if (!sec || sec < 10 || sec > 2592000) return interaction.reply({ content: 'Duration must be 10s-30d.', ephemeral: true });
    await interaction.reply({ embeds: [smallEmbed(`I will remind you in **${durStr}**.`)], ephemeral: true });
    setTimeout(async () => {
      try { await interaction.user.send({ embeds: [smallEmbed(`\u23F0 **Reminder:** ${msg}`)] }); } catch {}
    }, sec * 1000);
    return;
  }

  if (cmd === 'purge') {
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Owner only.', ephemeral: true });
    if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ content: 'Bot needs Manage Messages permission.', ephemeral: true });
    }
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount') || 100;
    const messages = await interaction.channel.messages.fetch({ limit: Math.min(amount, 100) });
    const toDelete = target ? messages.filter(m => m.author.id === target.id) : messages;
    await interaction.channel.bulkDelete(toDelete, true).catch(() => {});
    await interaction.reply({ embeds: [smallEmbed(`Deleted **${toDelete.size}** messages.`)], ephemeral: true });
    return;
  }

  // â”€â”€ Giveaway commands â”€â”€
  if (cmd === 'giveaway') {
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Owner only.', ephemeral: true });
    const durationStr = interaction.options.getString('duration');
    const prize = interaction.options.getString('prize');
    const winners = interaction.options.getInteger('winners') || 1;
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const sec = getTimeSeconds(durationStr);
    if (!sec || sec < 30 || sec > 2592000) return interaction.reply({ content: 'Duration must be 30s-30d.', ephemeral: true });
    const endsAt = Date.now() + sec * 1000;
    const embed = new EmbedBuilder().setColor(0x2b2d31)
      .setTitle('\uD83C\uDF89 Giveaway')
      .setDescription(`**${prize}**\n\nHosted by ${interaction.user}\nWinners: **${winners}**\nEnds: <t:${Math.floor(endsAt / 1000)}:R> (<t:${Math.floor(endsAt / 1000)}:f>)`)
      .setFooter({ text: 'Click the button below to enter!' });
    const btn = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('giveaway_join').setEmoji('ğŸ‰').setLabel('Enter').setStyle(ButtonStyle.Success),
    );
    const msg = await channel.send({ embeds: [embed], components: [btn] });
    const data = { msgId: msg.id, channelId: channel.id, guildId: interaction.guildId, prize, winners, endsAt, hostId: interaction.user.id, entries: [] };
    giveaways.set(msg.id, data);
    db.prepare('INSERT OR REPLACE INTO giveaways VALUES (?,?,?,?,?,?,?,?)').run(msg.id, interaction.guildId, channel.id, prize, winners, endsAt, interaction.user.id, JSON.stringify([]));
    scheduleGiveawayEnd(msg.id, data);
    await interaction.reply({ embeds: [smallEmbed(`Giveaway started in ${channel}: **${prize}**`)], ephemeral: true });
    return;
  }

  if (cmd === 'endgiveaway') {
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Owner only.', ephemeral: true });
    const msgId = interaction.options.getString('message_id');
    const g = giveaways.get(msgId);
    if (!g) return interaction.reply({ content: 'Giveaway not found or already ended.', ephemeral: true });
    endGiveaway(msgId);
    await interaction.reply({ embeds: [smallEmbed('Giveaway ended.')], ephemeral: true });
    return;
  }

  if (cmd === 'reroll') {
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Owner only.', ephemeral: true });
    const msgId = interaction.options.getString('message_id');
    const row = db.prepare('SELECT * FROM giveaways WHERE message_id = ?').get(msgId);
    if (!row) return interaction.reply({ content: 'Giveaway not found.', ephemeral: true });
    const entries = JSON.parse(row.entries);
    const valid = entries.filter(id => interaction.guild.members.cache.has(id));
    if (valid.length === 0) return interaction.reply({ content: 'No valid entrants to reroll.', ephemeral: true });
    const newWinners = [];
    const count = Math.min(row.winners, valid.length);
    for (let i = 0; i < count; i++) {
      const idx = Math.floor(Math.random() * valid.length);
      newWinners.push(valid.splice(idx, 1)[0]);
    }
    const winnerMentions = newWinners.map(id => `<@${id}>`).join(', ');
    await interaction.channel.send({ embeds: [smallEmbed(`\uD83C\uDF89 **Reroll!** New winner(s) for **${row.prize}**: ${winnerMentions}`)] });
    await interaction.reply({ embeds: [smallEmbed('Reroll done.')], ephemeral: true });
    return;
  }

  if (cmd === 'entervc') {
    const channel = interaction.options.getChannel('channel');
    if (!channel || channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
      return interaction.reply({ content: 'Select a valid voice or stage channel.', ephemeral: true });
    }
    const existing = getVoiceConnection(interaction.guildId);
    if (existing) existing.destroy();
    try {
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 10000);
      await interaction.reply({ embeds: [smallEmbed(`\uD83D\uDD0A Joined **${channel.name}**`)], ephemeral: true });
    } catch {
      await interaction.reply({ content: 'Failed to join the voice channel.', ephemeral: true });
    }
    return;
  }

  if (cmd === 'leavevc') {
    const channel = interaction.options.getChannel('channel');
    if (channel) {
      const connection = getVoiceConnection(interaction.guildId);
      if (connection && connection.joinConfig.channelId === channel.id) {
        connection.destroy();
        await interaction.reply({ embeds: [smallEmbed(`\uD83D\uDD07 Left **${channel.name}**`)], ephemeral: true });
      } else {
        await interaction.reply({ content: 'Bot is not in that voice channel.', ephemeral: true });
      }
    } else {
      const connection = getVoiceConnection(interaction.guildId);
      if (connection) {
        const name = interaction.guild.channels.cache.get(connection.joinConfig.channelId)?.name || 'voice channel';
        connection.destroy();
        await interaction.reply({ embeds: [smallEmbed(`\uD83D\uDD07 Left **${name}**`)], ephemeral: true });
      } else {
        await interaction.reply({ content: 'Bot is not in any voice channel.', ephemeral: true });
      }
    }
    return;
  }

  if (cmd === 'avatar') {
    const user = interaction.options.getUser('user') || interaction.user;
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle(`${user.tag}'s Avatar`).setImage(user.displayAvatarURL({ size: 1024 }))] });
    return;
  }

  if (cmd === 'banner') {
    const user = interaction.options.getUser('user') || interaction.user;
    const fetched = await client.users.fetch(user.id, { force: true });
    const banner = fetched.bannerURL({ size: 1024 });
    if (!banner) return interaction.reply({ embeds: [smallEmbed(`${user.tag} has no banner.`)] });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle(`${user.tag}'s Banner`).setImage(banner)] });
    return;
  }

  // â”€â”€ lastwarn / lastban / lastmuted â”€â”€
  if (cmd === 'lastwarn') {
    if (!checkPerms(interaction.member, PermissionFlagsBits.ModerateMembers)) {
      return interaction.reply({ embeds: [errorEmbed('Moderate Members permission required.')], ephemeral: true });
    }
    const rows = db.prepare('SELECT * FROM warns WHERE guild_id = ? ORDER BY id DESC LIMIT 10').all(interaction.guildId);
    if (!rows.length) return interaction.reply({ embeds: [smallEmbed('No warns recorded.')], ephemeral: true });
    const lines = rows.map((r, i) => `**#${i+1}** <@${r.user_id}> \u2022 ${r.reason} \u2022 <t:${Math.floor(new Date(r.created_at).getTime() / 1000)}:R>`);
    await interaction.reply({ embeds: [embed(`Last Warns (${rows.length})`, lines.join('\n'))], ephemeral: true });
    return;
  }

  if (cmd === 'lastban') {
    if (!checkPerms(interaction.member, PermissionFlagsBits.BanMembers)) {
      return interaction.reply({ embeds: [errorEmbed('Ban Members permission required.')], ephemeral: true });
    }
    const since = Date.now() - 86400000;
    const entries = await interaction.guild.fetchAuditLogs({ type: 22, limit: 20 }).catch(() => null);
    if (!entries) return interaction.reply({ embeds: [errorEmbed('Could not fetch audit logs.')], ephemeral: true });
    const recent = entries.entries.filter(e => e.createdTimestamp > since);
    if (!recent.size) return interaction.reply({ embeds: [smallEmbed('No bans in the last 24 hours.')], ephemeral: true });
    const lines = [...recent.values()].slice(0, 10).map(e => `\u2022 **${e.target?.tag || 'Unknown'}** (\`${e.targetId}\`) \u2022 ${e.reason || 'No reason'} \u2022 <t:${Math.floor(e.createdTimestamp / 1000)}:R>`);
    await interaction.reply({ embeds: [embed(`Recent Bans (Last 24h)`, lines.join('\n'))], ephemeral: true });
    return;
  }

  if (cmd === 'lastmuted') {
    if (!checkPerms(interaction.member, PermissionFlagsBits.ModerateMembers)) {
      return interaction.reply({ embeds: [errorEmbed('Moderate Members permission required.')], ephemeral: true });
    }
    const since = Date.now() - 86400000;
    const entries = await interaction.guild.fetchAuditLogs({ type: 24, limit: 20 }).catch(() => null);
    if (!entries) return interaction.reply({ embeds: [errorEmbed('Could not fetch audit logs.')], ephemeral: true });
    const recent = entries.entries.filter(e => e.createdTimestamp > since);
    if (!recent.size) return interaction.reply({ embeds: [smallEmbed('No mutes in the last 24 hours.')], ephemeral: true });
    const lines = [...recent.values()].slice(0, 10).map(e => `\u2022 **${e.target?.tag || 'Unknown'}** (\`${e.targetId}\`) \u2022 ${e.reason || 'No reason'} \u2022 <t:${Math.floor(e.createdTimestamp / 1000)}:R>`);
    await interaction.reply({ embeds: [embed(`Recent Mutes (Last 24h)`, lines.join('\n'))], ephemeral: true });
    return;
  }

  // â”€â”€ deletewarn â”€â”€
  if (cmd === 'deletewarn') {
    if (!checkPerms(interaction.member, PermissionFlagsBits.ModerateMembers)) {
      return interaction.reply({ embeds: [errorEmbed('Moderate Members permission required.')], ephemeral: true });
    }
    const user = interaction.options.getUser('user');
    if (!user) return interaction.reply({ content: 'Provide a user.', ephemeral: true });
    const count = interaction.options.getString('count') || '1';
    if (count === 'all') {
      db.prepare('DELETE FROM warns WHERE guild_id = ? AND user_id = ?').run(interaction.guildId, user.id);
      await interaction.reply({ embeds: [smallEmbed(`All warns cleared for ${user.tag}.`)], ephemeral: true });
    } else {
      const num = parseInt(count);
      if (isNaN(num) || num < 1) return interaction.reply({ content: 'Count must be a number or "all".', ephemeral: true });
      const rows = db.prepare('SELECT id FROM warns WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?').all(interaction.guildId, user.id, num);
      if (!rows.length) return interaction.reply({ embeds: [errorEmbed('No warns to delete.')], ephemeral: true });
      for (const r of rows) db.prepare('DELETE FROM warns WHERE id = ?').run(r.id);
      await interaction.reply({ embeds: [smallEmbed(`**${rows.length}** warn(s) deleted for ${user.tag}.`)], ephemeral: true });
    }
    return;
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ AI CHAT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function askAI(provider, apiKey, model, prompt) {
  const urls = {
    deepseek: 'https://api.deepseek.com/v1/chat/completions',
    openai: 'https://api.openai.com/v1/chat/completions',
    grok: 'https://api.x.ai/v1/chat/completions',
    claude: 'https://api.anthropic.com/v1/messages',
  };
  const url = urls[provider] || (provider === 'custom' ? apiKey.split('|')[1] : null);
  if (!provider.startsWith('gemini') && !url) return 'Invalid AI provider or URL.';
  try {
    if (provider === 'gemini') {
      const models = model ? [model, 'gemini-2.0-flash', 'gemini-1.5-flash'] : ['gemini-2.0-flash', 'gemini-1.5-flash'];
      const versions = ['v1', 'v1beta'];
      let lastErr = '';
      for (const ver of versions) {
        for (const m of models) {
          const u = `https://generativelanguage.googleapis.com/${ver}/models/${m}:generateContent?key=${apiKey}`;
          try {
            const res = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
            const data = await res.json();
            if (data.error) { lastErr = `Gemini error: ${data.error.message} (${data.error.code})`; continue; }
            if (!data.candidates || data.candidates.length === 0) {
              const reason = data.promptFeedback?.blockReason || 'unknown';
              return `Gemini blocked: ${reason}`;
            }
            return data.candidates[0].content?.parts?.[0]?.text || 'No response from Gemini.';
          } catch (e) { lastErr = `Gemini error: ${e.message}`; continue; }
        }
      }
      return lastErr || 'All Gemini models failed.';
    }
    if (provider === 'claude') {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: model || 'claude-3-haiku-20240307', messages: [{ role: 'user', content: prompt }], max_tokens: 1024 }) });
      const data = await res.json();
      return data.content?.[0]?.text || 'No response from Claude.';
    }
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider === 'custom' ? apiKey.split('|')[0] : apiKey}` }, body: JSON.stringify({ model: model || 'deepseek-chat', messages: [{ role: 'user', content: prompt }], max_tokens: 1024 }) });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || 'No response from AI.';
  } catch (e) { return `AI error: ${e.message}`; }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ GIVEAWAY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const giveawayTimers = new Map();

function endGiveaway(msgId) {
  const g = giveaways.get(msgId);
  if (!g) return;
  if (giveawayTimers.has(msgId)) { clearTimeout(giveawayTimers.get(msgId)); giveawayTimers.delete(msgId); }
  giveaways.delete(msgId);
  const row = db.prepare('SELECT * FROM giveaways WHERE message_id = ?').get(msgId);
  if (!row) return;
  const entries = JSON.parse(row.entries);
  const valid = entries.filter(id => {
    try { return client.guilds.cache.get(row.guild_id)?.members.cache.has(id); } catch { return false; }
  });
  const winners = [];
  const count = Math.min(row.winners, valid.length);
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * valid.length);
    winners.push(valid.splice(idx, 1)[0]);
  }
  const winnerMentions = winners.length > 0 ? winners.map(id => `<@${id}>`).join(', ') : 'No winners';
  const resultEmbed = new EmbedBuilder().setColor(0x2b2d31)
    .setTitle('\uD83C\uDF89 Giveaway Ended')
    .setDescription(`**${row.prize}**\n\nWinner(s): ${winnerMentions}\nHosted by <@${row.host_id}>`)
    .setFooter({ text: 'Giveaway ended' });
  client.channels.fetch(row.channel_id).then(chan => {
    chan.messages.fetch(msgId).then(msg => {
      msg.edit({ embeds: [resultEmbed], components: [] });
    }).catch(() => {});
    if (winners.length > 0) chan.send(`\uD83C\uDF89 Congratulations ${winnerMentions}! You won **${row.prize}**!`).catch(() => {});
  }).catch(() => {});
  db.prepare('DELETE FROM giveaways WHERE message_id = ?').run(msgId);
}

function scheduleGiveawayEnd(msgId, data) {
  const remaining = data.endsAt - Date.now();
  if (remaining <= 0) { endGiveaway(msgId); return; }
  if (giveawayTimers.has(msgId)) clearTimeout(giveawayTimers.get(msgId));
  giveawayTimers.set(msgId, setTimeout(() => endGiveaway(msgId), remaining));
}

function loadGiveaways() {
  const rows = db.prepare('SELECT * FROM giveaways').all();
  for (const row of rows) {
    const data = { msgId: row.message_id, channelId: row.channel_id, guildId: row.guild_id, prize: row.prize, winners: row.winners, endsAt: row.ends_at, hostId: row.host_id, entries: JSON.parse(row.entries || '[]') };
    giveaways.set(row.message_id, data);
    scheduleGiveawayEnd(row.message_id, data);
  }
  console.log(`[GIVEAWAY] ${rows.length} loaded`);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ ANTI-SPAM / ANTI-INVITE / WORD FILTER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.guild || !msg.member) return;

  // â”€â”€ Pending rules capture â”€â”€
  if (pendingRules.has(msg.author.id)) {
    if (msg.content.startsWith(PREFIX)) return; // don't capture command itself
    pendingRules.delete(msg.author.id);
    ensureConfig(msg.guild.id);
    setConfig(msg.guild.id, 'rules_content', msg.content);
    await msg.reply({ embeds: [smallEmbed('Rules saved successfully!')] }).catch(() => {});
    return;
  }

  // â”€â”€ Handle prefix commands â”€â”€
  const isCommand = msg.content.startsWith(PREFIX);
  if (isCommand) {
    await handlePrefix(msg);
    return; // don't process further for commands
  }

  const content = msg.content;
  const cfg = db.prepare('SELECT * FROM config WHERE guild_id = ?').get(msg.guild.id) || {};

  // â”€â”€ AFK auto-clear â”€â”€
  const afkRow = db.prepare('SELECT * FROM afk WHERE guild_id = ? AND user_id = ?').get(msg.guild.id, msg.author.id);
  if (afkRow) {
    db.prepare('DELETE FROM afk WHERE guild_id = ? AND user_id = ?').run(msg.guild.id, msg.author.id);
    const ago = Math.floor((Date.now() - afkRow.since) / 60000);
    const label = ago < 1 ? 'ÅŸimdi' : ago < 60 ? `${ago} dakika Ã¶nce` : `${Math.floor(ago / 60)} saat Ã¶nce`;
    await msg.reply({ embeds: [new EmbedBuilder().setColor(0xCC3333).setDescription(`\uD83D\uDCA4 ${msg.author} **Active now!** Welcome back \u2014 AFK ${label}.`)], allowedMentions: { repliedUser: false } }).catch(() => {});
  }

  // â”€â”€ Auto-replies â”€â”€
  const autoreplies = db.prepare('SELECT * FROM auto_replies WHERE guild_id = ?').all(msg.guild.id);
  if (autoreplies.length > 0) {
    const lowerMsg = content.toLowerCase();
    for (const ar of autoreplies) {
      if (ar.trigger && ar.trigger.length >= 2 && lowerMsg.includes(ar.trigger.toLowerCase())) {
        console.log(`[AUTOREPLY] trigger="${ar.trigger}" content="${content}" match=true`);
        try { await msg.reply(ar.response); } catch (e) { console.log('[AUTOREPLY ERROR]', e.message); }
        break;
      }
    }
  }

  // â”€â”€ Keyword trigger log â”€â”€
  const keywords = db.prepare('SELECT trigger FROM keyword_logs WHERE guild_id = ?').all(msg.guild.id);
  if (keywords.length > 0) {
    const lowerMsg = content.toLowerCase();
    for (const kw of keywords) {
      if (lowerMsg.includes(kw.trigger)) {
        const e = new EmbedBuilder().setColor(0xf39c12).setTitle('Keyword Triggered').setDescription(`**Trigger:** \`${kw.trigger}\`\n**User:** ${msg.author.tag} (<@${msg.author.id}>)\n**Channel:** <#${msg.channel.id}>\n**Message:** ${msg.content}`).setFooter({ text: `User: ${msg.author.id}` }).setTimestamp();
        sendLog(msg.guild, LOG_TYPES.MESSAGE_KEYWORD, e);
        break;
      }
    }
  }

  // â”€â”€ AFK detection â”€â”€
  if (msg.mentions.users.size > 0) {
    for (const [uid] of msg.mentions.users) {
      const afk = db.prepare('SELECT * FROM afk WHERE guild_id = ? AND user_id = ?').get(msg.guild.id, uid);
      if (afk) {
        const ago = Math.floor((Date.now() - afk.since) / 60000);
        const timeStr = new Date(afk.since).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        const label = ago < 1 ? 'Åimdi' : ago < 60 ? `${ago} dakika Ã¶nce` : `${Math.floor(ago / 60)} saat Ã¶nce`;
        const target = msg.mentions.users.get(uid);
        await msg.reply({ embeds: [new EmbedBuilder().setColor(0xCC3333).setDescription(`\uD83D\uDCA4 ${msg.author}: ${target} is currently **AFK**: ${afk.reason} \u2014 ${timeStr} (${label})`)], allowedMentions: { repliedUser: false } });
        break;
      }
    }
  }

  // â”€â”€ AI chat â”€â”€
  const aiCfg = db.prepare('SELECT * FROM ai_config WHERE guild_id = ?').get(msg.guild.id);
  if (aiCfg && aiCfg.api_key && (!aiCfg.channel_id || aiCfg.channel_id === msg.channel.id)) {
    const prefixCmd = parsePrefix(content);
    if (!prefixCmd && content.includes(client.user.id)) {
      const prompt = content.replace(/<@!?\d+>/g, '').trim();
      if (prompt) {
        if (msg.attachments.size > 0) {
          await msg.reply({ embeds: [smallEmbed('This AI model does not support image input.')], allowedMentions: { repliedUser: false } });
          return;
        }
        await msg.channel.sendTyping();
        const reply = await askAI(aiCfg.provider, aiCfg.api_key, aiCfg.model || undefined, prompt);
        await msg.reply({ embeds: [smallEmbed(reply.slice(0, 1900))], allowedMentions: { repliedUser: false } });
    return;
  }
  }
  }

  // â”€â”€ Return if user has ManageMessages (bypass auto-mod) â”€â”€
  if (msg.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;

  // â”€â”€ Anti-spam (configurable) â”€â”€
  const spamMax = cfg.anti_spam_max || 5;
  const spamWindow = cfg.anti_spam_window || 4;
  const spamMute = cfg.anti_spam_mute || 300;
  if (checkSpam(msg, spamMax, spamWindow)) {
    try {
      await msg.delete();
      await msg.member.timeout(spamMute * 1000, 'Auto: spam detected').catch(() => {});
      await sendModLog(msg.guild, { Action: 'Anti-Spam', User: msg.author.tag, ID: msg.author.id, Duration: `${spamMute}s` });
    } catch {}
    return;
  }

  // â”€â”€ Anti-invite (configurable) â”€â”€
  if (cfg.anti_invite !== 0 && hasInvite(content)) {
    const whitelist = db.prepare('SELECT domain FROM invite_whitelist WHERE guild_id = ?').all(msg.guild.id).map(r => r.domain);
    const isWhitelisted = whitelist.some(d => content.includes(d));
    if (!isWhitelisted) {
      try {
        await msg.delete();
        const warnCount = cfg.invite_warns || 2;
        const muteSec = (cfg.invite_mute || 600);
        const reason = `Posting invite links`;
        for (let i = 0; i < warnCount; i++) {
          db.prepare('INSERT INTO warns (guild_id, user_id, moderator_id, reason, created_at) VALUES (?,?,?,?,?)').run(msg.guild.id, msg.author.id, client.user.id, reason, new Date().toISOString());
        }
        try { await msg.author.send({ embeds: [smallEmbed(`You received **${warnCount}** warning${warnCount > 1 ? 's' : ''} for: ${reason}.\nIf you reach your server's warn limit, you may be banned permanently.`)] }); } catch {}
        await msg.member.timeout(muteSec * 1000, reason).catch(() => {});
        await sendModLog(msg.guild, { Action: 'Auto-Mute (Invite)', User: msg.author.tag, ID: msg.author.id, Duration: `${muteSec}s`, Warns: warnCount });
        await checkWarnLimit(msg.guild, msg.author.id);
      } catch {}
    return;
  }
}

  // â”€â”€ Long message / flood detection â”€â”€
  if (content.length > (cfg.long_msg_threshold || 2000)) {
    try {
      await msg.delete();
      const warnCount = cfg.long_msg_warns || 2;
      const reason = 'Sending excessively long messages';
      for (let i = 0; i < warnCount; i++) {
        db.prepare('INSERT INTO warns (guild_id, user_id, moderator_id, reason, created_at) VALUES (?,?,?,?,?)').run(msg.guild.id, msg.author.id, client.user.id, reason, new Date().toISOString());
      }
      try { await msg.author.send({ embeds: [smallEmbed(`You received **${warnCount}** warning${warnCount > 1 ? 's' : ''} for: ${reason}.\nIf you reach your server's warn limit, you may be banned permanently.`)] }); } catch {}
      if ((cfg.long_msg_action || 'mute') === 'ban') {
        await msg.member.ban({ reason }).catch(() => {});
        await sendModLog(msg.guild, { Action: 'Auto-Ban (Long Message)', User: msg.author.tag, ID: msg.author.id, Warns: warnCount });
      } else {
        await msg.member.timeout((cfg.long_msg_mute || 3600) * 1000, reason).catch(() => {});
        await sendModLog(msg.guild, { Action: 'Auto-Mute (Long Message)', User: msg.author.tag, ID: msg.author.id, Duration: `${cfg.long_msg_mute || 3600}s`, Warns: warnCount });
      }
      await checkWarnLimit(msg.guild, msg.author.id);
    } catch {}
    return;
  }

  // â”€â”€ Word filters â”€â”€
  const banned = db.prepare('SELECT word, action, duration FROM word_filters WHERE guild_id = ?').all(msg.guild.id);
  if (banned.length === 0) return;
  const lower = content.toLowerCase();
  for (const { word, action, duration } of banned) {
    if (lower.includes(word)) {
      try {
        await msg.delete();
        if (action === 'ban') {
          await msg.member.ban({ reason: `Auto: banned word "${word}"` }).catch(() => {});
        } else {
          const ms = duration ? getTimeSeconds(duration) * 1000 : 3600000;
          await msg.member.timeout(ms || 3600000, `Auto: muted word "${word}"`).catch(() => {});
        }
        await sendModLog(msg.guild, { Action: `Auto-${action}`, User: msg.author.tag, ID: msg.author.id, Word: word, Duration: duration || '1h' });
      } catch {}
      break;
    }
  }
});

client.login(TOKEN);

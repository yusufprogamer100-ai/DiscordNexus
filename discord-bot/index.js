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
    GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildVoiceStates,
  ],
});

const cache = new Map();
const giveaways = new Map();
const pendingRules = new Map(); // userId -> true, waiting for next message to save as rules
const timers = new Map();

// ─────────────────────────────── POLL HELPERS ───────────────────────────────

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
  return '█'.repeat(Math.max(0, f)) + '░'.repeat(Math.max(0, w - f));
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

// ─────────────────────────────── LOG & UTILITY ───────────────────────────────

async function sendModLog(guild, fields) {
  const logId = db.prepare('SELECT log_channel_id FROM config WHERE guild_id = ?').get(guild.id)?.log_channel_id;
  if (!logId) return;
  try {
    const channel = await guild.channels.fetch(logId);
    const e = new EmbedBuilder().setColor(0x2b2d31).setTimestamp();
    for (const [name, value] of Object.entries(fields)) {
      e.addFields({ name, value: String(value), inline: true });
    }
    await channel.send({ embeds: [e] });
  } catch {}
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

// ─────────────────────────────── MODERATION HELPERS ───────────────────────────────

async function getMember(guild, userId) {
  try { return await guild.members.fetch(userId); } catch { return null; }
}

async function checkWarnLimit(guild, userId) {
  const ws = db.prepare('SELECT * FROM warn_settings WHERE guild_id = ?').get(guild.id);
  if (!ws) return;
  const count = db.prepare('SELECT COUNT(*) as c FROM warns WHERE guild_id = ? AND user_id = ?').get(guild.id, userId).c;
  if (count >= ws.max_warns) {
    const member = await getMember(guild, userId);
    if (!member) return;
    const action = ws.action;
    if (action === 'kick') {
      await member.kick(`Warn limit reached (${ws.max_warns})`).catch(() => {});
    } else if (action === 'ban') {
      await member.ban({ reason: `Warn limit reached (${ws.max_warns})` }).catch(() => {});
    } else if (action === 'mute') {
      const dur = getTimeSeconds(ws.mute_duration) || 3600;
      await member.timeout(dur * 1000, `Warn limit reached (${ws.max_warns})`).catch(() => {});
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

// ─────────────────────────────── PREFIX COMMANDS ───────────────────────────────

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
  const { cmd, args } = parsed;
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

  // ── Warn ──
  if (cmd === 'warn') {
    if (!modError(PermissionFlagsBits.ModerateMembers)) return;
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

  // ── Ban / Kick ──
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

  // ── Mute ──
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

  // ── Role ──
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

  // ── Snipe ──
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

  // ── Banner ──
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

  // ── Avatar ──
  if (cmd === 'avatar' || cmd === 'av') {
    const target = getTargetFromMsg(msg, args) || member.user;
    const user = target.id ? await client.users.fetch(target.id).catch(() => null) : null;
    if (!user) return msg.reply({ embeds: [errorEmbed('User not found.')] });
    await msg.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle(`${user.tag}'s Avatar`).setImage(user.displayAvatarURL({ size: 4096, force: true }))] });
    return;
  }

  // ── Lock / Unlock ──
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

  // ── Slowmode ──
  if (cmd === 'slowmode') {
    if (!modError(PermissionFlagsBits.ManageChannels)) return;
    const sec = getTimeSeconds(args[0]);
    if (sec === null || sec < 0 || sec > 21600) return msg.reply({ embeds: [errorEmbed('Invalid slowmode (0-21600s).')] });
    await msg.channel.setRateLimitPerUser(sec);
    await msg.reply({ embeds: [smallEmbed(`\u23F3 Slowmode set to ${timeLabel(sec)}.`)] });
    return;
  }

  // ── Clear ──
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

  // ── Nuke ──
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

  // ── Raidmode ──
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

  // ── Voicekick ──
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

  // ── Deafen ──
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

  // ── Timeout ──
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

  // ── Banword / Warnword / Muteword (prefix) ──
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

  // ── Rules (capture) ──
  if (cmd === 'rules') {
    if (member.id !== OWNER_ID) return msg.reply({ embeds: [errorEmbed('Owner only.')] });
    pendingRules.set(member.id, true);
    await msg.reply({ embeds: [smallEmbed('Rules message waiting...')] });
    return;
  }

  // ── Endpoll prefix ──
  if (cmd === 'endpoll') {
    if (member.id !== OWNER_ID) return msg.reply({ embeds: [errorEmbed('Owner only.')] });
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
}

// ─────────────────────────────── PANEL SYSTEM ───────────────────────────────

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

  const desc = [
    `**${interaction.guild.name}** \u2014 ${interaction.guild.memberCount} members`,
    `\u23F1 Uptime: ${Math.floor(process.uptime() / 60)}m`,
    '',
    `\uD83D\uDCCA **Stats**`,
    `  \u2022 Polls: **${pollCount}** active / **${db.prepare('SELECT COUNT(*) as c FROM history WHERE guild_id = ?').get(interaction.guildId).c}** archived`,
    `  \u2022 Warns: **${totalWarns}** total | Temp Bans: **${activeBans}** | Subs: **${subs}**`,
    '',
    `\u2699\uFE0F **Config**`,
    `  \u2022 Warn: **${wsCount}** \u2192 **${wsAction}**${wsAction === 'mute' ? ` (${ws?.mute_duration || '1h'})` : ''}`,
    `  \u2022 Filters: **${banWords}** ban / **${muteWords}** mute`,
    `  \u2022 Anti-Spam: **${cfg.anti_spam_max || 5}**msgs/**${cfg.anti_spam_window || 4}s**`,
    `  \u2022 Anti-Invite: **${cfg.anti_invite !== 0 ? 'ON' : 'OFF'}**${cfg.anti_invite !== 0 ? ` (\u2192${cfg.invite_warns || 2}w + ${cfg.invite_mute || 600}s mute)` : ''}`,
    `  \u2022 Log: ${logChanId ? `<#${logChanId}>` : 'Not set'}`,
    `  \u2022 Tag: ${tagChanId ? `<#${tagChanId}>` : 'Not set'}`,
    `  \u2022 AI: ${aiCfg ? `**${aiCfg.provider}**` : 'Not configured'}`,
    `  \u2022 Tickets: ${ticketCfg ? `Ready` : 'Not configured'}`,
  ].join('\n');

  const btn = (id, label, style) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

  return {
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('\uD83D\uDEE1\uFE0F Admin Panel').setDescription(desc)],
    components: [
      new ActionRowBuilder().addComponents(
        btn('panel_polls', '\uD83D\uDCCA Polls', ButtonStyle.Secondary),
        btn('panel_warns', '\u26A0\uFE0F Warns', ButtonStyle.Secondary),
        btn('panel_words', '\uD83D\uDD0D Filters', ButtonStyle.Secondary),
        btn('panel_autoreply', '\uD83E\uDD16 Auto', ButtonStyle.Secondary),
        btn('panel_antispam', '\uD83D\uDEE1\uFE0F Anti', ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        btn('panel_log', '\uD83D\uDCDD Log', ButtonStyle.Secondary),
        btn('panel_tag', '\uD83D\uDC4B Tag', ButtonStyle.Secondary),
        btn('panel_ticket', '\uD83C\uDFAB Ticket', ButtonStyle.Secondary),
        btn('panel_ai', '\uD83E\uDD16 AI', ButtonStyle.Secondary),
        btn('panel_bans', '\uD83D\uDD28 Bans', ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        btn('panel_stats', '\uD83D\uDCC8 Stats', ButtonStyle.Secondary),
        btn('panel_close', '\u274C Close', ButtonStyle.Danger),
      ),
    ],
  };
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
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_main').setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function panelLog(interaction) {
  const logChanId = db.prepare('SELECT log_channel_id FROM config WHERE guild_id = ?').get(interaction.guildId)?.log_channel_id;
  const desc = logChanId ? `Log channel: <#${logChanId}>` : 'No log channel set.';

  return {
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('\uD83D\uDCDD Log Channel').setDescription(desc)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_act_log').setLabel('\uD83D\uDD0D Set Log Channel').setStyle(ButtonStyle.Primary),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_main').setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
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
  return {
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('\uD83E\uDD16 AI Chat').setDescription(desc)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_act_ai').setLabel(cfg ? '\u2699\uFE0F Reconfigure' : '\u2795 Configure').setStyle(ButtonStyle.Primary),
        ...(cfg ? [new ButtonBuilder().setCustomId('panel_act_ai_disable').setLabel('\u274C Disable').setStyle(ButtonStyle.Danger)] : []),
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

// ─────────────────────────────── PANEL BUTTON HANDLER ───────────────────────────────

async function handlePanelButton(interaction) {
  if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Owner only.', ephemeral: true });
  const id = interaction.customId;

  if (id === 'panel_log') return interaction.update(panelLog(interaction));
  if (id === 'panel_tag') return interaction.update(panelTag(interaction));
  if (id === 'panel_ticket') return interaction.update(panelTicket(interaction));
  if (id === 'panel_ai') return interaction.update(panelAI(interaction));
  if (id === 'panel_antispam') return interaction.update(panelAntiSpam(interaction));
  if (id === 'panel_bans') return interaction.update(panelBans(interaction));
  if (id === 'panel_main') return interaction.update(panelMain(interaction));
  if (id === 'panel_stats') return interaction.update(panelStats(interaction));
  if (id === 'panel_polls') return interaction.update(panelPolls(interaction));
  if (id === 'panel_warns') return interaction.update(panelWarns(interaction));
  if (id === 'panel_words') return interaction.update(panelWords(interaction));
  if (id === 'panel_autoreply') return interaction.update(panelAutoReply(interaction));
  if (id === 'panel_close') return interaction.message.delete().catch(() => {});

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
    { id: 'response', label: 'Bot response', placeholder: 'Hi there!', min: 1, max: 500, long: true },
  ]));
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

  // Quick actions
  if (id.startsWith('panel_act_warnaction_')) {
    const action = id.replace('panel_act_warnaction_', '');
    if (!['kick', 'ban', 'mute'].includes(action)) return;
    db.prepare('INSERT OR REPLACE INTO warn_settings (guild_id, max_warns, action, mute_duration) VALUES (?,COALESCE((SELECT max_warns FROM warn_settings WHERE guild_id = ?),5),?,COALESCE((SELECT mute_duration FROM warn_settings WHERE guild_id = ?),\'1h\'))')
      .run(interaction.guildId, interaction.guildId, action, interaction.guildId);
    await interaction.update(panelWarns(interaction));
    await sendModLog(interaction.guild, { Action: 'Warn Action Changed', Moderator: interaction.user.tag, NewAction: action });
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
}

async function handlePanelModal(interaction) {
  if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Owner only.', ephemeral: true });
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
    const channel = interaction.guild.channels.cache.get(channelId);
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
      return interaction.reply({ content: 'Invalid channel ID or not a text channel.', ephemeral: true });
    }
    ensureConfig(interaction.guildId);
    setConfig(interaction.guildId, 'log_channel_id', channelId);
    await interaction.update(panelLog(interaction));
    await sendModLog(interaction.guild, { Action: 'Log Channel Set', Moderator: interaction.user.tag, Channel: `<#${channelId}>` });
    return;
  }

  if (id === 'modal_tag') {
    const channelId = interaction.fields.getTextInputValue('channel').replace(/[<#>]/g, '');
    const channel = interaction.guild.channels.cache.get(channelId);
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
      return interaction.reply({ content: 'Invalid channel ID.', ephemeral: true });
    }
    ensureConfig(interaction.guildId);
    setConfig(interaction.guildId, 'tag_channel_id', channelId);
    await interaction.update(panelTag(interaction));
    await sendModLog(interaction.guild, { Action: 'Tag Channel Set', Moderator: interaction.user.tag, Channel: `<#${channelId}>` });
    return;
  }

  if (id === 'modal_ticket_cat') {
    const catId = interaction.fields.getTextInputValue('cat');
    const cat = interaction.guild.channels.cache.get(catId);
    if (!cat || cat.type !== ChannelType.GuildCategory) {
      return interaction.reply({ content: 'Invalid category ID.', ephemeral: true });
    }
    db.prepare('INSERT OR REPLACE INTO ticket_config (guild_id, category_id, role_id) VALUES (?,?,COALESCE((SELECT role_id FROM ticket_config WHERE guild_id = ?),NULL))')
      .run(interaction.guildId, catId, interaction.guildId);
    await interaction.update(panelTicket(interaction));
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
}

// ── Config helper (safe column update, won't wipe other cols) ──
function setConfig(guildId, column, value) {
  db.prepare(`INSERT INTO config (guild_id, ${column}) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET ${column} = excluded.${column}`).run(guildId, value);
}
function ensureConfig(guildId) {
  db.prepare('INSERT INTO config (guild_id) VALUES (?) ON CONFLICT(guild_id) DO NOTHING').run(guildId);
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

// ─────────────────────────────── CLIENT EVENTS ───────────────────────────────

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

client.on('messageDelete', (msg) => {
  if (msg.author?.bot || !msg.guild || !msg.content) return;
  snipe.add(msg.guild.id, msg.channel.id, {
    authorId: msg.author.id,
    author: msg.author.tag,
    content: msg.content,
    timestamp: Date.now(),
  });
});

client.on('guildMemberAdd', async (member) => {
  const chanId = db.prepare('SELECT tag_channel_id FROM config WHERE guild_id = ?').get(member.guild.id)?.tag_channel_id;
  if (!chanId) return;
  try {
    const chan = await member.guild.channels.fetch(chanId);
    const m = await chan.send({ content: `${member}` });
    setTimeout(() => m.delete().catch(() => {}), 100);
  } catch {}
});

client.on('guildMemberRemove', async (member) => {
  db.prepare('DELETE FROM afk WHERE guild_id = ? AND user_id = ?').run(member.guild.id, member.user.id);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    await handleSlash(interaction);
    return;
  }
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('panel_')) return handlePanelButton(interaction);
    if (interaction.customId === 'ticket_open') {
      const cfg = db.prepare('SELECT * FROM ticket_config WHERE guild_id = ?').get(interaction.guildId);
      const existing = interaction.guild.channels.cache.find(c => c.name === `ticket-${interaction.user.id}`);
      if (existing) return interaction.reply({ content: `You already have a ticket: ${existing}`, ephemeral: true });
      const perms = [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
      ];
      if (cfg?.role_id) perms.push({ id: cfg.role_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
      let ticketChan;
      try {
        ticketChan = await interaction.guild.channels.create({
          name: `ticket-${interaction.user.id}`,
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
        .setDescription(`**Ticket Opened**\n${interaction.user} thank you for reaching out.\nSupport team will be with you shortly.\n\n\u2022 **User:** ${interaction.user.tag} (\`${interaction.user.id}\`)\n\u2022 **Opened:** <t:${Math.floor(Date.now() / 1000)}:R>`);
      const closeBtn = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_close').setLabel('\uD83D\uDD12 Close Ticket').setStyle(ButtonStyle.Danger),
      );
      await ticketChan.send({ content: `${interaction.user}`, embeds: [ticketEmbed], components: [closeBtn] });
      await interaction.reply({ content: `Ticket created: ${ticketChan}`, ephemeral: true });
      return;
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
      const closeEmbed = new EmbedBuilder().setColor(0xCC3333).setDescription(`**Ticket Closed**\nTicket closed by ${interaction.user}.\nChannel will be deleted shortly.`);
      await interaction.reply({ embeds: [closeEmbed] });
      setTimeout(() => interaction.channel.delete().catch(() => {}), 10000);
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
    await handlePanelModal(interaction);
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
    const isOwner = interaction.user.id === OWNER_ID;
    const everyoneCmds = [
      '**⚡ EVERYONE**',
      '  \u2022 `/help` \u2014 This menu',
      '  \u2022 `/userinfo` \u2014 User info',
      '  \u2022 `/serverinfo` \u2014 Server info',
      '  \u2022 `/afk <reason>` \u2014 Set AFK',
      '  \u2022 `/remind <time> <msg>` \u2014 Reminder (DM)',
      '  \u2022 `/ticket` \u2014 Open a support ticket',
      '  \u2022 `/entervc <channel>` \u2014 Bot joins VC',
      '  \u2022 `/leavevc` \u2014 Bot leaves VC',
      '  \u2022 `/activepolls` \u2014 View active polls',
      '  \u2022 `/history` \u2014 Past poll results',
      '  \u2022 `/subscribe` \u2014 Poll DM alerts',
      '  \u2022 `/giveaway` \u2014 (owner only)',
      '',
      '**📋 POLLS**',
      '  \u2022 `/poll` \u2014 Create a poll',
      '  \u2022 `/endpoll <id>` \u2014 End a poll',
      '  \u2022 `,endpoll <id>` \u2014 End via prefix too',
      '  \u2022 `/announce <id>` \u2014 Announce winner',
      '',
      '**🛡️ MODERATION** _(prefix `,`)_',
      '  \u2022 `,warn` `,warns` `,clearwarns` `,removewarn`',
      '  \u2022 `,ban` `,pban` `,kick` `,unban`',
      '  \u2022 `,mute` `,unmute` `,timeout` `,untimeout`',
      '  \u2022 `,role` `,lock` `,unlock` `,slowmode`',
      '  \u2022 `,clear` `,nuke` `,raidmode`',
      '  \u2022 `,voicekick` `,deafen` `,undeafen`',
      '  \u2022 `,snipe` `,banner` `,avatar`',
      '',
      '**⚙️ SHORTCUTS** _(prefix)_',
      '  \u2022 `,warnword <word> [time]` / `,muteword <word> [time]`',
      '  \u2022 `,addword <trigger> <reply>` \u2014 Auto-reply',
      '  \u2022 `,endpoll <id>` \u2014 End poll by ID',
      '  \u2022 `,rules` \u2014 Save rules (owner)',
    ];
    if (isOwner) {
      everyoneCmds.push(
        '',
        '**🔧 OWNER ONLY**',
        '  \u2022 `/panel` \u2014 Full admin panel',
        '  \u2022 `/settings` \u2014 View settings',
        '  \u2022 `/setlog`, `/tagchannel`, `/ai`',
        '  \u2022 `/warncount`, `/warnsetting`, `/warnsettings`',
        '  \u2022 `/banword`, `/muteword`, `/automessage`',
        '  \u2022 `/giverole`, `/bantime`',
        '  \u2022 `/roleall`, `/removeall`, `/slowmode`',
        '  \u2022 `/lock`, `/unlock`, `/nick`, `/emoji`',
        '  \u2022 `/purge`, `/sendmessage`, `/rules`, `/say`',
        '  \u2022 `/endgiveaway`, `/reroll`',
      );
    }
    const bannerPath = require('path').join(__dirname, 'assets', 'banner.png');
    const bannerFile = require('fs').existsSync(bannerPath) ? new AttachmentBuilder(bannerPath) : null;
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x000000).setImage(bannerFile ? 'attachment://banner.png' : null).setDescription(everyoneCmds.join('\n'))],
      files: bannerFile ? [bannerFile] : [],
      ephemeral: true,
    });
    return;
  }

  // ── Poll commands ──
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
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Owner only.', ephemeral: true });
    const msgId = interaction.options.getString('message_id');
    const poll = cache.get(msgId);
    if (!poll) return interaction.reply({ content: 'Poll not found.', ephemeral: true });
    if (poll.authorId !== interaction.user.id && !checkPerms(interaction.member, PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ content: 'Only the poll creator or users with Manage Messages can end polls.', ephemeral: true });
    }
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
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
      return interaction.reply({ content: 'Select a text channel.', ephemeral: true });
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

  // ── Moderation slash commands ──

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
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xCC3333).setDescription(`\uD83D\uDCA4 ${interaction.user} is now **AFK**: ${reason} \u2014 ${timeStr}`)], ephemeral: true });
    return;
  }

  if (cmd === 'ticket') {
    const btn = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_open').setLabel('\uD83C\uDFAB Open Ticket').setStyle(ButtonStyle.Primary),
    );
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('Support Tickets').setDescription('Click the button below to open a support ticket.')], components: [btn], ephemeral: true });
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
    await interaction.editReply({ embeds: [smallEmbed(`${isGive ? 'Given' : 'Removed'} **${role.name}** to/from **${success}** members.${fail ? ` Failed: ${fail}` : ''}`)] });
    await sendModLog(interaction.guild, { Action: isGive ? 'Role All' : 'Remove All', Moderator: interaction.user.tag, Role: role.name, Success: success, Failed: fail });
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
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('User Info').setDescription(lines.join('\n')).setThumbnail(user.displayAvatarURL())], ephemeral: true });
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
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('Server Info').setDescription(lines.join('\n')).setThumbnail(guild.iconURL())], ephemeral: true });
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

  // ── Giveaway commands ──
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
      new ButtonBuilder().setCustomId('giveaway_join').setEmoji('🎉').setLabel('Enter').setStyle(ButtonStyle.Success),
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
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle(`${user.tag}'s Avatar`).setImage(user.displayAvatarURL({ size: 1024 }))], ephemeral: true });
    return;
  }

  if (cmd === 'banner') {
    const user = interaction.options.getUser('user') || interaction.user;
    const fetched = await client.users.fetch(user.id, { force: true });
    const banner = fetched.bannerURL({ size: 1024 });
    if (!banner) return interaction.reply({ embeds: [smallEmbed(`${user.tag} has no banner.`)], ephemeral: true });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle(`${user.tag}'s Banner`).setImage(banner)], ephemeral: true });
    return;
  }
}

// ─────────────────────────────── AI CHAT ───────────────────────────────

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

// ─────────────────────────────── GIVEAWAY ───────────────────────────────

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

// ─────────────────────────────── ANTI-SPAM / ANTI-INVITE / WORD FILTER ───────────────────────────────

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.guild || !msg.member) return;

  // ── Pending rules capture ──
  if (pendingRules.has(msg.author.id)) {
    if (msg.content.startsWith(PREFIX)) return; // don't capture command itself
    pendingRules.delete(msg.author.id);
    ensureConfig(msg.guild.id);
    setConfig(msg.guild.id, 'rules_content', msg.content);
    await msg.reply({ embeds: [smallEmbed('Rules saved successfully!')] }).catch(() => {});
    return;
  }

  // ── Handle prefix commands ──
  const isCommand = msg.content.startsWith(PREFIX);
  if (isCommand) {
    await handlePrefix(msg);
    return; // don't process further for commands
  }

  const content = msg.content;
  const cfg = db.prepare('SELECT * FROM config WHERE guild_id = ?').get(msg.guild.id) || {};

  // ── AFK auto-clear ──
  const afkRow = db.prepare('SELECT * FROM afk WHERE guild_id = ? AND user_id = ?').get(msg.guild.id, msg.author.id);
  if (afkRow) {
    db.prepare('DELETE FROM afk WHERE guild_id = ? AND user_id = ?').run(msg.guild.id, msg.author.id);
    const ago = Math.floor((Date.now() - afkRow.since) / 60000);
    const label = ago < 1 ? 'şimdi' : ago < 60 ? `${ago} dakika önce` : `${Math.floor(ago / 60)} saat önce`;
    await msg.reply({ embeds: [new EmbedBuilder().setColor(0xCC3333).setDescription(`\uD83D\uDCA4 ${msg.author} **Active now!** Welcome back \u2014 AFK ${label}.`)], allowedMentions: { repliedUser: false } }).catch(() => {});
  }

  // ── Auto-replies ──
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

  // ── AFK detection ──
  if (msg.mentions.users.size > 0) {
    for (const [uid] of msg.mentions.users) {
      const afk = db.prepare('SELECT * FROM afk WHERE guild_id = ? AND user_id = ?').get(msg.guild.id, uid);
      if (afk) {
        const ago = Math.floor((Date.now() - afk.since) / 60000);
        const timeStr = new Date(afk.since).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        const label = ago < 1 ? 'Şimdi' : ago < 60 ? `${ago} dakika önce` : `${Math.floor(ago / 60)} saat önce`;
        const target = msg.mentions.users.get(uid);
        await msg.reply({ embeds: [new EmbedBuilder().setColor(0xCC3333).setDescription(`\uD83D\uDCA4 ${msg.author}: ${target} is currently **AFK**: ${afk.reason} \u2014 ${timeStr} (${label})`)], allowedMentions: { repliedUser: false } });
        break;
      }
    }
  }

  // ── AI chat ──
  const aiCfg = db.prepare('SELECT * FROM ai_config WHERE guild_id = ?').get(msg.guild.id);
  if (aiCfg && aiCfg.api_key && (!aiCfg.channel_id || aiCfg.channel_id === msg.channel.id)) {
    const prefixCmd = parsePrefix(content);
    if (!prefixCmd && content.includes(client.user.id)) {
      const prompt = content.replace(/<@!?\d+>/g, '').trim();
      if (prompt) {
        await msg.channel.sendTyping();
        const reply = await askAI(aiCfg.provider, aiCfg.api_key, aiCfg.model || undefined, prompt);
        await msg.reply({ embeds: [smallEmbed(reply.slice(0, 1900))], allowedMentions: { repliedUser: false } });
    return;
  }

  // ── Addword (prefix auto-reply) ──
  if (cmd === 'addword') {
    if (!modError(PermissionFlagsBits.ManageMessages)) return;
    const trigger = args[0]?.toLowerCase();
    const response = args.slice(1).join(' ');
    if (trigger === 'list') {
      const replies = db.prepare('SELECT trigger, response FROM auto_replies WHERE guild_id = ?').all(guild.id);
      if (!replies.length) return msg.reply({ embeds: [smallEmbed('No auto-replies.')] });
      return msg.reply({ embeds: [embed('Auto-Replies', replies.map(r => `\`${r.trigger}\` \u2192 ${r.response}`).join('\n'))] });
    }
    if ((trigger === 'remove' || trigger === 'del') && response) {
      db.prepare('DELETE FROM auto_replies WHERE guild_id = ? AND trigger = ?').run(guild.id, response.toLowerCase());
      return msg.reply({ embeds: [smallEmbed(`\u2705 Auto-reply \`${response}\` removed.`)] });
    }
    if (!trigger || trigger.length < 2 || !response) return msg.reply({ embeds: [errorEmbed('Usage: ,addword trigger response')] });
    db.prepare('INSERT OR REPLACE INTO auto_replies VALUES (?,?,?)').run(guild.id, trigger, response);
    await msg.reply({ embeds: [smallEmbed(`\u2705 Auto-reply added: \`${trigger}\``)] });
    return;
  }
}
  }

  // ── Return if user has ManageMessages (bypass auto-mod) ──
  if (msg.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;

  // ── Anti-spam (configurable) ──
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

  // ── Anti-invite (configurable) ──
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

  // ── Long message / flood detection ──
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

  // ── Word filters ──
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

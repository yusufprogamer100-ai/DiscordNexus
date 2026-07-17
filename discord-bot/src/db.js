const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS config (guild_id TEXT PRIMARY KEY, log_channel_id TEXT);
  CREATE TABLE IF NOT EXISTS polls (message_id TEXT PRIMARY KEY, guild_id TEXT, channel_id TEXT, options TEXT, counts TEXT, voters TEXT, author_id TEXT, ends_at INTEGER, ping TEXT, created_by TEXT, description TEXT);
  CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, options TEXT, counts TEXT, winner TEXT, total_votes INTEGER, closed_at TEXT, created_by TEXT);
  CREATE TABLE IF NOT EXISTS subscribers (user_id TEXT, guild_id TEXT, PRIMARY KEY (user_id, guild_id));
  CREATE TABLE IF NOT EXISTS warn_settings (guild_id TEXT PRIMARY KEY, max_warns INTEGER DEFAULT 5, action TEXT DEFAULT 'kick', mute_duration TEXT DEFAULT '1h');
  CREATE TABLE IF NOT EXISTS warns (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, user_id TEXT, moderator_id TEXT, reason TEXT, created_at TEXT);
  CREATE TABLE IF NOT EXISTS tempbans (guild_id TEXT, user_id TEXT, ends_at INTEGER, reason TEXT, moderator_id TEXT, PRIMARY KEY (guild_id, user_id));
  CREATE TABLE IF NOT EXISTS word_filters (guild_id TEXT, word TEXT, action TEXT, PRIMARY KEY (guild_id, word));
  CREATE TABLE IF NOT EXISTS mute_settings (guild_id TEXT PRIMARY KEY, duration TEXT DEFAULT '1h');
  CREATE TABLE IF NOT EXISTS auto_replies (guild_id TEXT, trigger TEXT, response TEXT, PRIMARY KEY (guild_id, trigger));
`);

// ── Schema migrations for new features ──
try { db.exec('ALTER TABLE polls ADD COLUMN description TEXT'); } catch {}
try { db.exec('ALTER TABLE config ADD COLUMN tag_channel_id TEXT'); } catch {}
try { db.exec('ALTER TABLE config ADD COLUMN anti_spam_max INTEGER DEFAULT 5'); } catch {}
try { db.exec('ALTER TABLE config ADD COLUMN anti_spam_window INTEGER DEFAULT 4'); } catch {}
try { db.exec('ALTER TABLE config ADD COLUMN anti_spam_mute INTEGER DEFAULT 300'); } catch {}
try { db.exec('ALTER TABLE config ADD COLUMN anti_invite INTEGER DEFAULT 1'); } catch {}
try { db.exec('ALTER TABLE config ADD COLUMN invite_warns INTEGER DEFAULT 2'); } catch {}
try { db.exec('ALTER TABLE config ADD COLUMN invite_mute INTEGER DEFAULT 600'); } catch {}
try { db.exec('ALTER TABLE config ADD COLUMN rules_content TEXT'); } catch {}
try { db.exec('ALTER TABLE config ADD COLUMN long_msg_threshold INTEGER DEFAULT 2000'); } catch {}
try { db.exec('ALTER TABLE config ADD COLUMN long_msg_warns INTEGER DEFAULT 2'); } catch {}
try { db.exec('ALTER TABLE config ADD COLUMN long_msg_mute INTEGER DEFAULT 3600'); } catch {}
try { db.exec('ALTER TABLE config ADD COLUMN long_msg_action TEXT DEFAULT "mute"'); } catch {}
try { db.exec('ALTER TABLE word_filters ADD COLUMN duration TEXT DEFAULT NULL'); } catch {}

// ── New feature tables ──
db.exec(`
  CREATE TABLE IF NOT EXISTS afk (guild_id TEXT, user_id TEXT, reason TEXT, since INTEGER, PRIMARY KEY (guild_id, user_id));
  CREATE TABLE IF NOT EXISTS ticket_config (guild_id TEXT PRIMARY KEY, category_id TEXT, role_id TEXT);
  CREATE TABLE IF NOT EXISTS tickets (channel_id TEXT PRIMARY KEY, guild_id TEXT, user_id TEXT, status TEXT DEFAULT 'open', created_at INTEGER, closed_by TEXT, closed_at INTEGER);
  CREATE TABLE IF NOT EXISTS invite_whitelist (guild_id TEXT, domain TEXT, PRIMARY KEY (guild_id, domain));
  CREATE TABLE IF NOT EXISTS ai_config (guild_id TEXT PRIMARY KEY, provider TEXT, api_key TEXT, model TEXT, channel_id TEXT);
  CREATE TABLE IF NOT EXISTS custom_commands (guild_id TEXT, name TEXT, response TEXT, PRIMARY KEY (guild_id, name));
  CREATE TABLE IF NOT EXISTS public_commands (guild_id TEXT, cmd TEXT, PRIMARY KEY (guild_id, cmd));
  CREATE TABLE IF NOT EXISTS giveaways (message_id TEXT PRIMARY KEY, guild_id TEXT, channel_id TEXT, prize TEXT, winners INTEGER, ends_at INTEGER, host_id TEXT, entries TEXT);
  CREATE TABLE IF NOT EXISTS mod_roles (guild_id TEXT, role_id TEXT, permissions TEXT DEFAULT '{}', PRIMARY KEY (guild_id, role_id));
  CREATE TABLE IF NOT EXISTS command_permissions (guild_id TEXT, command_name TEXT, allowed_roles TEXT DEFAULT '[]', PRIMARY KEY (guild_id, command_name));
  CREATE TABLE IF NOT EXISTS log_settings (guild_id TEXT, log_type TEXT, enabled INTEGER DEFAULT 1, channel_id TEXT, PRIMARY KEY (guild_id, log_type));
  CREATE TABLE IF NOT EXISTS keyword_logs (guild_id TEXT, trigger TEXT, PRIMARY KEY (guild_id, trigger));
`);

module.exports = db;

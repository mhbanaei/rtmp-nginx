'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashPassword, randomPassword, randomStreamKey } = require('./security');

const PLATFORMS = {
  youtube: {
    label: 'YouTube',
    hint: 'YouTube Studio → Live → Stream key',
    serverUrl: 'rtmp://a.rtmp.youtube.com/live2/'
  },
  twitch: {
    label: 'Twitch',
    hint: 'Twitch Dashboard → Settings → Stream → Primary Stream key',
    serverUrl: 'rtmp://dus01.contribute.live-video.net/app/'
  },
  kick: {
    label: 'Kick',
    hint: 'Kick Dashboard → Settings → Stream key (uses RTMPS)',
    serverUrl: 'rtmps://fa723fc1b171.global-contribute.live-video.net/'
  },
  restream: {
    label: 'Restream',
    hint: 'Restream Studio → Destinations → RTMP key',
    serverUrl: 'rtmp://frankfurt.restream.io/live/'
  },
  aparat: {
    label: 'Aparat',
    hint: 'کلید پخش آپارات را وارد کنید (آدرس سرور ثابت است)',
    serverUrl: 'rtmp://rtmp.cdn.asset.aparat.com:443/event'
  }
};

const DEFAULT_ALLOWED_PLATFORMS = ['restream', 'aparat'];
const ALLOWED_PLATFORMS = [...Object.keys(PLATFORMS), 'custom'];

function normalizeAllowedPlatforms(value, role = 'user') {
  const fallback = role === 'admin' ? ALLOWED_PLATFORMS.slice() : DEFAULT_ALLOWED_PLATFORMS.slice();
  const source = Array.isArray(value) && value.length ? value : fallback;
  const platforms = [];
  for (const platform of source) {
    if (!ALLOWED_PLATFORMS.includes(platform) || platforms.includes(platform)) continue;
    platforms.push(platform);
  }
  if (!platforms.includes('restream')) platforms.unshift('restream');
  return platforms;
}

function isPlatformAllowed(user, platform) {
  return normalizeAllowedPlatforms(user && user.allowedPlatforms, user && user.role).includes(platform);
}

function nowIso() {
  return new Date().toISOString();
}

function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function makeDefaultDestinations() {
  return Object.entries(PLATFORMS).map(([platform, def]) => ({
    id: crypto.randomUUID(),
    platform,
    label: def.label,
    serverUrl: def.serverUrl,
    streamKey: '',
    enabled: false,
    compat: false,
    createdAt: nowIso()
  }));
}

function makeUser({ username, displayName, password, role = 'user', status = 'pending', email = '' }) {
  const stamp = nowIso();
  return {
    id: crypto.randomUUID(),
    username,
    usernameLower: username.toLowerCase(),
    displayName: displayName || username,
    email: email || '',
    password: hashPassword(password),
    role,
    status,
    streamKey: randomStreamKey(),
    quotaBytes: null,
    usageBytes: 0,
    usageDownloadBytes: 0,
    usageUploadBytes: 0,
    usageDaily: {},
    usageByPlatform: {},
    allowedPlatforms: role === 'admin' ? ALLOWED_PLATFORMS.slice() : DEFAULT_ALLOWED_PLATFORMS.slice(),
    destinations: makeDefaultDestinations(),
    createdAt: stamp,
    approvedAt: status === 'approved' ? stamp : null,
    rejectedAt: null,
    lastLoginAt: null,
    lastStreamAt: null,
    liveSince: null,
    quotaBlocked: false,
    note: ''
  };
}

function findUser(db, username) {
  if (!username) return null;
  const needle = String(username).trim().toLowerCase();
  return db.users.find((u) => u.usernameLower === needle) || null;
}

function findUserByKey(db, streamKey) {
  if (!streamKey) return null;
  return db.users.find((u) => u.streamKey === streamKey) || null;
}

function maskSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 10) return text.slice(0, 2) + '•'.repeat(Math.max(3, text.length - 3)) + text.slice(-1);
  return text.slice(0, 6) + '…' + text.slice(-4);
}

function pushEvent(db, event) {
  db.events = db.events || [];
  db.events.unshift({
    id: crypto.randomUUID(),
    at: nowIso(),
    type: event.type || 'info',
    userId: event.userId || null,
    username: event.username || null,
    message: event.message || ''
  });
  if (db.events.length > 400) db.events.length = 400;
}

function hydrate(db) {
  db.schema = db.schema || 1;
  db.createdAt = db.createdAt || nowIso();
  db.updatedAt = db.updatedAt || nowIso();
  db.settings = db.settings || {};
  db.settings.siteName = db.settings.siteName || 'Restream 42';
  db.settings.publicHost = db.settings.publicHost || '';
  db.users = Array.isArray(db.users) ? db.users : [];
  db.sessions = Array.isArray(db.sessions) ? db.sessions : [];
  db.events = Array.isArray(db.events) ? db.events : [];

  for (const user of db.users) {
    user.username = String(user.username || '');
    user.usernameLower = String(user.usernameLower || user.username).toLowerCase();
    user.displayName = user.displayName || user.username;
    user.email = user.email || '';
    user.role = user.role === 'admin' ? 'admin' : 'user';
    user.status = ['pending', 'approved', 'rejected'].includes(user.status) ? user.status : 'pending';
    user.usageBytes = Number(user.usageBytes) || 0;
    user.usageDownloadBytes = Number(user.usageDownloadBytes) || 0;
    user.usageUploadBytes = Number(user.usageUploadBytes) || 0;
    user.usageDaily = user.usageDaily && typeof user.usageDaily === 'object' ? user.usageDaily : {};
    user.usageByPlatform = user.usageByPlatform && typeof user.usageByPlatform === 'object' ? user.usageByPlatform : {};
    user.allowedPlatforms = normalizeAllowedPlatforms(user.allowedPlatforms, user.role);
    user.destinations = Array.isArray(user.destinations) ? user.destinations : [];
    user.quotaBytes = user.quotaBytes === null || user.quotaBytes === undefined ? null : Number(user.quotaBytes);
    user.quotaBlocked = Boolean(user.quotaBlocked);
    user.note = user.note || '';
    for (const dest of user.destinations) {
      dest.id = dest.id || crypto.randomUUID();
      dest.platform = PLATFORMS[dest.platform] ? dest.platform : 'custom';
      const platformDefaults = PLATFORMS[dest.platform];
      dest.label = dest.label || (platformDefaults || {}).label || 'Custom';
      // Built-in destinations always use the current platform endpoint.
      // Only Custom RTMP keeps a user-supplied server URL.
      dest.serverUrl = platformDefaults ? platformDefaults.serverUrl : dest.serverUrl || '';
      dest.streamKey = dest.streamKey || '';
      dest.enabled = Boolean(dest.enabled);
      dest.compat = Boolean(dest.compat);
      dest.createdAt = dest.createdAt || nowIso();
      if (!user.allowedPlatforms.includes(dest.platform)) dest.enabled = false;
    }
  }
  return db;
}

class Store {
  constructor(dataDir) {
    this.dir = path.resolve(dataDir || process.env.RESTREAM_DATA || path.join(__dirname, '..', 'data'));
    this.file = path.join(this.dir, 'db.json');
    this.cache = null;
    this.stamp = -1;
    fs.mkdirSync(this.dir, { recursive: true });
    this.read();
  }

  read() {
    let stat = null;
    try {
      stat = fs.statSync(this.file);
    } catch {
      stat = null;
    }

    if (!stat) {
      if (!this.cache) {
        const db = hydrate(this.seed());
        this.write(db);
        return this.cache;
      }
      return this.cache;
    }

    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (this.cache && stamp === this.stamp) return this.cache;

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      throw new Error(`فایل داده خراب است (${this.file}): ${err.message}`);
    }
    this.cache = hydrate(parsed);
    this.stamp = stamp;
    return this.cache;
  }

  write(db) {
    db.updatedAt = nowIso();
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    const stat = fs.statSync(this.file);
    this.stamp = `${stat.mtimeMs}:${stat.size}`;
    this.cache = db;
  }

  mutate(fn) {
    const db = this.read();
    const result = fn(db);
    this.write(db);
    return result;
  }

  seed() {
    const username = (process.env.RESTREAM_ADMIN_USER || 'admin').trim();
    const password = process.env.RESTREAM_ADMIN_PASSWORD || randomPassword(12);
    const admin = makeUser({
      username,
      displayName: 'مدیر سیستم',
      password,
      role: 'admin',
      status: 'approved'
    });

    const db = {
      schema: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      settings: {
        siteName: 'Restream 42',
        publicHost: ''
      },
      users: [admin],
      sessions: [],
      events: []
    };
    pushEvent(db, {
      type: 'system',
      message: `حساب مدیر اولیه ساخته شد: ${username}`
    });

    const secretsFile = path.join(this.dir, 'initial-admin.txt');
    try {
      fs.writeFileSync(
        secretsFile,
        [
          'Restream 42 - initial administrator',
          `username: ${username}`,
          `password: ${password}`,
          '',
          'After signing in, change this password from the dashboard or CLI.',
          'Delete this file once you have saved the password.'
        ].join('\n'),
        'utf8'
      );
    } catch {
      /* the log below is still enough to recover */
    }

    console.log('──────────────────────────────────────────────');
    console.log('  Restream 42: initial administrator created');
    console.log(`  username: ${username}`);
    console.log(`  password: ${password}`);
    console.log(`  saved to: ${secretsFile}`);
    console.log('──────────────────────────────────────────────');
    return db;
  }
}

module.exports = {
  PLATFORMS,
  ALLOWED_PLATFORMS,
  DEFAULT_ALLOWED_PLATFORMS,
  normalizeAllowedPlatforms,
  isPlatformAllowed,
  Store,
  hydrate,
  makeUser,
  makeDefaultDestinations,
  findUser,
  findUserByKey,
  maskSecret,
  pushEvent,
  nowIso,
  todayKey
};

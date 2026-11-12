'use strict';

const path = require('node:path');
const express = require('express');
const {
  Store,
  PLATFORMS,
  ALLOWED_PLATFORMS,
  normalizeAllowedPlatforms,
  isPlatformAllowed,
  findUser,
  findUserByKey,
  pushEvent,
  todayKey,
  maskSecret
} = require('./db');
const { verifyPassword, hashPassword, randomStreamKey } = require('./security');
const {
  attachUser,
  setSessionCookie,
  clearSessionCookie,
  createSession,
  destroySession,
  requireAuth,
  requireAdmin
} = require('./auth');
const { RelayManager, isRtmpUrl, destinationUrl, aparatTarget } = require('./relays');
const { IngestServer } = require('./ingest');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_DAYS = 7;

function wrap(handler) {
  return (req, res, next) => {
    try {
      const out = handler(req, res, next);
      if (out && typeof out.catch === 'function') out.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

function clientUser(user, { includeSecrets = true, allowedOnly = false } = {}) {
  const allowedPlatforms = normalizeAllowedPlatforms(user.allowedPlatforms, user.role);
  const destinations = (user.destinations || [])
    .filter((dest) => !allowedOnly || allowedPlatforms.includes(dest.platform))
    .map((dest) => ({
      id: dest.id,
      platform: dest.platform,
      label: dest.label,
      serverUrl: dest.serverUrl,
      streamKey: includeSecrets ? dest.streamKey : maskSecret(dest.streamKey),
      enabled: Boolean(dest.enabled),
      compat: Boolean(dest.compat),
      createdAt: dest.createdAt
    }));

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    role: user.role,
    status: user.status,
    streamKey: includeSecrets ? user.streamKey : maskSecret(user.streamKey),
    quotaBytes: user.quotaBytes,
    quotaBlocked: Boolean(user.quotaBlocked),
    usageBytes: user.usageBytes || 0,
    usageDownloadBytes: user.usageDownloadBytes || 0,
    usageUploadBytes: user.usageUploadBytes || 0,
    usageDaily: user.usageDaily || {},
    usageByPlatform: user.usageByPlatform || {},
    allowedPlatforms,
    createdAt: user.createdAt,
    approvedAt: user.approvedAt,
    lastLoginAt: user.lastLoginAt,
    lastStreamAt: user.lastStreamAt,
    liveSince: user.liveSince,
    note: user.note || '',
    destinations
  };
}

function usageSeries(user, days = 14) {
  const out = [];
  const cursor = new Date();
  cursor.setHours(12, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(cursor);
    d.setDate(d.getDate() - i);
    const key = todayKey(d);
    out.push({ date: key, bytes: Number((user.usageDaily || {})[key] || 0) });
  }
  return out;
}

function normalizeHost(req, db) {
  const configured = String((db.settings || {}).publicHost || '').trim();
  if (configured) return configured.replace(/^rtmps?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  let host = String(req.hostname || 'localhost');
  if (host === '::1' || host === '[::1]') host = '127.0.0.1';
  return host;
}

function ingestInfo(req, db, ingest) {
  const host = normalizeHost(req, db);
  return {
    host,
    rtmpPort: ingest.port,
    requestedPort: ingest.requestedPort,
    fallback: ingest.port !== ingest.requestedPort,
    app: ingest.app,
    running: ingest.running,
    publishBase: `rtmp://${host}:${ingest.port}/${ingest.app}`
  };
}

function validUsername(value) {
  return /^[a-zA-Z0-9_.-]{3,24}$/.test(value);
}

function sanitizeText(value, max = 200) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

function formatQuota(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} گیگابایت`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} مگابایت`;
  return `${Math.max(1, Math.round(bytes / 1000))} کیلوبایت`;
}

function validateDestinationInput(platform, serverUrl, streamKey) {
  if (platform === 'aparat') {
    if (serverUrl && !isRtmpUrl(serverUrl)) return 'آدرس سرور آپارات باید با rtmp:// یا rtmps:// شروع شود.';
    if (streamKey && /^[a-z][a-z0-9+.-]*:\/\//i.test(streamKey) && !isRtmpUrl(streamKey)) {
      return 'لینک Push آپارات باید با rtmp:// یا rtmps:// شروع شود.';
    }
    if (!aparatTarget(serverUrl, streamKey)) {
      return 'کلید پخش آپارات را وارد کنید؛ اگر لینک کامل Push دارید، همان را در فیلد کلید بگذارید.';
    }
    return '';
  }
  if (serverUrl && !isRtmpUrl(serverUrl)) return 'آدرس سرور باید با rtmp:// یا rtmps:// شروع شود.';
  if (!serverUrl && !streamKey) return 'آدرس سرور و کلید پخش را کامل کنید.';
  return '';
}

async function startServer(options = {}) {
  const envPort = Number(process.env.PORT);
  const port = Number(
    options.port || (Number.isFinite(envPort) && envPort > 0 ? envPort : 0) || 9998
  );
  const dataDir = options.dataDir || process.env.RESTREAM_DATA || path.join(__dirname, '..', 'data');
  const store = new Store(dataDir);
  const logger = options.logger || console.log;

  let ingest;
  const manager = new RelayManager({
    store,
    ingestUrl: (user) => `rtmp://127.0.0.1:${ingest.port}/${ingest.app}/${user.streamKey}`,
    log: logger,
    onQuotaExceeded: (userId, sessionId) => {
      if (sessionId) ingest?.kick(sessionId);
    }
  });

  const authorize = (streamKey) => {
    const db = store.read();
    const user = findUserByKey(db, streamKey);
    if (!user) return { ok: false, reason: 'unknown stream key' };
    if (user.status !== 'approved') return { ok: false, reason: 'account is not approved' };
    if (user.quotaBlocked) return { ok: false, reason: 'usage quota exceeded' };
    return { ok: true, user };
  };

  ingest = new IngestServer({
    port: Number(process.env.RTMP_PORT || options.rtmpPort || 1935),
    app: process.env.RTMP_APP || 'live',
    logger,
    authorize,
    published: (streamKey, sessionId, session) => {
      const user = findUserByKey(store.read(), streamKey);
      if (user) manager.onPublish(user, sessionId, session);
    },
    unpublished: (streamKey) => manager.onUnpublishByKey(streamKey)
  });
  await ingest.start();

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'self'; base-uri 'self'"
    );
    next();
  });

  app.use(express.json({ limit: '96kb' }));
  app.use(attachUser(store));

  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin) return next();
    try {
      if (new URL(origin).host !== req.headers.host) {
        return res.status(403).json({ error: 'درخواست از مبدا نامعتبر رد شد.' });
      }
    } catch {
      return res.status(403).json({ error: 'درخواست از مبدا نامعتبر رد شد.' });
    }
    return next();
  });

  const attempts = new Map();
  const limitAuth = (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let bucket = attempts.get(key);
    if (!bucket || bucket.reset < now) {
      bucket = { count: 0, reset: now + 10 * 60 * 1000 };
      attempts.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > 40) {
      return res.status(429).json({ error: 'تلاش‌های زیاد؛ چند دقیقه بعد دوباره امتحان کنید.' });
    }
    return next();
  };

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      now: new Date().toISOString(),
      ingest: { port: ingest.port, running: ingest.running },
      live: manager.live.size,
      relays: manager.jobs.size
    });
  });

  app.get('/api/me', (req, res) => {
    if (!req.user) return res.json({ user: null, ingest: ingestInfo(req, req.db, ingest) });
    return res.json({
      user: clientUser(req.user, { allowedOnly: true }),
      ingest: ingestInfo(req, req.db, ingest),
      live: manager.isLive(req.user.id)
    });
  });

  app.post('/api/register', limitAuth, wrap((req, res) => {
    const body = req.body || {};
    const username = sanitizeText(body.username, 24);
    const displayName = sanitizeText(body.displayName, 40) || username;
    const email = sanitizeText(body.email, 120);
    const password = String(body.password || '');

    if (!validUsername(username)) {
      return res.status(400).json({ error: 'نام کاربری باید ۳ تا ۲۴ کاراکتر و شامل حروف انگلیسی، عدد، نقطه، خط تیره یا زیرخط باشد.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'رمز عبور باید حداقل ۶ کاراکتر باشد.' });
    }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'ایمیل معتبر نیست.' });
    }

    const db = store.read();
    if (username.toLowerCase() === 'admin' || findUser(db, username)) {
      return res.status(409).json({ error: 'این نام کاربری قبلاً گرفته شده است.' });
    }

    const user = {
      id: require('node:crypto').randomUUID(),
      username,
      usernameLower: username.toLowerCase(),
      displayName,
      email,
      password: hashPassword(password),
      role: 'user',
      status: 'pending',
      streamKey: randomStreamKey(),
      quotaBytes: null,
      usageBytes: 0,
      usageDownloadBytes: 0,
      usageUploadBytes: 0,
      usageDaily: {},
      usageByPlatform: {},
      allowedPlatforms: normalizeAllowedPlatforms([], 'user'),
      destinations: require('./db').makeDefaultDestinations(),
      createdAt: new Date().toISOString(),
      approvedAt: null,
      rejectedAt: null,
      lastLoginAt: null,
      lastStreamAt: null,
      liveSince: null,
      quotaBlocked: false,
      note: ''
    };

    db.users.push(user);
    pushEvent(db, {
      type: 'user',
      userId: user.id,
      username: user.username,
      message: 'حساب جدید ثبت‌نام شد و در انتظار تأیید است.'
    });
    store.write(db);

    const token = createSession(store, user.id, req);
    setSessionCookie(res, token, req);
    return res.status(201).json({
      user: clientUser(user),
      redirect: '/app',
      message: 'حساب ساخته شد؛ پس از تأیید مدیر می‌توانید پخش را فعال کنید.'
    });
  }));

  app.post('/api/login', limitAuth, wrap((req, res) => {
    const body = req.body || {};
    const username = sanitizeText(body.username, 64);
    const password = String(body.password || '');
    const db = store.read();
    const user = findUser(db, username);

    if (!user || !verifyPassword(password, user.password)) {
      return res.status(401).json({ error: 'نام کاربری یا رمز عبور نادرست است.' });
    }
    if (user.status === 'rejected') {
      return res.status(403).json({ error: 'دسترسی این حساب توسط مدیر رد شده است.' });
    }

    user.lastLoginAt = new Date().toISOString();
    store.write(db);
    const token = createSession(store, user.id, req);
    setSessionCookie(res, token, req);
    return res.json({
      user: clientUser(user),
      redirect: user.role === 'admin' ? '/admin' : '/app'
    });
  }));

  app.post('/api/logout', wrap((req, res) => {
    if (req.user) destroySession(store, req);
    clearSessionCookie(res);
    res.json({ ok: true });
  }));

  app.patch('/api/profile', requireAuth, wrap((req, res) => {
    const body = req.body || {};
    const displayName = sanitizeText(body.displayName, 40);
    const email = sanitizeText(body.email, 120);
    if (displayName.length < 2) return res.status(400).json({ error: 'نام نمایشی کوتاه است.' });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'ایمیل معتبر نیست.' });
    }
    store.mutate((db) => {
      const user = db.users.find((u) => u.id === req.user.id);
      if (!user) return;
      user.displayName = displayName;
      user.email = email;
      if (body.currentPassword && body.newPassword) {
        if (!verifyPassword(String(body.currentPassword), user.password)) {
          throw Object.assign(new Error('رمز عبور فعلی نادرست است.'), { status: 400 });
        }
        if (String(body.newPassword).length < 6) {
          throw Object.assign(new Error('رمز جدید باید حداقل ۶ کاراکتر باشد.'), { status: 400 });
        }
        user.password = hashPassword(String(body.newPassword));
      }
    });
    return res.json({ ok: true, user: clientUser(store.read().users.find((u) => u.id === req.user.id)) });
  }));

  app.get('/api/dashboard', requireAuth, wrap((req, res) => {
    const user = req.db.users.find((u) => u.id === req.user.id);
    if (!user) return res.status(401).json({ error: 'حساب پیدا نشد.' });
    const info = ingestInfo(req, req.db, ingest);

    const allowedPlatforms = normalizeAllowedPlatforms(user.allowedPlatforms, user.role);
    return res.json({
      user: clientUser(user, { allowedOnly: true }),
      ingest: info,
      live: manager.isLive(user.id),
      relays: manager.userSnapshot(user.id),
      events: (req.db.events || []).filter((e) => e.userId === user.id).slice(0, 24),
      series: usageSeries(user),
      platforms: Object.fromEntries(Object.entries(PLATFORMS).filter(([platform]) => allowedPlatforms.includes(platform))),
      quota: {
        bytes: user.quotaBytes,
        used: user.usageBytes || 0,
        blocked: Boolean(user.quotaBlocked)
      }
    });
  }));

  app.post('/api/stream/rotate', requireAuth, wrap((req, res) => {
    if (manager.isLive(req.user.id)) {
      return res.status(409).json({ error: 'برای ساخت کلید جدید ابتدا پخش را متوقف کنید.' });
    }
    const newKey = randomStreamKey();
    store.mutate((db) => {
      const user = db.users.find((u) => u.id === req.user.id);
      if (user) user.streamKey = newKey;
      pushEvent(db, {
        type: 'stream',
        userId: req.user.id,
        username: req.user.username,
        message: 'کلید پخش کاربر بازنشانی شد.'
      });
    });
    manager.stopUser(req.user.id, 'rotate');
    return res.json({ ok: true, streamKey: newKey });
  }));

  app.put('/api/destinations/:id', requireAuth, wrap((req, res) => {
    const body = req.body || {};
    const dest = (req.user.destinations || []).find((d) => d.id === req.params.id);
    if (!dest) return res.status(404).json({ error: 'مقصد پیدا نشد.' });
    if (!isPlatformAllowed(req.user, dest.platform)) {
      return res.status(403).json({ error: 'دسترسی این مقصد توسط مدیر برای شما فعال نشده است.' });
    }

    const nextServer = body.serverUrl === undefined ? dest.serverUrl : sanitizeText(body.serverUrl, 500);
    const nextKey = body.streamKey === undefined ? dest.streamKey : sanitizeText(body.streamKey, 500);
    if (dest.platform !== 'custom' && nextServer !== dest.serverUrl) {
      return res.status(400).json({ error: 'آدرس سرور این پلتفرم ثابت است و قابل تغییر نیست.' });
    }
    const error = validateDestinationInput(dest.platform, nextServer, nextKey);
    if (error) return res.status(400).json({ error });

    dest.serverUrl = nextServer;
    dest.streamKey = nextKey;
    if (body.label !== undefined) dest.label = sanitizeText(body.label, 40) || dest.label;
    if (body.compat !== undefined) dest.compat = Boolean(body.compat);
    store.write(req.db);
    manager.syncUser(req.user.id);
    return res.json({ ok: true, destination: dest, relays: manager.userSnapshot(req.user.id) });
  }));

  app.post('/api/destinations/:id/toggle', requireAuth, wrap((req, res) => {
    const dest = (req.user.destinations || []).find((d) => d.id === req.params.id);
    if (!dest) return res.status(404).json({ error: 'مقصد پیدا نشد.' });
    if (!isPlatformAllowed(req.user, dest.platform)) {
      return res.status(403).json({ error: 'دسترسی این مقصد توسط مدیر برای شما فعال نشده است.' });
    }
    const enabled = Boolean((req.body || {}).enabled);

    if (enabled) {
      if (req.user.quotaBlocked) return res.status(403).json({ error: 'سهمیه حجم مصرفی شما به پایان رسیده است.' });
      const target = destinationUrl(dest);
      if (!target) return res.status(400).json({ error: 'ابتدا آدرس و کلید این مقصد را کامل کنید.' });
    }

    dest.enabled = enabled;
    store.write(req.db);
    manager.clearSuppression(req.user.id);
    manager.syncUser(req.user.id);
    if (enabled) {
      pushEvent(req.db, {
        type: 'destination',
        userId: req.user.id,
        username: req.user.username,
        message: `مقصد ${dest.label} فعال شد.`
      });
      store.write(req.db);
    }
    return res.json({ ok: true, relays: manager.userSnapshot(req.user.id), live: manager.isLive(req.user.id) });
  }));

  app.post('/api/destinations', requireAuth, wrap((req, res) => {
    if (!isPlatformAllowed(req.user, 'custom')) {
      return res.status(403).json({ error: 'افزودن مقصد RTMP دلخواه توسط مدیر برای شما فعال نشده است.' });
    }
    const body = req.body || {};
    const label = sanitizeText(body.label, 40);
    const serverUrl = sanitizeText(body.serverUrl, 500);
    const streamKey = sanitizeText(body.streamKey, 500);
    if (!label) return res.status(400).json({ error: 'نام مقصد را وارد کنید.' });
    const error = validateDestinationInput('custom', serverUrl, streamKey);
    if (error) return res.status(400).json({ error });

    const dest = {
      id: require('node:crypto').randomUUID(),
      platform: 'custom',
      label,
      serverUrl,
      streamKey,
      enabled: Boolean(body.enabled),
      compat: Boolean(body.compat),
      createdAt: new Date().toISOString()
    };
    req.user.destinations.push(dest);
    store.write(req.db);
    manager.syncUser(req.user.id);
    return res.status(201).json({ ok: true, destination: dest });
  }));

  app.delete('/api/destinations/:id', requireAuth, wrap((req, res) => {
    const index = (req.user.destinations || []).findIndex((d) => d.id === req.params.id);
    if (index < 0) return res.status(404).json({ error: 'مقصد پیدا نشد.' });
    if (req.user.destinations[index].platform !== 'custom') {
      return res.status(400).json({ error: 'مقصدهای پیش‌فرض قابل حذف نیستند؛ فقط آن‌ها را غیرفعال کنید.' });
    }
    req.user.destinations.splice(index, 1);
    store.write(req.db);
    manager.syncUser(req.user.id);
    return res.json({ ok: true });
  }));

  app.get('/api/public/profile/:username', wrap((req, res) => {
    const db = store.read();
    const user = db.users.find(
      (u) => u.usernameLower === String(req.params.username || '').toLowerCase() && u.status === 'approved'
    );
    if (!user) return res.status(404).json({ error: 'پروفایل پیدا نشد.' });
    return res.json({
      profile: {
        username: user.username,
        displayName: user.displayName,
        createdAt: user.createdAt,
        live: manager.isLive(user.id),
        platforms: (user.destinations || [])
          .filter((d) => d.enabled && isPlatformAllowed(user, d.platform))
          .map((d) => d.platform),
        streamCount: user.lastStreamAt ? 1 : 0
      }
    });
  }));

  /* ------------------------------- admin -------------------------------- */

  app.get('/api/admin/overview', requireAdmin, wrap((req, res) => {
    const db = req.db;
    const users = db.users.map((u) => {
      const enabled = (u.destinations || []).filter((d) => d.enabled).length;
      return {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        email: u.email,
        role: u.role,
        status: u.status,
        usageBytes: u.usageBytes || 0,
        usageDownloadBytes: u.usageDownloadBytes || 0,
        usageUploadBytes: u.usageUploadBytes || 0,
        allowedPlatforms: normalizeAllowedPlatforms(u.allowedPlatforms, u.role),
        quotaBytes: u.quotaBytes,
        quotaBlocked: Boolean(u.quotaBlocked),
        createdAt: u.createdAt,
        approvedAt: u.approvedAt,
        lastLoginAt: u.lastLoginAt,
        lastStreamAt: u.lastStreamAt,
        live: manager.isLive(u.id),
        enabledDestinations: enabled,
        destinationCount: (u.destinations || []).length,
        streamKeyMasked: maskSecret(u.streamKey)
      };
    });
    users.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    const usageTotal = users.reduce((sum, u) => sum + u.usageBytes, 0);
    const usageToday = db.users.reduce((sum, u) => sum + Number((u.usageDaily || {})[todayKey()] || 0), 0);

    return res.json({
      stats: {
        users: users.length,
        pending: users.filter((u) => u.status === 'pending').length,
        approved: users.filter((u) => u.status === 'approved').length,
        live: users.filter((u) => u.live).length,
        relays: manager.jobs.size,
        usageTotal,
        usageToday
      },
      users,
      relays: manager.snapshot(),
      events: (db.events || []).slice(0, 80),
      settings: {
        siteName: (db.settings || {}).siteName || 'Restream 42',
        publicHost: (db.settings || {}).publicHost || ''
      },
      ingest: ingestInfo(req, db, ingest)
    });
  }));

  app.get('/api/admin/users/:id', requireAdmin, wrap((req, res) => {
    const db = req.db;
    const user = db.users.find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد.' });
    return res.json({
      user: clientUser(user),
      live: manager.isLive(user.id),
      relays: manager.userSnapshot(user.id),
      events: (db.events || []).filter((e) => e.userId === user.id).slice(0, 40),
      series: usageSeries(user)
    });
  }));

  app.post('/api/admin/users/:id/status', requireAdmin, wrap((req, res) => {
    const status = String((req.body || {}).status || '');
    if (!['approved', 'pending', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'وضعیت نامعتبر است.' });
    }
    const db = req.db;
    const user = db.users.find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد.' });

    user.status = status;
    if (status === 'approved') {
      user.approvedAt = new Date().toISOString();
      user.rejectedAt = null;
    }
    if (status === 'rejected') {
      user.rejectedAt = new Date().toISOString();
      const sessionId = manager.liveSession(user.id);
      manager.stopUser(user.id, 'rejected');
      if (sessionId) ingest.kick(sessionId);
    }
    pushEvent(db, {
      type: 'user',
      userId: user.id,
      username: user.username,
      message:
        status === 'approved'
          ? 'حساب توسط مدیر تأیید شد.'
          : status === 'rejected'
            ? 'حساب توسط مدیر رد شد.'
            : 'حساب به حالت در انتظار تأیید برگشت.'
    });
    store.write(db);
    if (status === 'approved') manager.syncUser(user.id);
    return res.json({ ok: true });
  }));

  app.post('/api/admin/users/:id/platforms', requireAdmin, wrap((req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.platforms)) {
      return res.status(400).json({ error: 'فهرست دسترسی‌ها معتبر نیست.' });
    }
    if (body.platforms.some((platform) => !ALLOWED_PLATFORMS.includes(platform))) {
      return res.status(400).json({ error: 'پلتفرم انتخاب‌شده معتبر نیست.' });
    }
    const db = req.db;
    const user = db.users.find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد.' });

    user.allowedPlatforms = normalizeAllowedPlatforms(body.platforms, user.role);
    for (const dest of user.destinations || []) {
      if (!user.allowedPlatforms.includes(dest.platform)) dest.enabled = false;
    }
    pushEvent(db, {
      type: 'access',
      userId: user.id,
      username: user.username,
      message: `دسترسی پلتفرم‌ها به‌روزرسانی شد: ${user.allowedPlatforms.join(', ')}`
    });
    store.write(db);
    manager.syncUser(user.id);
    return res.json({ ok: true, allowedPlatforms: user.allowedPlatforms });
  }));

  app.post('/api/admin/users/:id/quota', requireAdmin, wrap((req, res) => {
    const body = req.body || {};
    const db = req.db;
    const user = db.users.find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد.' });

    if (Object.prototype.hasOwnProperty.call(body, 'quotaGb')) {
      const raw = body.quotaGb;
      if (raw === null || raw === '' || raw === 'unlimited') {
        user.quotaBytes = null;
      } else {
        const gb = Number(raw);
        if (!Number.isFinite(gb) || gb < 0 || gb > 1000000) {
          return res.status(400).json({ error: 'مقدار سهمیه معتبر نیست.' });
        }
        user.quotaBytes = Math.round(gb * 1e9);
      }
    }
    if (body.resetUsage) {
      user.usageBytes = 0;
      user.usageDownloadBytes = 0;
      user.usageUploadBytes = 0;
      user.usageDaily = {};
      user.usageByPlatform = {};
    }
    user.quotaBlocked = user.quotaBytes !== null && user.usageBytes >= user.quotaBytes;
    pushEvent(db, {
      type: 'quota',
      userId: user.id,
      username: user.username,
      message:
        user.quotaBytes === null
          ? 'سهمیه حجم مصرفی روی نامحدود تنظیم شد.'
          : `سهمیه حجم مصرفی روی ${formatQuota(user.quotaBytes)} تنظیم شد.`
    });
    store.write(db);
    if (user.quotaBlocked) manager.stopUser(user.id, 'quota');
    else manager.syncUser(user.id);
    return res.json({ ok: true });
  }));

  app.post('/api/admin/users/:id/role', requireAdmin, wrap((req, res) => {
    const role = (req.body || {}).role === 'admin' ? 'admin' : 'user';
    const db = req.db;
    const user = db.users.find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد.' });
    if (role === 'user' && user.role === 'admin' && db.users.filter((u) => u.role === 'admin').length <= 1) {
      return res.status(400).json({ error: 'حداقل یک مدیر باید باقی بماند.' });
    }
    user.role = role;
    if (role === 'admin' && user.status !== 'approved') {
      user.status = 'approved';
      user.approvedAt = new Date().toISOString();
    }
    pushEvent(db, {
      type: 'role',
      userId: user.id,
      username: user.username,
      message: role === 'admin' ? 'نقش مدیر به کاربر داده شد.' : 'نقش مدیر از کاربر گرفته شد.'
    });
    store.write(db);
    return res.json({ ok: true });
  }));

  app.post('/api/admin/users/:id/rotate-key', requireAdmin, wrap((req, res) => {
    const db = req.db;
    const user = db.users.find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد.' });
    const sessionId = manager.liveSession(user.id);
    manager.stopUser(user.id, 'rotate');
    if (sessionId) ingest.kick(sessionId);
    user.streamKey = randomStreamKey();
    user.liveSince = null;
    pushEvent(db, {
      type: 'stream',
      userId: user.id,
      username: user.username,
      message: 'کلید پخش توسط مدیر بازنشانی شد.'
    });
    store.write(db);
    return res.json({ ok: true, streamKey: user.streamKey });
  }));

  app.post('/api/admin/users/:id/stop', requireAdmin, wrap((req, res) => {
    const db = req.db;
    const user = db.users.find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد.' });
    const sessionId = manager.liveSession(user.id);
    manager.adminStop(user.id);
    if (sessionId) ingest.kick(sessionId);
    pushEvent(db, {
      type: 'stream',
      userId: user.id,
      username: user.username,
      message: 'پخش کاربر توسط مدیر قطع شد.'
    });
    store.write(db);
    return res.json({ ok: true });
  }));

  app.delete('/api/admin/users/:id', requireAdmin, wrap((req, res) => {
    const db = req.db;
    const index = db.users.findIndex((u) => u.id === req.params.id);
    if (index < 0) return res.status(404).json({ error: 'کاربر پیدا نشد.' });
    const user = db.users[index];
    if (user.role === 'admin' && db.users.filter((u) => u.role === 'admin').length <= 1) {
      return res.status(400).json({ error: 'آخرین مدیر قابل حذف نیست.' });
    }
    const sessionId = manager.liveSession(user.id);
    manager.stopUser(user.id, 'deleted');
    if (sessionId) ingest.kick(sessionId);
    db.sessions = (db.sessions || []).filter((s) => s.userId !== user.id);
    db.users.splice(index, 1);
    pushEvent(db, {
      type: 'user',
      username: user.username,
      message: 'حساب کاربر حذف شد.'
    });
    store.write(db);
    return res.json({ ok: true });
  }));

  app.post('/api/admin/settings', requireAdmin, wrap((req, res) => {
    const body = req.body || {};
    const siteName = sanitizeText(body.siteName, 40);
    let publicHost = sanitizeText(body.publicHost, 120);
    if (publicHost) {
      if (/^https?:\/\//i.test(publicHost) || publicHost.includes('/')) {
        return res.status(400).json({ error: 'دامنه را بدون http:// و بدون مسیر وارد کنید.' });
      }
      publicHost = publicHost.replace(/:\d+$/, '');
    }
    const db = req.db;
    db.settings = db.settings || {};
    if (siteName) db.settings.siteName = siteName;
    db.settings.publicHost = publicHost;
    pushEvent(db, { type: 'system', message: 'تنظیمات عمومی به‌روزرسانی شد.' });
    store.write(db);
    return res.json({ ok: true, settings: { siteName: db.settings.siteName, publicHost: db.settings.publicHost } });
  }));

  /* ------------------------------- pages -------------------------------- */

  app.get(/^\/(?:index|app|admin|u)\.html$/i, (req, res) => res.redirect('/'));
  app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets'), { maxAge: '1h' }));
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));

  app.get('/', (req, res) => {
    if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/app');
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.get('/login', (req, res) => {
    if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/app');
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.get('/app', (req, res) => {
    if (!req.user) return res.redirect('/');
    return res.sendFile(path.join(PUBLIC_DIR, 'app.html'));
  });

  app.get('/admin', (req, res) => {
    if (!req.user) return res.redirect('/');
    if (req.user.role !== 'admin') return res.redirect('/app');
    return res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  });

  app.get('/u/:username', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'u.html')));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'مسیر پیدا نشد.' });
    return res.status(404).send('404');
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || 500;
    if (status >= 500) logger(`[http] ${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
    return res.status(status).json({ error: status >= 500 ? 'خطای داخلی سرور.' : err.message });
  });

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(port, '0.0.0.0', () => resolve(instance));
    instance.once('error', reject);
  });

  logger(`[web] Restream 42 panel: http://localhost:${port}`);
  if (ingest.port !== ingest.requestedPort) {
    logger(`[web] note: RTMP 1935 was busy, using ${ingest.port}. Set RTMP_PORT to change it.`);
  }

  const close = async () => {
    manager.shutdown();
    ingest.stop();
    await new Promise((resolve) => server.close(resolve));
  };

  return { app, server, store, manager, ingest, port, dataDir, close };
}

if (require.main === module) {
  startServer()
    .then(({ close }) => {
      const shutdown = async () => {
        try {
          await close();
        } finally {
          process.exit(0);
        }
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error('[fatal]', err.message);
      process.exit(1);
    });
}

module.exports = { startServer, clientUser, usageSeries, SESSION_DAYS };

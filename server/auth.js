'use strict';

const { randomToken, sha256 } = require('./security');

const COOKIE_NAME = 'r42_session';
const SESSION_DAYS = 7;

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isSecure(req) {
  return Boolean(req.secure || req.headers['x-forwarded-proto'] === 'https');
}

function setSessionCookie(res, token, req) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`
  ];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function createSession(store, userId, req) {
  const token = randomToken(32);
  const now = Date.now();
  store.mutate((db) => {
    db.sessions = (db.sessions || []).filter((s) => new Date(s.expiresAt).getTime() > now);
    db.sessions.push({
      tokenHash: sha256(token),
      userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      ip: req.ip || '',
      userAgent: String(req.headers['user-agent'] || '').slice(0, 180)
    });
  });
  return token;
}

function readSession(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  const tokenHash = sha256(token);
  const session = (db.sessions || []).find((s) => s.tokenHash === tokenHash);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
  const user = db.users.find((u) => u.id === session.userId);
  if (!user) return null;
  return { user, session };
}

function destroySession(store, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return;
  const tokenHash = sha256(token);
  store.mutate((db) => {
    db.sessions = (db.sessions || []).filter((s) => s.tokenHash !== tokenHash);
  });
}

function attachUser(store) {
  return (req, res, next) => {
    req.db = store.read();
    const found = readSession(req.db, req);
    req.user = found ? found.user : null;
    req.session = found ? found.session : null;
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'برای ادامه باید وارد حساب شوید.' });
  return next();
}

function requireApproved(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'برای ادامه باید وارد حساب شوید.' });
  if (req.user.status !== 'approved') {
    return res.status(403).json({ error: 'حساب شما هنوز توسط مدیر تأیید نشده است.' });
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'برای ادامه باید وارد حساب شوید.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'دسترسی مدیر لازم است.' });
  return next();
}

module.exports = {
  COOKIE_NAME,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  createSession,
  readSession,
  destroySession,
  attachUser,
  requireAuth,
  requireApproved,
  requireAdmin
};

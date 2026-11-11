'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { pushEvent, todayKey, isPlatformAllowed } = require('./db');

const FLUSH_MS = 2000;
const RESTART_BASE_MS = 3000;
const RESTART_MAX_MS = 15000;
const APARAT_SCRIPT = path.join(__dirname, '..', 'aparat_push.py');
const APARAT_EVENT = 'rtmp://rtmp.cdn.asset.aparat.com:443/event';

function isRtmpUrl(value) {
  return /^rtmps?:\/\/\S+$/i.test(String(value || '').trim());
}

/** Aparat shows a fixed event endpoint plus a stream key; accept either that
 * pair or a ready-made push URL (pasted into either field). */
function aparatTarget(serverUrl, streamKey) {
  const server = String(serverUrl || '').trim();
  const key = String(streamKey || '').trim();
  if (isRtmpUrl(key)) return key;
  const base = isRtmpUrl(server) ? server.replace(/\/+$/, '') : '';
  if (/\/event$/i.test(base)) {
    return key ? `${base}/${key.replace(/^\/+/, '')}` : '';
  }
  if (base) return base;
  return key ? `${APARAT_EVENT}/${key.replace(/^\/+/, '')}` : '';
}

function destinationUrl(dest) {
  if (!dest) return '';
  const server = String(dest.serverUrl || '').trim();
  const key = String(dest.streamKey || '').trim();
  if (dest.platform === 'aparat') return aparatTarget(server, key);
  if (!server) return '';
  if (!key) return isRtmpUrl(server) ? server : '';
  const base = server.replace(/\/+$/, '');
  return isRtmpUrl(base) ? `${base}/${key.replace(/^\/+/, '')}` : '';
}

function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      }).on('error', () => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      });
    } catch {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, 4000).unref?.();
}

class RelayManager {
  constructor({ store, ingestUrl, log = console.log, onQuotaExceeded }) {
    this.store = store;
    this.ingestUrl = ingestUrl;
    this.log = log;
    this.onQuotaExceeded = onQuotaExceeded;
    this.jobs = new Map();
    this.live = new Map();
    this.ingestSessions = new Map();
    this.suppressed = new Set();
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  user(userId) {
    return this.store.read().users.find((u) => u.id === userId) || null;
  }

  isLive(userId) {
    return this.live.has(userId);
  }

  liveSession(userId) {
    return this.live.get(userId)?.sessionId || null;
  }

  onPublish(user, sessionId, session) {
    this.live.set(user.id, {
      streamKey: user.streamKey,
      sessionId,
      startedAt: new Date().toISOString()
    });
    this.trackIngest(user.id, sessionId, session);
    this.suppressed.delete(user.id);
    this.log(`[ingest] ${user.username} is publishing`);
    this.store.mutate((db) => {
      const dbUser = db.users.find((u) => u.id === user.id);
      if (dbUser) {
        dbUser.liveSince = new Date().toISOString();
        dbUser.lastStreamAt = new Date().toISOString();
      }
      pushEvent(db, {
        type: 'stream',
        userId: user.id,
        username: user.username,
        message: 'پخش زنده آغاز شد.'
      });
    });
    this.syncUser(user.id);
  }

  onUnpublishByKey(streamKey) {
    for (const [userId, info] of Array.from(this.live.entries())) {
      if (info.streamKey !== streamKey) continue;
      this.captureIngest(userId);
      this.flush();
      this.ingestSessions.delete(userId);
      this.live.delete(userId);
      const user = this.user(userId);
      this.store.mutate((db) => {
        const dbUser = db.users.find((u) => u.id === userId);
        if (dbUser) dbUser.liveSince = null;
        pushEvent(db, {
          type: 'stream',
          userId,
          username: user ? user.username : null,
          message: 'پخش زنده پایان یافت.'
        });
      });
      this.stopUser(userId, 'offline');
    }
  }

  /** Reconcile the desired state of every destination with running jobs. */
  syncUser(userId) {
    const user = this.user(userId);
    if (!user) {
      this.stopUser(userId, 'deleted');
      return;
    }
    const live = this.live.has(userId);
    const allowed =
      live &&
      user.status === 'approved' &&
      !user.quotaBlocked &&
      !this.suppressed.has(userId);

    const keepIds = new Set();
    for (const dest of user.destinations || []) {
      keepIds.add(dest.id);
      const target = destinationUrl(dest);
      const desired = allowed && dest.enabled && isPlatformAllowed(user, dest.platform) && Boolean(target);
      const job = this.jobs.get(dest.id);

      if (!desired) {
        if (job) this.stopJob(job);
        continue;
      }

      if (!job) {
        const created = this.createJob(user, dest, target);
        this.jobs.set(dest.id, created);
        this.launch(created);
        continue;
      }

      if (job.target !== target || job.compat !== Boolean(dest.compat)) {
        this.stopJob(job);
        const recreated = this.createJob(user, dest, target);
        this.jobs.set(dest.id, recreated);
        this.launch(recreated);
      }
    }

    for (const [destId, job] of Array.from(this.jobs.entries())) {
      if (!keepIds.has(destId)) this.stopJob(job);
    }
  }

  createJob(user, dest, target) {
    return {
      destId: dest.id,
      userId: user.id,
      username: user.username,
      platform: dest.platform,
      label: dest.label,
      target,
      compat: Boolean(dest.compat),
      status: 'starting',
      proc: null,
      pid: null,
      startedAt: new Date().toISOString(),
      restarts: 0,
      pendingBytes: 0,
      sessionBytes: 0,
      bitrateKbps: 0,
      outTimeMs: 0,
      lastSize: 0,
      lastError: '',
      stderr: [],
      buffer: '',
      timer: null,
      stopped: false
    };
  }

  launch(job) {
    const user = this.user(job.userId);
    if (!user) {
      this.dropJob(job);
      return;
    }
    const dest = (user.destinations || []).find((d) => d.id === job.destId);
    const target = destinationUrl(dest);
    const allowed =
      this.live.has(user.id) &&
      user.status === 'approved' &&
      !user.quotaBlocked &&
      !this.suppressed.has(user.id) &&
      dest &&
      dest.enabled &&
      isPlatformAllowed(user, dest.platform) &&
      Boolean(target);

    if (!allowed) {
      this.dropJob(job);
      return;
    }

    job.target = target;
    job.compat = Boolean(dest.compat);
    job.status = 'starting';
    job.stopped = false;
    job.restarts = job.restarts || 0;
    job.lastSize = 0;
    job.lastError = '';
    job.buffer = '';
    job.bitrateKbps = 0;

    const input = this.ingestUrl(user);
    let command;
    let args;

    if (dest.platform === 'aparat') {
      command = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
      args = ['-u', APARAT_SCRIPT, '--input', input, '--output', target];
      if (dest.compat) args.push('--audio-aac');
    } else {
      command = process.env.FFMPEG_PATH || 'ffmpeg';
      args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-nostdin',
        '-progress', 'pipe:1',
        '-stats_period', '1',
        '-rtmp_live', 'live',
        '-i', input,
        '-c', 'copy'
      ];
      if (dest.compat) args.push('-c:a', 'aac', '-b:a', '160k');
      args.push('-flvflags', 'no_duration_filesize', '-f', 'flv', target);
    }

    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      job.lastError = err.message;
      job.status = 'reconnecting';
      this.scheduleRestart(job);
      return;
    }

    job.proc = child;
    job.pid = child.pid || null;
    job.startedAt = new Date().toISOString();

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.onStdout(job, child, chunk));
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => this.onStderr(job, child, chunk));
    }
    child.on('error', (err) => {
      job.lastError = err.message;
      this.onExit(job, child, -1, null);
    });
    child.on('exit', (code, signal) => this.onExit(job, child, code, signal));
  }

  onStdout(job, child, chunk) {
    if (job.proc !== child) return;
    job.buffer += chunk;
    const lines = job.buffer.split(/\r?\n/);
    job.buffer = lines.pop() || '';

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      if (line.startsWith('USAGE ')) {
        const bytes = Number(line.slice(6));
        if (Number.isFinite(bytes) && bytes > 0) this.addBytes(job, bytes);
        continue;
      }
      if (line.startsWith('BITRATE ')) {
        const kbps = Number(line.slice(8));
        if (Number.isFinite(kbps)) job.bitrateKbps = Math.round(kbps);
        continue;
      }
      if (line.startsWith('STATE ')) {
        const state = line.slice(6).trim();
        if (state === 'running') job.status = 'running';
        else if (state === 'starting') job.status = 'starting';
        else if (state === 'reconnecting') job.status = 'reconnecting';
        else if (state === 'stopped') job.status = 'stopped';
        continue;
      }
      if (line.startsWith('LOG ')) {
        this.noteStderr(job, line.slice(4));
        continue;
      }

      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1).trim();

      if (key === 'total_size' && value !== 'N/A') {
        const size = Number(value);
        if (Number.isFinite(size) && size >= 0) {
          if (size >= job.lastSize) this.addBytes(job, size - job.lastSize);
          job.lastSize = size;
          if (job.status === 'starting' && size > 0) job.status = 'running';
        }
      } else if (key === 'bitrate') {
        const match = /([\d.]+)\s*kbits\/s/.exec(value);
        if (match) job.bitrateKbps = Math.round(Number(match[1]));
      } else if (key === 'out_time_us') {
        const micros = Number(value);
        if (Number.isFinite(micros)) job.outTimeMs = Math.round(micros / 1000);
      }
    }
  }

  onStderr(job, child, chunk) {
    if (job.proc !== child) return;
    for (const raw of chunk.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      this.noteStderr(job, line);
    }
  }

  noteStderr(job, line) {
    const clean = String(line).slice(0, 400);
    job.stderr.push(clean);
    if (job.stderr.length > 40) job.stderr.shift();
    if (/connection refused|server error|broken pipe|connection reset|i\/o error|error opening|operation not permitted|conversion failed|401 unauthorized|403 forbidden|failed to connect|could not connect/i.test(clean)) {
      job.lastError = clean;
    }
  }

  addBytes(job, bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    job.pendingBytes += bytes;
    job.sessionBytes += bytes;
    if (job.status === 'starting') job.status = 'running';
  }

  trackIngest(userId, sessionId, session) {
    const socket = session && session.socket;
    if (!socket) return;
    const bytesRead = Number(socket.bytesRead);
    if (!Number.isFinite(bytesRead)) return;
    this.ingestSessions.set(userId, {
      sessionId,
      socket,
      lastBytes: bytesRead,
      pendingBytes: 0
    });
  }

  captureIngest(userId) {
    const entry = this.ingestSessions.get(userId);
    if (!entry) return 0;
    const current = Number(entry.socket && entry.socket.bytesRead);
    let delta = Number.isFinite(current) ? current - entry.lastBytes : 0;
    if (delta < 0) delta = 0;
    if (Number.isFinite(current)) entry.lastBytes = current;
    entry.pendingBytes += delta;
    return delta;
  }

  onExit(job, child, code, signal) {
    if (job.proc !== child) return;
    job.proc = null;
    job.pid = null;
    job.bitrateKbps = 0;

    if (job.stopped) {
      job.status = 'stopped';
      return;
    }

    if (this.shouldKeep(job)) {
      job.lastError =
        job.lastError || `ffmpeg exited (code ${code === undefined ? '?' : code}${signal ? `, ${signal}` : ''})`;
      job.status = 'reconnecting';
      this.scheduleRestart(job);
    } else {
      job.status = 'stopped';
      this.jobs.delete(job.destId);
    }
  }

  scheduleRestart(job) {
    if (job.timer) return;
    job.restarts += 1;
    const delay = Math.min(RESTART_BASE_MS + (job.restarts - 1) * 1500, RESTART_MAX_MS);
    job.timer = setTimeout(() => {
      job.timer = null;
      this.launch(job);
    }, delay);
    job.timer.unref?.();
  }

  shouldKeep(job) {
    const user = this.user(job.userId);
    if (!user || !this.live.has(user.id) || user.status !== 'approved' || user.quotaBlocked) return false;
    if (this.suppressed.has(user.id)) return false;
    const dest = (user.destinations || []).find((d) => d.id === job.destId);
    return Boolean(dest && dest.enabled && isPlatformAllowed(user, dest.platform) && destinationUrl(dest));
  }

  stopJob(job) {
    if (!job) return;
    job.stopped = true;
    job.status = 'stopped';
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    const child = job.proc;
    job.proc = null;
    job.pid = null;
    this.jobs.delete(job.destId);
    if (child) killTree(child);
  }

  dropJob(job) {
    job.stopped = true;
    job.status = 'stopped';
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    job.proc = null;
    job.pid = null;
    this.jobs.delete(job.destId);
  }

  stopUser(userId, reason = 'stopped') {
    for (const job of Array.from(this.jobs.values())) {
      if (job.userId === userId) this.stopJob(job);
    }
    if (reason === 'offline') this.live.delete(userId);
  }

  adminStop(userId) {
    this.suppressed.add(userId);
    this.stopUser(userId, 'admin');
  }

  clearSuppression(userId) {
    this.suppressed.delete(userId);
  }

  statusForDest(destId) {
    const job = this.jobs.get(destId);
    if (!job) return null;
    return {
      destId: job.destId,
      status: job.status,
      bitrateKbps: job.bitrateKbps,
      bytesSession: job.sessionBytes,
      restarts: job.restarts,
      startedAt: job.startedAt,
      error: job.lastError || ''
    };
  }

  userSnapshot(userId) {
    return Array.from(this.jobs.values())
      .filter((job) => job.userId === userId)
      .map((job) => ({
        destId: job.destId,
        platform: job.platform,
        label: job.label,
        status: job.status,
        bitrateKbps: job.bitrateKbps,
        bytesSession: job.sessionBytes,
        restarts: job.restarts,
        startedAt: job.startedAt,
        pid: job.pid,
        error: job.lastError || ''
      }));
  }

  snapshot() {
    return Array.from(this.jobs.values()).map((job) => ({
      destId: job.destId,
      userId: job.userId,
      username: job.username,
      platform: job.platform,
      label: job.label,
      targetHost: (() => {
        try {
          return new URL(job.target.replace(/^rtmps:/, 'https:')).host;
        } catch {
          return '';
        }
      })(),
      status: job.status,
      bitrateKbps: job.bitrateKbps,
      bytesSession: job.sessionBytes,
      restarts: job.restarts,
      startedAt: job.startedAt,
      pid: job.pid,
      error: job.lastError || ''
    }));
  }

  flush() {
    for (const userId of this.ingestSessions.keys()) this.captureIngest(userId);

    const perUser = new Map();
    for (const job of this.jobs.values()) {
      if (job.pendingBytes <= 0) continue;
      let entry = perUser.get(job.userId);
      if (!entry) {
        entry = { total: 0, download: 0, upload: 0, platforms: {} };
        perUser.set(job.userId, entry);
      }
      entry.upload += job.pendingBytes;
      entry.platforms[job.platform] = (entry.platforms[job.platform] || 0) + job.pendingBytes;
    }

    for (const [userId, ingest] of this.ingestSessions) {
      if (ingest.pendingBytes <= 0) continue;
      let entry = perUser.get(userId);
      if (!entry) {
        entry = { total: 0, download: 0, upload: 0, platforms: {} };
        perUser.set(userId, entry);
      }
      entry.download += ingest.pendingBytes;
    }

    for (const entry of perUser.values()) entry.total = entry.download + entry.upload;
    if (!perUser.size) return;

    const db = this.store.read();
    const today = todayKey();
    const exceeded = [];

    for (const [userId, entry] of perUser) {
      const user = db.users.find((u) => u.id === userId);
      if (!user) continue;
      user.usageBytes = (Number(user.usageBytes) || 0) + entry.total;
      user.usageDownloadBytes = (Number(user.usageDownloadBytes) || 0) + entry.download;
      user.usageUploadBytes = (Number(user.usageUploadBytes) || 0) + entry.upload;
      user.usageDaily = user.usageDaily || {};
      user.usageDaily[today] = (Number(user.usageDaily[today]) || 0) + entry.total;
      user.usageByPlatform = user.usageByPlatform || {};
      for (const [platform, bytes] of Object.entries(entry.platforms)) {
        user.usageByPlatform[platform] = (Number(user.usageByPlatform[platform]) || 0) + bytes;
      }
      user.lastUsageAt = new Date().toISOString();

      if (user.quotaBytes !== null && user.quotaBytes !== undefined && !user.quotaBlocked) {
        if (user.usageBytes >= Number(user.quotaBytes)) {
          user.quotaBlocked = true;
          exceeded.push(user.id);
          pushEvent(db, {
            type: 'quota',
            userId: user.id,
            username: user.username,
            message: 'سهمیه حجم مصرفی به پایان رسید و پخش متوقف شد.'
          });
        }
      }
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 45);
    const cutoffKey = todayKey(cutoff);
    for (const user of db.users) {
      for (const day of Object.keys(user.usageDaily || {})) {
        if (day < cutoffKey) delete user.usageDaily[day];
      }
    }

    this.store.write(db);
    for (const job of this.jobs.values()) job.pendingBytes = 0;
    for (const ingest of this.ingestSessions.values()) ingest.pendingBytes = 0;

    for (const userId of exceeded) {
      const sessionId = this.live.get(userId)?.sessionId || null;
      this.log(`[quota] user ${userId} hit the usage limit`);
      this.stopUser(userId, 'quota');
      this.onQuotaExceeded?.(userId, sessionId);
    }
  }

  shutdown() {
    clearInterval(this.timer);
    for (const job of Array.from(this.jobs.values())) this.stopJob(job);
    this.live.clear();
  }
}

module.exports = { RelayManager, destinationUrl, isRtmpUrl, aparatTarget, APARAT_EVENT };

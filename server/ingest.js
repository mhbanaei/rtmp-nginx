'use strict';

const net = require('node:net');
const NodeMediaServer = require('node-media-server');

function probePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (free) => {
      if (settled) return;
      settled = true;
      resolve(free);
    };
    server.once('error', () => finish(false));
    server.once('listening', () => {
      server.close(() => finish(true));
    });
    try {
      server.listen(port, '0.0.0.0');
    } catch {
      finish(false);
    }
  });
}

async function pickPort(preferred) {
  for (let port = preferred; port < preferred + 8; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await probePort(port)) return port;
  }
  return null;
}

class IngestServer {
  constructor({ port, app = 'live', logger = console.log, authorize, published, unpublished }) {
    this.requestedPort = Number(port) || 1935;
    this.app = app;
    this.logger = logger;
    this.authorize = authorize;
    this.published = published;
    this.unpublished = unpublished;
    this.port = this.requestedPort;
    this.nms = null;
    this.running = false;
  }

  attach(nms) {
    // Only the local relay engine may read a publisher's stream. Playback from
    // other hosts would expose a private stream without authentication.
    nms.on('prePlay', (id) => {
      try {
        const session = nms.getSession(id);
        const ip = String((session && session.socket && session.socket.remoteAddress) || '');
        const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
        if (!local && session && typeof session.reject === 'function') session.reject();
      } catch {
        /* session already gone */
      }
    });

    nms.on('prePublish', (id, streamPath) => {
      const key = String(streamPath || '').split('/').filter(Boolean).pop() || '';
      const result = this.authorize(key, streamPath);
      if (!result.ok) {
        this.logger(`[ingest] rejected publish for key "${key.slice(0, 10)}…": ${result.reason}`);
        try {
          const session = nms.getSession(id);
          if (session && typeof session.reject === 'function') session.reject();
        } catch {
          /* session already gone */
        }
      }
    });

    nms.on('postPublish', (id, streamPath) => {
      const key = String(streamPath || '').split('/').filter(Boolean).pop() || '';
      try {
        this.published(key, id);
      } catch (err) {
        this.logger(`[ingest] postPublish handler failed: ${err.message}`);
      }
    });

    nms.on('donePublish', (id, streamPath) => {
      const key = String(streamPath || '').split('/').filter(Boolean).pop() || '';
      try {
        this.unpublished(key, id);
      } catch (err) {
        this.logger(`[ingest] donePublish handler failed: ${err.message}`);
      }
    });
  }

  async tryPort(port) {
    const nms = new NodeMediaServer({
      logType: 1,
      rtmp: {
        port,
        chunk_size: 60000,
        gop_cache: true,
        ping: 30,
        ping_timeout: 60
      }
    });
    this.attach(nms);
    this.nms = nms;
    nms.run();

    const tcp = nms.nrs && nms.nrs.tcpServer;
    if (!tcp) {
      this.running = true;
      return true;
    }

    try {
      await new Promise((resolve, reject) => {
        if (tcp.listening) return resolve();
        const timer = setTimeout(() => reject(new Error('RTMP listen timeout')), 6000);
        timer.unref?.();
        tcp.once('listening', () => {
          clearTimeout(timer);
          resolve();
        });
        tcp.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        return undefined;
      });
      this.running = true;
      return true;
    } catch (err) {
      this.logger(`[ingest] cannot listen on port ${port}: ${err.message}`);
      this.running = false;
      try {
        nms.stop();
      } catch {
        /* already stopped */
      }
      return false;
    }
  }

  async start() {
    let candidate = this.requestedPort;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const freePort = await pickPort(candidate);
      if (!freePort) break;
      this.port = freePort;
      // eslint-disable-next-line no-await-in-loop
      if (await this.tryPort(freePort)) {
        if (freePort !== this.requestedPort) {
          this.logger(
            `[ingest] port ${this.requestedPort} is busy; RTMP ingest is running on ${freePort} instead.`
          );
        }
        this.logger(`[ingest] RTMP ingest listening on port ${freePort} (app: ${this.app})`);
        return freePort;
      }
      candidate = freePort + 1;
    }
    throw new Error(`هیچ پورت آزادی برای RTMP در بازه ${this.requestedPort} پیدا نشد.`);
  }

  kick(sessionId) {
    if (!sessionId || !this.nms) return;
    try {
      const session = this.nms.getSession(sessionId);
      if (session && typeof session.reject === 'function') session.reject();
      else if (session && typeof session.stop === 'function') session.stop();
    } catch {
      /* session already gone */
    }
  }

  stop() {
    this.running = false;
    try {
      this.nms?.stop();
    } catch {
      /* already stopped */
    }
  }
}

module.exports = { IngestServer };

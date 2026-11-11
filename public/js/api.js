const PLATFORM_META = {
  youtube: { short: 'YT', name: 'YouTube', color: '#ff4d4d' },
  twitch: { short: 'TW', name: 'Twitch', color: '#a970ff' },
  kick: { short: 'K', name: 'Kick', color: '#53fc18' },
  restream: { short: 'RS', name: 'Restream', color: '#22d3ee' },
  aparat: { short: 'AP', name: 'Aparat', color: '#ff6b6b' },
  custom: { short: 'RT', name: 'Custom RTMP', color: '#f0abfc' }
};

const ICONS = {
  youtube:
    '<path d="M21.6 7.2a2.8 2.8 0 0 0-2-2C17.9 4.8 12 4.8 12 4.8s-5.9 0-7.6.4a2.8 2.8 0 0 0-2 2A29 29 0 0 0 2 12a29 29 0 0 0 .4 4.8 2.8 2.8 0 0 0 2 2c1.7.4 7.6.4 7.6.4s5.9 0 7.6-.4a2.8 2.8 0 0 0 2-2A29 29 0 0 0 22 12a29 29 0 0 0-.4-4.8ZM10 15.5v-7l6 3.5-6 3.5Z"/>',
  twitch:
    '<path d="M4 3 3 6v13h4v3h3l3-3h3l4-4V3H4Zm14 10-3 3h-3l-3 3v-3H6V5h12v8Zm-9-6h2v5H9V7Zm5 0h2v5h-2V7Z"/>',
  kick: '<path d="M4 2h4v6l6-6h5l-7 8 7 8h-5l-6-6v6H4V2Z"/>',
  restream:
    '<path d="M12 4a8 8 0 0 1 8 8h-3a5 5 0 0 0-8.7-3.4L11 11H4V4l2.4 2.4A8 8 0 0 1 12 4Zm0 16a8 8 0 0 1-8-8h3a5 5 0 0 0 8.7 3.4L13 13h7v7l-2.4-2.4A8 8 0 0 1 12 20Z"/>',
  aparat: '<path d="M12 3 3 21h4l2-5h6l2 5h4L12 3Zm-1.5 9L12 8l1.5 4h-3Z"/>',
  custom:
    '<path d="M7 2v5H5V2H3v5H1v5a4 4 0 0 0 3 3.9V22h2v-6.1A4 4 0 0 0 9 12V7H7V2Zm12 0v5h-2V2h-2v5h-2v5a4 4 0 0 0 3 3.9V22h2v-6.1A4 4 0 0 0 21 12V7h-2V2Z"/>'
};

export function platformIcon(platform) {
  const body = ICONS[platform] || ICONS.custom;
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${body}</svg>`;
}

export function platformMeta(platform) {
  return PLATFORM_META[platform] || PLATFORM_META.custom;
}

export async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
  if (opts.body !== undefined && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    const err = new Error(data.error || `خطای سرور (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function esc(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (ch) => {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '"') return '&quot;';
    return '&#39;';
  });
}

export function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1000) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1000;
  let i = 0;
  while (size >= 1000 && i < units.length - 1) {
    size /= 1000;
    i += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[i]}`;
}

export function fmtBitrate(kbps) {
  const value = Number(kbps) || 0;
  if (value >= 1000) return `${(value / 1000).toFixed(1)} Mbps`;
  return `${Math.round(value)} kbps`;
}

export function fmtDate(iso, withTime = false) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {})
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function dayLabel(dateKey) {
  try {
    return new Intl.DateTimeFormat('fa-IR', { month: 'short', day: 'numeric' }).format(
      new Date(`${dateKey}T12:00:00`)
    );
  } catch {
    return dateKey.slice(5);
  }
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return 'لحظه‌ای پیش';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} دقیقه پیش`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} ساعت پیش`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} روز پیش`;
  return fmtDate(iso);
}

export function duration(ms) {
  if (!ms || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function initial(name) {
  const text = String(name || '?').trim();
  return text ? text.slice(0, 1).toUpperCase() : '?';
}

export function quotaPercent(used, quota) {
  if (quota === null || quota === undefined) return null;
  if (!quota) return 100;
  return Math.min(100, (Number(used) / Number(quota)) * 100);
}

export function statusLabel(status) {
  if (status === 'approved') return 'تأیید شده';
  if (status === 'pending') return 'در انتظار تأیید';
  if (status === 'rejected') return 'رد شده';
  return status || '—';
}

export function relayStatus(status) {
  if (status === 'running') return { text: 'متصل', cls: 'ok' };
  if (status === 'starting') return { text: 'در حال اتصال', cls: 'warn' };
  if (status === 'reconnecting') return { text: 'قطع / تلاش مجدد', cls: 'danger' };
  if (status === 'stopped') return { text: 'قطع', cls: 'muted' };
  return { text: 'آماده', cls: 'muted' };
}

export function toast(message, type = 'info') {
  let host = document.querySelector('.toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toasts';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    el.style.transition = 'opacity .25s, transform .25s';
    setTimeout(() => el.remove(), 280);
  }, 4200);
}

export async function copyText(text, success = 'کپی شد') {
  const value = String(text ?? '');
  try {
    await navigator.clipboard.writeText(value);
    toast(success, 'ok');
  } catch {
    const area = document.createElement('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      toast(success, 'ok');
    } catch {
      toast('کپی نشد؛ دستی انتخاب کنید.', 'err');
    }
    area.remove();
  }
}

export function setButtonLoading(button, loading, label) {
  if (!button) return;
  if (loading) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spin"></span> ${label || 'در حال انجام…'}`;
  } else {
    button.disabled = false;
    if (button.dataset.label) button.innerHTML = button.dataset.label;
  }
}

export function emptyState(text, icon = '') {
  return `<div class="empty">${icon}${esc(text)}</div>`;
}

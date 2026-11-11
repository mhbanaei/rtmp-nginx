import {
  api,
  esc,
  fmtBytes,
  fmtBitrate,
  dayLabel,
  timeAgo,
  duration,
  initial,
  toast,
  copyText,
  platformIcon,
  platformMeta,
  relayStatus,
  statusLabel,
  quotaPercent,
  emptyState
} from './api.js';

const $ = (id) => document.getElementById(id);
const state = {
  data: null,
  destSig: '',
  editing: false
};

const RING_CIRCUMFERENCE = 2 * Math.PI * 54;

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = value;
}

function banner(type, title, text) {
  const icons = {
    warn: '<path d="M12 9v4M12 17h.01M10.3 3.9 2.5 18a2 2 0 0 0 1.8 3h15.4a2 2 0 0 0 1.8-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke-linecap="round" stroke-linejoin="round"/>',
    danger: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01" stroke-linecap="round"/>',
    brand: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5" stroke-linecap="round" stroke-linejoin="round"/>'
  };
  const icon = icons[type] || icons.brand;
  return `<div class="banner banner-${type}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${icon}</svg>
    <div><strong>${esc(title)}</strong><small>${text}</small></div>
  </div>`;
}

function renderBanners(data) {
  const out = [];
  if (data.user.status === 'pending') {
    out.push(
      banner(
        'brand',
        'حساب شما در انتظار تأیید است',
        'اتصال OBS تا تأیید مدیر مسدود است؛ اما می‌توانید مقصدها، کلیدهای پخش و تنظیمات خود را از الان کامل کنید.'
      )
    );
  }
  if (data.user.status === 'rejected') {
    out.push(banner('danger', 'دسترسی شما رد شده است', 'برای بررسی دوباره با مدیر سامانه تماس بگیرید.'));
  }
  if (data.user.quotaBlocked) {
    out.push(
      banner('danger', 'سهمیه حجم مصرفی تمام شد', 'تمام مقصدها متوقف شده‌اند. برای افزایش سهمیه با مدیر تماس بگیرید.')
    );
  }
  if (data.ingest.fallback) {
    out.push(
      banner(
        'warn',
        `پورت ${esc(data.ingest.requestedPort)} اشغال است`,
        `سرور RTMP موقتاً روی پورت <b dir="ltr">${esc(data.ingest.rtmpPort)}</b> بالا آمده؛ آدرس Server را مطابق همین پورت تنظیم کنید.`
      )
    );
  }
  const host = $('banners');
  if (host) host.innerHTML = out.join('');
}

function renderHeader(data) {
  const user = data.user;
  setText('userName', user.displayName || user.username);
  setText('userHandle', `@${user.username}`);
  setText('userAvatar', initial(user.displayName || user.username));
  $('adminLink').classList.toggle('hidden', user.role !== 'admin');

  const pill = $('livePill');
  if (data.live) {
    pill.className = 'pill pill-live';
    pill.innerHTML = '<span class="live-dot"></span> در حال پخش';
  } else {
    pill.className = 'pill badge-muted';
    pill.innerHTML = '<span class="live-dot" style="background:#64748b;box-shadow:none;animation:none"></span> آفلاین';
  }

  const badge = $('accountBadge');
  if (user.status === 'approved') {
    badge.className = 'badge badge-ok';
    badge.textContent = user.role === 'admin' ? 'مدیر • تأیید شده' : 'حساب تأیید شده';
  } else if (user.status === 'pending') {
    badge.className = 'badge badge-warn';
    badge.textContent = 'در انتظار تأیید مدیر';
  } else {
    badge.className = 'badge badge-danger';
    badge.textContent = statusLabel(user.status);
  }
}

function renderStatus(data) {
  const card = $('statusCard');
  const dot = $('liveDot');
  const relays = (data.relays || []).filter((r) => ['running', 'starting', 'reconnecting'].includes(r.status));
  const connected = (data.relays || []).filter((r) => r.status === 'running');
  const bitrate = connected.reduce((sum, r) => sum + (r.bitrateKbps || 0), 0);

  card.classList.toggle('is-live', data.live);
  dot.classList.toggle('live', data.live);

  if (data.live) {
    setText('statusTitle', 'استریم شما در حال پخش است');
    setText(
      'statusSub',
      connected.length
        ? `${connected.length} مقصد در حال دریافت تصویر هستند.`
        : 'استریم به سرور رسیده اما هنوز مقصدی روشن نیست.'
    );
    const badge = $('statusBadge');
    badge.className = 'badge badge-ok';
    badge.textContent = 'LIVE';
  } else if (data.user.status === 'pending') {
    setText('statusTitle', 'حساب شما در انتظار تأیید است');
    setText(
      'statusSub',
      'اتصال OBS تا تأیید مدیر مسدود است؛ می‌توانید مقصدها و تنظیمات را از الان ذخیره کنید.'
    );
    const badge = $('statusBadge');
    badge.className = 'badge badge-warn';
    badge.textContent = 'در انتظار تأیید';
  } else {
    setText('statusTitle', 'استریم متصل نیست');
    setText('statusSub', 'با OBS به سرور ما وصل شوید تا پخش شروع شود.');
    const badge = $('statusBadge');
    badge.className = 'badge badge-muted';
    badge.textContent = 'آفلاین';
  }

  setText('statRelays', String(connected.length));
  setText('statBitrate', fmtBitrate(bitrate).replace(' kbps', '').replace(' Mbps', ''));
  $('statBitrate').nextElementSibling.textContent = bitrate >= 1000 ? 'مگابیت بر ثانیه' : 'کیلوبیت بر ثانیه';

  const started = data.user.liveSince ? new Date(data.user.liveSince).getTime() : 0;
  setText('statUptime', data.live && started ? duration(Date.now() - started) : '—');
  void relays;
}

function renderQuota(data) {
  const used = Number(data.quota.used) || 0;
  const limit = data.quota.bytes;
  const pct = quotaPercent(used, limit);
  const ring = $('ringFg');

  if (limit === null || limit === undefined) {
    ring.style.strokeDashoffset = '0';
    ring.style.opacity = '0.55';
    setText('quotaPct', '∞');
    setText('quotaLimit', 'نامحدود');
    setText('quotaRemain', '—');
  } else {
    ring.style.opacity = '1';
    const value = Math.min(100, pct || 0);
    ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - value / 100));
    setText('quotaPct', `${Math.round(value)}%`);
    setText('quotaLimit', fmtBytes(limit));
    setText('quotaRemain', fmtBytes(Math.max(0, limit - used)));
    if (value >= 90) ring.style.stroke = '#fb7185';
    else if (value >= 70) ring.style.stroke = '#fbbf24';
    else ring.style.stroke = '';
  }
  setText('quotaUsed', fmtBytes(used));
}

function renderCredentials(data) {
  setText('streamServer', data.ingest.publishBase);
  setText('streamKey', data.user.streamKey);
  setText('profileLink', `${window.location.origin}/u/${data.user.username}`);

  const note = $('ingestNote');
  const user = data.user;
  if (user.status === 'pending') {
    note.classList.add('warn');
    note.querySelector('span').textContent =
      'حساب شما هنوز تأیید نشده است؛ اتصال OBS تا تأیید مدیر مسدود است. تنظیمات مقصدها را می‌توانید ذخیره کنید.';
  } else {
    note.classList.remove('warn');
    note.querySelector('span').textContent =
      'پس از اتصال OBS، مقصدهای روشن به‌صورت خودکار وصل می‌شوند. قطع شدن اینترنت باعث توقف پخش می‌شود.';
  }
}

function destinationHint(dest, meta) {
  if (dest.platform === 'aparat') {
    return 'آدرس سرور آپارات ثابت است؛ فقط کلید پخش را از پنل زنده آپارات وارد کنید. اگر لینک کامل Push گرفتید، همان را در فیلد کلید بچسبانید.';
  }
  if (dest.platform === 'custom') {
    return 'آدرس سرور و کلید را از ارائه‌دهنده خود بگیرید.';
  }
  return meta.name === 'Kick'
    ? 'آدرس پیش‌فرض Kick از RTMPS استفاده می‌کند؛ نیازی به تغییر آن نیست.'
    : 'کلید پخش را از تنظیمات زنده همان پلتفرم بردارید.';
}

function destCard(dest, data) {
  const meta = platformMeta(dest.platform);
  const disabled = data.user.quotaBlocked;
  const aparat = dest.platform === 'aparat';
  const aparatServer = 'rtmp://rtmp.cdn.asset.aparat.com:443/event';
  const placeholderServer = aparat
    ? aparatServer
    : meta.name === 'YouTube'
      ? 'rtmp://a.rtmp.youtube.com/live2'
      : dest.serverUrl || 'rtmp://...';

  return `<article class="dest-card ${dest.enabled ? 'on' : ''}" data-id="${esc(dest.id)}" style="--brand:${meta.color}">
    <div class="dest-head">
      <span class="platform-tile">${platformIcon(dest.platform)}</span>
      <div class="dest-name">
        <strong>${esc(dest.label)}</strong>
        <small>${aparat ? 'پوش اختصاصی آپارات' : meta.name}</small>
      </div>
      <label class="switch" title="${dest.enabled ? 'غیرفعال کردن' : 'فعال کردن'}">
        <input type="checkbox" data-toggle ${dest.enabled ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
        <span></span>
      </label>
    </div>

    <div class="dest-status" data-status-for="${esc(dest.id)}">
      <span class="badge badge-muted">آماده</span>
    </div>

    <div class="dest-body">
      <label class="field">
        <span>${aparat ? 'آدرس سرور آپارات' : 'آدرس سرور RTMP'}</span>
        <input class="input" data-field="serverUrl" value="${esc(aparat ? dest.serverUrl || aparatServer : dest.serverUrl)}" placeholder="${esc(placeholderServer)}" ${aparat ? '' : 'readonly'} dir="ltr" />
      </label>
      <label class="field">
        <span>${aparat ? 'کلید پخش آپارات' : 'کلید پخش'}</span>
        <input class="input" data-field="streamKey" type="password" value="${esc(dest.streamKey)}" placeholder="${aparat ? 'کلید استریم یا لینک کامل Push' : 'stream-key'}" dir="ltr" />
      </label>
      <div class="dest-actions">
        <button class="btn btn-sm" type="button" data-save>ذخیره</button>
        <button class="btn btn-ghost btn-sm" type="button" data-reveal>نمایش کلید</button>
        ${dest.platform === 'custom' ? '<button class="btn btn-danger btn-sm" type="button" data-delete>حذف</button>' : ''}
        <label class="checkbox" style="margin-inline-start:auto">
          <input type="checkbox" data-compat ${dest.compat ? 'checked' : ''} />
          <span>سازگاری صدا</span>
        </label>
      </div>
      <p class="dest-hint">${esc(destinationHint(dest, meta))}</p>
    </div>
  </article>`;
}

function renderDestinations(data, force = false) {
  const sig = JSON.stringify(
    (data.user.destinations || []).map((d) => ({
      id: d.id,
      label: d.label,
      serverUrl: d.serverUrl,
      streamKey: d.streamKey,
      enabled: d.enabled,
      compat: d.compat
    }))
  );
  if (!force && (state.editing || sig === state.destSig)) return;
  state.destSig = sig;
  $('destGrid').innerHTML = (data.user.destinations || []).map((dest) => destCard(dest, data)).join('');
  updateDestinationStatus(data);
}

function updateDestinationStatus(data) {
  const byId = new Map((data.relays || []).map((r) => [r.destId, r]));
  for (const dest of data.user.destinations || []) {
    const node = document.querySelector(`[data-status-for="${dest.id}"]`);
    if (!node) continue;
    const relay = byId.get(dest.id);
    let html = '';
    if (relay) {
      const st = relayStatus(relay.status);
      const cls = st.cls === 'ok' ? 'badge-ok' : st.cls === 'warn' ? 'badge-warn' : st.cls === 'danger' ? 'badge-danger' : 'badge-muted';
      html = `<span class="badge ${cls}">${esc(st.text)}</span>`;
      if (relay.status === 'running') {
        html += `<span class="live-stat"><b>${esc(fmtBitrate(relay.bitrateKbps))}</b><span>•</span><span>${esc(fmtBytes(relay.bytesSession))}</span></span>`;
      } else if (relay.status === 'reconnecting') {
        html += `<span class="live-stat" title="${esc(relay.error || '')}">تلاش مجدد…</span>`;
      }
    } else if (dest.enabled && data.live) {
      html = '<span class="badge badge-warn">در انتظار اتصال</span>';
    } else if (dest.enabled) {
      html = '<span class="badge badge-brand">فعال • منتظر پخش</span>';
    } else {
      html = '<span class="badge badge-muted">غیرفعال</span>';
    }
    node.innerHTML = html;
  }
}

function renderChart(data) {
  const series = data.series || [];
  const total = series.reduce((sum, point) => sum + (point.bytes || 0), 0);
  setText('chartTotal', fmtBytes(total));
  const max = Math.max(...series.map((p) => p.bytes || 0), 1);
  $('chart').innerHTML = series
    .map((point) => {
      const height = point.bytes > 0 ? Math.max(4, Math.round((point.bytes / max) * 100)) : 1;
      return `<div class="bar-col" title="${esc(dayLabel(point.date))} — ${esc(fmtBytes(point.bytes))}">
        <div class="bar-track"><span class="bar-fill ${point.bytes ? '' : 'zero'}" style="height:${height}%"></span></div>
        <span class="bar-label">${esc(dayLabel(point.date))}</span>
      </div>`;
    })
    .join('');
}

function renderEvents(data) {
  const events = data.events || [];
  if (!events.length) {
    $('events').innerHTML = emptyState('هنوز رویدادی برای حساب شما ثبت نشده است.');
    return;
  }
  $('events').innerHTML = events
    .map(
      (event) => `<div class="event">
        <span class="event-dot ${esc(event.type || 'info')}"></span>
        <div class="event-body">
          <p>${esc(event.message)}</p>
          <small>${esc(timeAgo(event.at))}</small>
        </div>
      </div>`
    )
    .join('');
}

function render(data) {
  renderHeader(data);
  renderBanners(data);
  renderStatus(data);
  renderQuota(data);
  renderCredentials(data);
  renderDestinations(data);
  updateDestinationStatus(data);
  renderChart(data);
  renderEvents(data);
}

async function load({ silent = false } = {}) {
  try {
    const data = await api('/api/dashboard');
    state.data = data;
    render(data);
  } catch (err) {
    if (err.status === 401) {
      window.location.href = '/';
      return;
    }
    if (!silent) toast(err.message, 'err');
  }
}

function destFromCard(card) {
  const id = card.dataset.id;
  return (state.data?.user.destinations || []).find((d) => d.id === id);
}

$('destGrid').addEventListener('focusin', () => {
  state.editing = true;
});
$('destGrid').addEventListener('focusout', () => {
  setTimeout(() => {
    const active = document.activeElement;
    if (!active || !$('destGrid').contains(active)) state.editing = false;
  }, 400);
});

$('destGrid').addEventListener('click', async (event) => {
  const card = event.target.closest('.dest-card');
  if (!card) return;
  const dest = destFromCard(card);

  if (event.target.closest('[data-reveal]')) {
    const input = card.querySelector('[data-field="streamKey"]');
    if (input) input.type = input.type === 'password' ? 'text' : 'password';
    return;
  }

  if (event.target.closest('[data-save]')) {
    const button = event.target.closest('[data-save]');
    const serverUrl = card.querySelector('[data-field="serverUrl"]')?.value || '';
    const streamKey = card.querySelector('[data-field="streamKey"]')?.value || '';
    const compat = card.querySelector('[data-compat]')?.checked || false;
    button.disabled = true;
    button.textContent = 'ذخیره…';
    try {
      await api(`/api/destinations/${dest.id}`, { method: 'PUT', body: { serverUrl, streamKey, compat } });
      toast('تنظیمات مقصد ذخیره شد.', 'ok');
      state.destSig = '';
      await load({ silent: true });
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      button.disabled = false;
      button.textContent = 'ذخیره';
    }
    return;
  }

  if (event.target.closest('[data-delete]')) {
    if (!window.confirm(`مقصد «${dest.label}» حذف شود؟`)) return;
    try {
      await api(`/api/destinations/${dest.id}`, { method: 'DELETE' });
      toast('مقصد حذف شد.', 'ok');
      state.destSig = '';
      await load({ silent: true });
    } catch (err) {
      toast(err.message, 'err');
    }
  }
});

$('destGrid').addEventListener('change', async (event) => {
  const toggle = event.target.closest('[data-toggle]');
  if (!toggle) return;
  const card = toggle.closest('.dest-card');
  const dest = destFromCard(card);
  const enabled = toggle.checked;
  toggle.disabled = true;
  try {
    const serverUrl = card.querySelector('[data-field="serverUrl"]')?.value.trim() || '';
    const streamKey = card.querySelector('[data-field="streamKey"]')?.value.trim() || '';
    const compat = card.querySelector('[data-compat]')?.checked || false;
    if (
      serverUrl !== (dest.serverUrl || '') ||
      streamKey !== (dest.streamKey || '') ||
      Boolean(compat) !== Boolean(dest.compat)
    ) {
      await api(`/api/destinations/${dest.id}`, { method: 'PUT', body: { serverUrl, streamKey, compat } });
    }
    await api(`/api/destinations/${dest.id}/toggle`, { method: 'POST', body: { enabled } });
    toast(enabled ? 'مقصد روشن شد.' : 'مقصد خاموش شد.', enabled ? 'ok' : 'warn');
    await load({ silent: true });
  } catch (err) {
    toggle.checked = !enabled;
    toast(err.message, 'err');
  } finally {
    toggle.disabled = false;
  }
});

$('rotateKey').addEventListener('click', async () => {
  if (state.data?.live) {
    toast('برای ساخت کلید جدید ابتدا پخش را متوقف کنید.', 'warn');
    return;
  }
  if (!window.confirm('کلید پخش جدید ساخته شود؟ کلید قبلی دیگر کار نمی‌کند.')) return;
  try {
    const result = await api('/api/stream/rotate', { method: 'POST' });
    setText('streamKey', result.streamKey);
    toast('کلید پخش جدید ساخته شد.', 'ok');
    await load({ silent: true });
  } catch (err) {
    toast(err.message, 'err');
  }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-id]');
  if (button) {
    const node = $(button.dataset.copyId);
    if (node) await copyText(node.textContent);
    return;
  }
  const reveal = event.target.closest('[data-reveal-id]');
  if (reveal) {
    const node = $(reveal.dataset.revealId);
    if (node) node.style.filter = node.style.filter ? '' : 'blur(5px)';
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
  } finally {
    window.location.href = '/';
  }
});

$('refreshEvents').addEventListener('click', () => load());

// custom destination dialog
const customDialog = $('customDialog');
$('addCustom').addEventListener('click', () => {
  $('customForm').reset();
  $('customError').classList.remove('show');
  if (typeof customDialog.showModal === 'function') customDialog.showModal();
  else customDialog.setAttribute('open', '');
});
document.querySelectorAll('[data-close-dialog]').forEach((btn) => {
  btn.addEventListener('click', () => customDialog.close());
});
customDialog.addEventListener('click', (event) => {
  if (event.target === customDialog) customDialog.close();
});
$('customForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData($('customForm'));
  const errorBox = $('customError');
  errorBox.classList.remove('show');
  try {
    await api('/api/destinations', {
      method: 'POST',
      body: {
        label: String(form.get('label') || '').trim(),
        serverUrl: String(form.get('serverUrl') || '').trim(),
        streamKey: String(form.get('streamKey') || '').trim(),
        compat: form.get('compat') === 'on'
      }
    });
    customDialog.close();
    toast('مقصد دلخواه اضافه شد.', 'ok');
    state.destSig = '';
    await load({ silent: true });
  } catch (err) {
    errorBox.querySelector('span').textContent = err.message;
    errorBox.classList.add('show');
  }
});

setInterval(() => {
  if (!document.hidden) load({ silent: true });
}, 3000);

setInterval(() => {
  if (state.data?.live && state.data.user.liveSince) {
    setText('statUptime', duration(Date.now() - new Date(state.data.user.liveSince).getTime()));
  }
}, 1000);

load();

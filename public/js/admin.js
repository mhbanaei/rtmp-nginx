import {
  api,
  esc,
  fmtBytes,
  fmtBitrate,
  fmtDate,
  timeAgo,
  initial,
  toast,
  copyText,
  platformIcon,
  platformMeta,
  relayStatus,
  statusLabel,
  quotaPercent,
  emptyState,
  duration
} from './api.js';

const $ = (id) => document.getElementById(id);
const state = {
  data: null,
  view: 'overview',
  search: '',
  filter: '',
  detailUserId: null,
  settingsLoaded: false
};

const VIEW_TITLES = {
  overview: ['نمای کلی', 'تصویر کلی سامانه و وضعیت پخش‌ها'],
  users: ['کاربران', 'تأیید، نقش‌ها، سهمیه حجم و دسترسی‌ها'],
  streams: ['پخش‌های فعال', 'اتصال‌های RTMP در حال اجرا'],
  events: ['رویدادها', 'تاریخچه اقدامات کاربران و سامانه'],
  settings: ['تنظیمات', 'پیکربندی دامنه و سرور دریافت']
};

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = value;
}

function statusBadge(status) {
  if (status === 'approved') return '<span class="badge badge-ok">تأیید شده</span>';
  if (status === 'pending') return '<span class="badge badge-warn">در انتظار</span>';
  if (status === 'rejected') return '<span class="badge badge-danger">رد شده</span>';
  return `<span class="badge badge-muted">${esc(status)}</span>`;
}

function roleBadge(role) {
  return role === 'admin' ? '<span class="badge badge-brand">مدیر</span>' : '<span class="badge badge-muted">کاربر</span>';
}

function usageCell(user) {
  const pct = quotaPercent(user.usageBytes, user.quotaBytes);
  const cls = pct === null ? '' : pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
  const label =
    user.quotaBytes === null || user.quotaBytes === undefined
      ? `${fmtBytes(user.usageBytes)} / نامحدود`
      : `${fmtBytes(user.usageBytes)} / ${fmtBytes(user.quotaBytes)}`;
  return `<div>${esc(label)}</div><div class="meter"><i class="${cls}" style="width:${pct === null ? 8 : Math.min(100, Math.max(3, pct))}%"></i></div>`;
}

function eventList(events) {
  if (!events || !events.length) return emptyState('رویدادی ثبت نشده است.');
  return events
    .map(
      (event) => `<div class="event">
        <span class="event-dot ${esc(event.type || 'info')}"></span>
        <div class="event-body">
          <p>${event.username ? `<strong>@${esc(event.username)}</strong> — ` : ''}${esc(event.message)}</p>
          <small>${esc(timeAgo(event.at))}${event.at ? ` • ${esc(fmtDate(event.at, true))}` : ''}</small>
        </div>
      </div>`
    )
    .join('');
}

function renderHeader() {
  const data = state.data;
  const pill = $('livePill');
  if (data.stats.live > 0) {
    pill.className = 'pill pill-live';
    pill.innerHTML = '<span class="live-dot"></span> پخش فعال';
  } else {
    pill.className = 'pill badge-muted';
    pill.innerHTML = '<span class="live-dot" style="background:#64748b;box-shadow:none;animation:none"></span> آفلاین';
  }
  const pending = data.stats.pending;
  const badge = $('pendingCount');
  badge.textContent = pending;
  badge.classList.toggle('hidden', pending === 0);
}

function renderOverview() {
  const data = state.data;
  setText('statUsers', data.stats.users);
  setText('statApproved', `${data.stats.approved} تأیید شده`);
  setText('statPending', data.stats.pending);
  setText('statLive', data.stats.live);
  setText('statRelays', `${data.stats.relays} اتصال فعال`);
  setText('statUsage', fmtBytes(data.stats.usageTotal));
  setText('statToday', `امروز: ${fmtBytes(data.stats.usageToday)}`);

  const pending = data.users.filter((u) => u.status === 'pending');
  setText('pendingBadge', String(pending.length));
  $('pendingTable').innerHTML = pending.length
    ? pending
        .map(
          (u) => `<tr>
            <td><div class="user-cell"><span class="avatar">${esc(initial(u.displayName || u.username))}</span><div><strong>${esc(u.displayName)}</strong><small>@${esc(u.username)}</small></div></div></td>
            <td class="muted tiny">${esc(timeAgo(u.createdAt))}</td>
            <td><button class="btn btn-ok btn-sm" data-approve="${esc(u.id)}">تأیید</button></td>
          </tr>`
        )
        .join('')
    : `<tr><td colspan="3">${emptyState('همه حساب‌ها بررسی شده‌اند.')}</td></tr>`;

  setText('relayBadge', String((data.relays || []).length));
  $('liveRelays').innerHTML = data.relays.length
    ? data.relays
        .map((relay) => {
          const meta = platformMeta(relay.platform);
          const st = relayStatus(relay.status);
          return `<div class="dest-mini">
            <span class="platform-tile" style="--brand:${meta.color}">${platformIcon(relay.platform)}</span>
            <div class="dest-mini-info">
              <strong>${esc(relay.username)} — ${esc(relay.label)}</strong>
              <code>${esc(fmtBitrate(relay.bitrateKbps))} • ${esc(fmtBytes(relay.bytesSession))}</code>
            </div>
            <span class="badge ${st.cls === 'ok' ? 'badge-ok' : st.cls === 'warn' ? 'badge-warn' : 'badge-danger'}">${esc(st.text)}</span>
          </div>`;
        })
        .join('')
    : emptyState('هیچ اتصال فعالی وجود ندارد.');

  $('overviewEvents').innerHTML = eventList((data.events || []).slice(0, 8));
}

function filteredUsers() {
  const needle = state.search.trim().toLowerCase();
  return (state.data?.users || []).filter((user) => {
    if (state.filter && user.status !== state.filter) return false;
    if (!needle) return true;
    return (
      user.username.toLowerCase().includes(needle) ||
      String(user.displayName || '').toLowerCase().includes(needle) ||
      String(user.email || '').toLowerCase().includes(needle)
    );
  });
}

function renderUsers() {
  const users = filteredUsers();
  setText('usersCount', `${users.length} کاربر`);
  $('usersTable').innerHTML = users.length
    ? users
        .map(
          (user) => `<tr>
            <td>
              <div class="user-cell">
                <span class="avatar">${esc(initial(user.displayName || user.username))}</span>
                <div><strong>${esc(user.displayName)}</strong><small>@${esc(user.username)}</small></div>
              </div>
            </td>
            <td>${statusBadge(user.status)}</td>
            <td>${roleBadge(user.role)}</td>
            <td class="usage-cell">${usageCell(user)}</td>
            <td>${user.live ? '<span class="badge badge-ok">LIVE</span>' : '<span class="badge badge-muted">آفلاین</span>'}</td>
            <td class="muted tiny">${esc(user.lastLoginAt ? timeAgo(user.lastLoginAt) : 'هرگز')}</td>
            <td class="row-actions">
              <button class="btn btn-sm" data-open="${esc(user.id)}">مدیریت</button>
              ${user.status === 'pending' ? `<button class="btn btn-ok btn-sm" data-approve="${esc(user.id)}">تأیید</button>` : ''}
            </td>
          </tr>`
        )
        .join('')
    : `<tr><td colspan="7">${emptyState('کاربری با این فیلتر پیدا نشد.')}</td></tr>`;
}

function renderStreams() {
  const relays = state.data?.relays || [];
  setText('streamsCount', String(relays.length));
  $('relaysTable').innerHTML = relays.length
    ? relays
        .map((relay) => {
          const meta = platformMeta(relay.platform);
          const st = relayStatus(relay.status);
          return `<tr>
            <td>@${esc(relay.username)}</td>
            <td>
              <div class="user-cell">
                <span class="platform-tile" style="--brand:${meta.color};width:26px;height:26px;border-radius:7px">${platformIcon(relay.platform)}</span>
                <div><strong>${esc(relay.label)}</strong><small>${esc(meta.name)}</small></div>
              </div>
            </td>
            <td><span class="badge ${st.cls === 'ok' ? 'badge-ok' : st.cls === 'warn' ? 'badge-warn' : 'badge-danger'}">${esc(st.text)}</span></td>
            <td dir="ltr">${esc(fmtBitrate(relay.bitrateKbps))}</td>
            <td>${esc(fmtBytes(relay.bytesSession))}</td>
            <td class="muted tiny" dir="ltr">${esc(relay.targetHost || '—')}</td>
            <td class="row-actions"><button class="btn btn-danger btn-sm" data-stop-user="${esc(relay.userId)}">قطع</button></td>
          </tr>`;
        })
        .join('')
    : `<tr><td colspan="7">${emptyState('هیچ پخشی در حال اجرا نیست.')}</td></tr>`;
}

function renderEvents() {
  $('eventsList').innerHTML = eventList(state.data?.events || []);
}

function fillSettings() {
  const data = state.data;
  if (!data) return;
  const form = $('settingsForm');
  if (form && !form.contains(document.activeElement)) {
    form.siteName.value = data.settings.siteName || '';
    form.publicHost.value = data.settings.publicHost || '';
  }
  setText('ingestPort', data.ingest.rtmpPort);
  setText('ingestApp', data.ingest.app);
  setText('ingestBase', data.ingest.publishBase);
}

function render() {
  if (!state.data) return;
  renderHeader();
  renderOverview();
  renderUsers();
  renderStreams();
  renderEvents();
  fillSettings();
}

async function load({ silent = false } = {}) {
  try {
    const data = await api('/api/admin/overview');
    state.data = data;
    render();
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      window.location.href = '/app';
      return;
    }
    if (!silent) toast(err.message, 'err');
  }
}

function switchView(view, { push = true } = {}) {
  if (!VIEW_TITLES[view]) view = 'overview';
  state.view = view;
  document.querySelectorAll('.view').forEach((section) => {
    section.classList.toggle('hidden', section.id !== `view-${view}`);
  });
  document.querySelectorAll('[data-view]').forEach((button) => {
    if (button.classList.contains('side-link')) button.classList.toggle('active', button.dataset.view === view);
  });
  const [title, sub] = VIEW_TITLES[view];
  setText('viewTitle', title);
  setText('viewSub', sub);
  if (push) history.replaceState(null, '', `#${view}`);
  if (view === 'settings') fillSettings();
}

function closeDialog() {
  const dialog = $('userDialog');
  if (dialog.open) dialog.close();
  state.detailUserId = null;
}

function renderUserDialog(detail) {
  const user = detail.user;
  const meta = platformMeta;
  const usagePct = quotaPercent(user.usageBytes, user.quotaBytes);
  const quotaValue = user.quotaBytes === null || user.quotaBytes === undefined ? '' : (user.quotaBytes / 1e9).toFixed(2);
  const profileLink = `${window.location.origin}/u/${user.username}`;

  const destinations = (user.destinations || [])
    .map((dest) => {
      const m = meta(dest.platform);
      const target = dest.platform === 'aparat' ? dest.serverUrl : `${(dest.serverUrl || '').replace(/\/+$/, '')}/${dest.streamKey || ''}`;
      return `<div class="dest-mini">
        <span class="platform-tile" style="--brand:${m.color}">${platformIcon(dest.platform)}</span>
        <div class="dest-mini-info">
          <strong>${esc(dest.label)} ${dest.enabled ? '<span class="badge badge-ok" style="font-size:9px;padding:0 6px">روشن</span>' : ''}</strong>
          <code title="${esc(target)}">${esc(target || '—')}</code>
        </div>
      </div>`;
    })
    .join('');

  const byPlatform = Object.entries(user.usageByPlatform || {})
    .sort((a, b) => b[1] - a[1])
    .map(
      ([platform, bytes]) =>
        `<div class="info"><span>${esc(meta(platform).name)}</span><b>${esc(fmtBytes(bytes))}</b></div>`
    )
    .join('');

  const relayRows = (detail.relays || [])
    .map((relay) => {
      const st = relayStatus(relay.status);
      return `<div class="dest-mini">
        <span class="platform-tile" style="--brand:${meta(relay.platform).color}">${platformIcon(relay.platform)}</span>
        <div class="dest-mini-info"><strong>${esc(relay.label)}</strong><code>${esc(fmtBitrate(relay.bitrateKbps))} • ${esc(fmtBytes(relay.bytesSession))} • ${esc(st.text)}</code></div>
        <span class="badge ${st.cls === 'ok' ? 'badge-ok' : st.cls === 'warn' ? 'badge-warn' : 'badge-muted'}">${esc(st.text)}</span>
      </div>`;
    })
    .join('');

  $('userDialogBody').innerHTML = `
    <div class="modal-head">
      <div style="display:flex;align-items:center;gap:12px">
        <span class="avatar" style="width:44px;height:44px;border-radius:13px;font-size:18px">${esc(initial(user.displayName || user.username))}</span>
        <div>
          <h2>${esc(user.displayName)}</h2>
          <p>@${esc(user.username)} ${user.email ? `• ${esc(user.email)}` : ''}</p>
          <div style="display:flex;gap:6px;margin-top:6px">${statusBadge(user.status)} ${roleBadge(user.role)} ${detail.live ? '<span class="badge badge-ok">LIVE</span>' : ''}</div>
        </div>
      </div>
      <button type="button" class="icon-btn" data-close aria-label="بستن">×</button>
    </div>

    <div class="info-grid">
      <div class="info"><span>عضویت</span><b>${esc(fmtDate(user.createdAt, true))}</b></div>
      <div class="info"><span>آخرین ورود</span><b>${esc(user.lastLoginAt ? fmtDate(user.lastLoginAt, true) : 'هرگز')}</b></div>
      <div class="info"><span>آخرین پخش</span><b>${esc(user.lastStreamAt ? timeAgo(user.lastStreamAt) : '—')}</b></div>
      <div class="info"><span>مدت پخش فعلی</span><b>${detail.live && user.liveSince ? esc(duration(Date.now() - new Date(user.liveSince).getTime())) : '—'}</b></div>
      <div class="info"><span>حجم مصرفی</span><b>${esc(fmtBytes(user.usageBytes))}</b></div>
      <div class="info"><span>سهمیه</span><b>${user.quotaBytes === null ? 'نامحدود' : esc(fmtBytes(user.quotaBytes))}</b></div>
    </div>

    <div class="modal-section">
      <h3>سهمیه حجم مصرفی</h3>
      <div class="meter" style="margin-bottom:10px"><i class="${usagePct !== null && usagePct >= 90 ? 'danger' : usagePct !== null && usagePct >= 70 ? 'warn' : ''}" style="width:${usagePct === null ? 6 : Math.min(100, usagePct)}%"></i></div>
      <form data-quota-form class="action-row" style="align-items:center">
        <input class="input" name="quotaGb" value="${esc(quotaValue)}" placeholder="نامحدود" style="max-width:150px" dir="ltr" />
        <span class="muted tiny">گیگابایت — خالی = نامحدود</span>
        <button class="btn btn-sm btn-primary" type="submit">ذخیره سهمیه</button>
        <button class="btn btn-sm" type="button" data-action="reset-usage">صفر کردن مصرف</button>
      </form>
    </div>

    <div class="modal-section">
      <h3>دسترسی و امنیت</h3>
      <div class="action-row">
        ${user.status !== 'approved' ? '<button class="btn btn-ok btn-sm" data-action="approve">تأیید حساب</button>' : ''}
        ${user.status !== 'rejected' ? '<button class="btn btn-danger btn-sm" data-action="reject">رد حساب</button>' : ''}
        ${
          user.role === 'admin'
            ? '<button class="btn btn-sm" data-action="role-user">گرفتن نقش مدیر</button>'
            : '<button class="btn btn-sm" data-action="role-admin">ارتقا به مدیر</button>'
        }
        <button class="btn btn-sm" data-action="rotate">کلید پخش جدید</button>
        ${detail.live ? '<button class="btn btn-danger btn-sm" data-action="stop">قطع پخش</button>' : ''}
        <button class="btn btn-danger btn-sm" data-action="delete">حذف حساب</button>
      </div>
    </div>

    <div class="modal-section">
      <h3>کلید پخش و لینک شخصی</h3>
      <div class="code-line">
        <code>${esc(user.streamKey)}</code>
        <button class="mini-btn" data-copy-value="${esc(user.streamKey)}" title="کپی کلید">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></svg>
        </button>
      </div>
      <div class="code-line">
        <code>${esc(profileLink)}</code>
        <button class="mini-btn" data-copy-value="${esc(profileLink)}" title="کپی لینک">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></svg>
        </button>
      </div>
    </div>

    <div class="modal-section">
      <h3>مقصدهای کاربر</h3>
      <div class="dest-mini-list">${destinations || emptyState('مقصدی تعریف نشده است.')}</div>
    </div>

    <div class="modal-section">
      <h3>مصرف به تفکیک پلتفرم</h3>
      <div class="info-grid">${byPlatform || '<div class="info"><span>—</span><b>هنوز مصرفی ثبت نشده</b></div>'}</div>
    </div>

    <div class="modal-section">
      <h3>اتصال‌های در حال اجرا</h3>
      <div class="dest-mini-list">${relayRows || emptyState('اتصال فعالی برای این کاربر وجود ندارد.')}</div>
    </div>

    <div class="modal-section">
      <h3>رویدادهای کاربر</h3>
      <div class="event-list">${eventList(detail.events || [])}</div>
    </div>
  `;
}

async function openUser(userId) {
  try {
    const detail = await api(`/api/admin/users/${userId}`);
    state.detailUserId = userId;
    renderUserDialog(detail);
    const dialog = $('userDialog');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function refreshDetail(userId, { silent = false } = {}) {
  try {
    const detail = await api(`/api/admin/users/${userId}`);
    renderUserDialog(detail);
  } catch (err) {
    if (!silent) toast(err.message, 'err');
  }
}

async function act(userId, path, body, message) {
  try {
    await api(path, { method: 'POST', body: body || {} });
    toast(message, 'ok');
    await load({ silent: true });
    if (state.detailUserId) await refreshDetail(state.detailUserId, { silent: true });
  } catch (err) {
    toast(err.message, 'err');
  }
}

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => switchView(button.dataset.view));
});

document.addEventListener('click', async (event) => {
  const copy = event.target.closest('[data-copy-value]');
  if (copy) {
    await copyText(copy.dataset.copyValue);
    return;
  }

  const close = event.target.closest('[data-close]');
  if (close) {
    closeDialog();
    return;
  }

  const open = event.target.closest('[data-open]');
  if (open) {
    await openUser(open.dataset.open);
    return;
  }

  const approve = event.target.closest('[data-approve]');
  if (approve) {
    await act(approve.dataset.approve, `/api/admin/users/${approve.dataset.approve}/status`, { status: 'approved' }, 'حساب تأیید شد.');
    return;
  }

  const stop = event.target.closest('[data-stop-user]');
  if (stop) {
    if (!window.confirm('پخش این کاربر قطع شود؟')) return;
    await act(stop.dataset.stopUser, `/api/admin/users/${stop.dataset.stopUser}/stop`, {}, 'پخش کاربر قطع شد.');
    return;
  }

  const action = event.target.closest('[data-action]');
  if (!action || !state.detailUserId) return;
  const userId = state.detailUserId;
  const name = action.dataset.action;

  if (name === 'approve') await act(userId, `/api/admin/users/${userId}/status`, { status: 'approved' }, 'حساب تأیید شد.');
  else if (name === 'reject') await act(userId, `/api/admin/users/${userId}/status`, { status: 'rejected' }, 'حساب رد شد.');
  else if (name === 'role-admin') await act(userId, `/api/admin/users/${userId}/role`, { role: 'admin' }, 'کاربر به مدیر ارتقا یافت.');
  else if (name === 'role-user') await act(userId, `/api/admin/users/${userId}/role`, { role: 'user' }, 'نقش مدیر گرفته شد.');
  else if (name === 'reset-usage') {
    await act(userId, `/api/admin/users/${userId}/quota`, { resetUsage: true }, 'حجم مصرفی صفر شد.');
  } else if (name === 'rotate') {
    if (!window.confirm('کلید پخش جدید ساخته شود؟ پخش فعلی قطع می‌شود.')) return;
    try {
      const result = await api(`/api/admin/users/${userId}/rotate-key`, { method: 'POST' });
      toast('کلید جدید ساخته شد.', 'ok');
      await copyText(result.streamKey, 'کلید جدید کپی شد');
      await load({ silent: true });
      if (state.detailUserId) await refreshDetail(state.detailUserId, { silent: true });
    } catch (err) {
      toast(err.message, 'err');
    }
  } else if (name === 'stop') {
    if (!window.confirm('پخش این کاربر قطع شود؟')) return;
    await act(userId, `/api/admin/users/${userId}/stop`, {}, 'پخش قطع شد.');
  } else if (name === 'delete') {
    if (!window.confirm('این حساب و همه اطلاعات آن حذف شود؟ این کار بازگشت‌پذیر نیست.')) return;
    try {
      await api(`/api/admin/users/${userId}`, { method: 'DELETE' });
      toast('حساب حذف شد.', 'ok');
      closeDialog();
      await load({ silent: true });
    } catch (err) {
      toast(err.message, 'err');
    }
  }
});

$('userDialog').addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-quota-form]');
  if (!form) return;
  event.preventDefault();
  if (!state.detailUserId) return;
  const raw = String(new FormData(form).get('quotaGb') || '').trim();
  const quotaGb = raw === '' ? null : Number(raw);
  if (raw !== '' && (!Number.isFinite(quotaGb) || quotaGb < 0)) {
    toast('مقدار سهمیه معتبر نیست.', 'err');
    return;
  }
  try {
    await api(`/api/admin/users/${state.detailUserId}/quota`, { method: 'POST', body: { quotaGb } });
    toast('سهمیه ذخیره شد.', 'ok');
    await load({ silent: true });
    await refreshDetail(state.detailUserId, { silent: true });
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('userDialog').addEventListener('click', (event) => {
  if (event.target === $('userDialog')) closeDialog();
});

$('userSearch').addEventListener('input', () => {
  state.search = $('userSearch').value;
  renderUsers();
});

$('statusFilter').addEventListener('change', () => {
  state.filter = $('statusFilter').value;
  renderUsers();
});

$('refreshBtn').addEventListener('click', () => load());

$('settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData($('settingsForm'));
  try {
    await api('/api/admin/settings', {
      method: 'POST',
      body: { siteName: String(form.get('siteName') || '').trim(), publicHost: String(form.get('publicHost') || '').trim() }
    });
    toast('تنظیمات ذخیره شد.', 'ok');
    await load({ silent: true });
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
  } finally {
    window.location.href = '/';
  }
});

api('/api/me')
  .then((data) => {
    if (!data.user) {
      window.location.href = '/';
      return;
    }
    setText('sideName', data.user.displayName || data.user.username);
    setText('sideHandle', `@${data.user.username}`);
    setText('sideAvatar', initial(data.user.displayName || data.user.username));
  })
  .catch(() => {
    window.location.href = '/';
  });

setInterval(() => {
  if (!document.hidden) load({ silent: true });
}, 5000);

setInterval(() => {
  if (state.data) renderStreams();
}, 3000);

const initialView = window.location.hash.replace('#', '');
switchView(initialView || 'overview', { push: false });
load();

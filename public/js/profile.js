import { api, esc, initial, fmtDate, platformIcon, platformMeta } from './api.js';

const host = document.getElementById('profileContent');
const username = decodeURIComponent(window.location.pathname.split('/').filter(Boolean)[1] || '');

async function load() {
  try {
    const { profile } = await api(`/api/public/profile/${encodeURIComponent(username)}`);
    const platforms = (profile.platforms || [])
      .map((platform) => {
        const meta = platformMeta(platform);
        return `<span class="platform-tile" style="--brand:${meta.color}" title="${esc(meta.name)}">${platformIcon(platform)}</span>`;
      })
      .join('');

    host.className = '';
    host.innerHTML = `
      <div class="profile-avatar">${esc(initial(profile.displayName || profile.username))}</div>
      <h1>${esc(profile.displayName)}</h1>
      <div class="profile-handle">@${esc(profile.username)}</div>

      <div class="profile-badges">
        ${
          profile.live
            ? '<span class="badge badge-ok"><span class="live-dot" style="width:6px;height:6px;border-radius:50%;background:#34d399"></span> همین حالا آنلاین</span>'
            : '<span class="badge badge-muted">آفلاین</span>'
        }
        <span class="badge badge-brand">عضو Restream 42</span>
      </div>

      ${platforms ? `<div class="profile-platforms">${platforms}</div>` : ''}

      <div class="profile-meta">
        <div><b>${esc(fmtDate(profile.createdAt))}</b><small>تاریخ عضویت</small></div>
        <div><b>${profile.live ? 'زنده' : '—'}</b><small>وضعیت پخش</small></div>
        <div><b>${esc((profile.platforms || []).length)}</b><small>مقصد فعال</small></div>
      </div>

      <div class="action-row" style="justify-content: center">
        <a class="btn btn-primary" href="/?tab=register">ساخت حساب رایگان</a>
        <a class="btn" href="/">ورود به پنل</a>
      </div>

      <p class="muted tiny" style="margin-top: 20px">این صفحه لینک اختصاصی پخش ${esc(profile.displayName)} است.</p>
    `;
  } catch (err) {
    host.innerHTML = `
      <div class="profile-avatar" style="background: linear-gradient(135deg, #475569, #1e293b)">?</div>
      <h1>پروفایل پیدا نشد</h1>
      <p class="muted" style="margin-top: 8px">${esc(err.message)}</p>
      <div class="action-row" style="justify-content: center; margin-top: 20px">
        <a class="btn btn-primary" href="/">بازگشت به پنل</a>
      </div>
    `;
  }
}

load();

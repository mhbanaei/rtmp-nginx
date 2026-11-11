import { api, toast } from './api.js';

const state = { mode: 'login' };

const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const title = document.getElementById('authTitle');
const subtitle = document.getElementById('authSubtitle');

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === mode);
  });
  loginForm.classList.toggle('hidden', mode !== 'login');
  registerForm.classList.toggle('hidden', mode !== 'register');
  title.textContent = mode === 'login' ? 'ورود به حساب' : 'ساخت حساب جدید';
  subtitle.textContent =
    mode === 'login'
      ? 'برای مدیریت پخش‌ها وارد شوید.'
      : 'ثبت‌نام رایگان است؛ پس از تأیید مدیر می‌توانید پخش کنید.';
  clearError(mode);
}

function showError(mode, message) {
  const box = document.getElementById(mode === 'login' ? 'loginError' : 'registerError');
  if (!box) return;
  box.querySelector('span').textContent = message;
  box.classList.add('show');
}

function clearError(mode) {
  const box = document.getElementById(mode === 'login' ? 'loginError' : 'registerError');
  if (box) box.classList.remove('show');
}

document.querySelectorAll('[data-tab]').forEach((tab) => {
  tab.addEventListener('click', () => setMode(tab.dataset.tab));
});

document.querySelectorAll('[data-eye]').forEach((button) => {
  button.addEventListener('click', () => {
    const input = button.closest('.input-wrap').querySelector('input');
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
  });
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError('login');
  const button = document.getElementById('loginBtn');
  const data = new FormData(loginForm);
  const username = String(data.get('username') || '').trim();
  const password = String(data.get('password') || '');

  if (!username || !password) {
    showError('login', 'نام کاربری و رمز عبور را وارد کنید.');
    return;
  }

  button.disabled = true;
  button.textContent = 'در حال ورود…';
  try {
    const result = await api('/api/login', { method: 'POST', body: { username, password } });
    toast('خوش آمدید', 'ok');
    window.location.href = result.redirect || '/app';
  } catch (err) {
    showError('login', err.message);
    button.disabled = false;
    button.textContent = 'ورود به پنل';
  }
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError('register');
  const button = document.getElementById('registerBtn');
  const data = new FormData(registerForm);
  const payload = {
    displayName: String(data.get('displayName') || '').trim(),
    username: String(data.get('username') || '').trim(),
    email: String(data.get('email') || '').trim(),
    password: String(data.get('password') || '')
  };

  if (!payload.displayName) return showError('register', 'نام نمایشی را وارد کنید.');
  if (!payload.username) return showError('register', 'نام کاربری را وارد کنید.');
  if (!payload.password) return showError('register', 'رمز عبور را وارد کنید.');

  button.disabled = true;
  button.textContent = 'در حال ساخت حساب…';
  try {
    const result = await api('/api/register', { method: 'POST', body: payload });
    toast(result.message || 'حساب شما ساخته شد.', 'ok');
    window.location.href = result.redirect || '/app';
  } catch (err) {
    showError('register', err.message);
    button.disabled = false;
    button.textContent = 'ساخت حساب';
  }
});

api('/api/me')
  .then((data) => {
    if (data.user) window.location.href = data.user.role === 'admin' ? '/admin' : '/app';
  })
  .catch(() => {
    /* stay on the login page */
  });

// Keep the page friendly when arriving from a redirect.
const params = new URLSearchParams(window.location.search);
if (params.get('tab') === 'register') setMode('register');
if (params.get('reason') === 'auth') toast('برای ادامه وارد شوید.', 'warn');

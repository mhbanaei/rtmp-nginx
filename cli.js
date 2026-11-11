#!/usr/bin/env node
'use strict';

const path = require('node:path');
const readline = require('node:readline');
const { Store, findUser, pushEvent, makeDefaultDestinations } = require('./server/db');
const { hashPassword, randomPassword, randomStreamKey } = require('./server/security');

const argv = process.argv.slice(2);
let dataDir = path.join(__dirname, 'data');
const dataIndex = argv.indexOf('--data');
if (dataIndex >= 0) {
  dataDir = path.resolve(argv[dataIndex + 1] || dataDir);
  argv.splice(dataIndex, 2);
}
let forceInteractive = false;
const interactiveIndex = argv.indexOf('--interactive');
if (interactiveIndex >= 0) {
  forceInteractive = true;
  argv.splice(interactiveIndex, 1);
}

const store = new Store(dataDir);

function fail(message) {
  throw new Error(message);
}

function pad(value, width) {
  return String(value === undefined || value === null ? '' : value).padEnd(width).slice(0, width);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)} GB`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} KB`;
  return `${value} B`;
}

function printTable(users) {
  console.log('');
  console.log(`${pad('USERNAME', 20)} ${pad('ROLE', 7)} ${pad('STATUS', 10)} ${pad('USAGE', 12)} ${pad('QUOTA', 12)}`);
  console.log('-'.repeat(66));
  for (const user of users) {
    const quota = user.quotaBytes === null || user.quotaBytes === undefined ? 'unlimited' : formatBytes(user.quotaBytes);
    console.log(
      `${pad(user.username, 20)} ${pad(user.role, 7)} ${pad(user.status, 10)} ${pad(formatBytes(user.usageBytes), 12)} ${pad(quota, 12)}`
    );
  }
  console.log('');
}

function withUser(name) {
  if (!name) fail('نام کاربری را وارد کنید.');
  const db = store.read();
  const user = findUser(db, name);
  if (!user) fail(`کاربر «${name}» پیدا نشد.`);
  return { db, user };
}

function approve(name) {
  const { db, user } = withUser(name);
  user.status = 'approved';
  user.approvedAt = new Date().toISOString();
  user.rejectedAt = null;
  pushEvent(db, { type: 'user', userId: user.id, username: user.username, message: 'حساب از طریق CLI تأیید شد.' });
  store.write(db);
  console.log(`✔ حساب «${user.username}» تأیید شد.`);
}

function setRole(name, role) {
  const { db, user } = withUser(name);
  if (role === 'user' && user.role === 'admin' && db.users.filter((u) => u.role === 'admin').length <= 1) {
    fail('این کاربر آخرین مدیر است؛ ابتدا مدیر دیگری تعیین کنید.');
  }
  user.role = role;
  if (role === 'admin') {
    user.status = 'approved';
    user.approvedAt = user.approvedAt || new Date().toISOString();
    user.rejectedAt = null;
  }
  pushEvent(db, {
    type: 'role',
    userId: user.id,
    username: user.username,
    message: role === 'admin' ? 'نقش مدیر از طریق CLI داده شد.' : 'نقش مدیر از طریق CLI گرفته شد.'
  });
  store.write(db);
  console.log(
    role === 'admin'
      ? `✔ «${user.username}» اکنون مدیر است و به پنل مدیریت و پنل کاربری دسترسی دارد.`
      : `✔ نقش مدیریت از «${user.username}» گرفته شد.`
  );
}

function showHelp() {
  console.log(`
Restream 42 - server console

Usage:
  node cli.js list
  node cli.js pending
  node cli.js approve <username>
  node cli.js reject <username>
  node cli.js set admin <username>
  node cli.js remove admin <username>
  node cli.js quota <username> <GB|unlimited>
  node cli.js resetusage <username>
  node cli.js key <username>
  node cli.js passwd <username> [new-password]

Options:
  --data <dir>    data directory (default: ./data)
  --interactive   open the management console (also opens automatically in a terminal)

Interactive examples:
  set admin hossein
  remove admin hossein
  quota hossein 50
  list
`);
}

function execute(rawArgs) {
  const args = rawArgs.slice();
  let verb = args.shift();

  if (!verb) {
    showHelp();
    return;
  }

  if (verb === 'set' && args[0] === 'admin') {
    args.shift();
    verb = 'setadmin';
  } else if (verb === 'remove' && args[0] === 'admin') {
    args.shift();
    verb = 'removeadmin';
  } else if (verb === 'admin' && (args[0] === 'add' || args[0] === 'remove')) {
    verb = args[0] === 'add' ? 'setadmin' : 'removeadmin';
    args.shift();
  }

  switch (verb) {
    case 'list': {
      printTable(store.read().users);
      break;
    }
    case 'pending': {
      const users = store.read().users.filter((u) => u.status === 'pending');
      if (!users.length) {
        console.log('هیچ حساب در انتظار تأییدی وجود ندارد.');
        break;
      }
      printTable(users);
      break;
    }
    case 'approve': {
      approve(args[0]);
      break;
    }
    case 'reject': {
      const { db, user } = withUser(args[0]);
      user.status = 'rejected';
      user.rejectedAt = new Date().toISOString();
      pushEvent(db, { type: 'user', userId: user.id, username: user.username, message: 'حساب از طریق CLI رد شد.' });
      store.write(db);
      console.log(`✔ حساب «${user.username}» رد شد.`);
      break;
    }
    case 'setadmin': {
      setRole(args[0], 'admin');
      break;
    }
    case 'removeadmin': {
      setRole(args[0], 'user');
      break;
    }
    case 'quota': {
      const { db, user } = withUser(args[0]);
      const value = String(args[1] || '').toLowerCase();
      if (value === 'reset') {
        user.usageBytes = 0;
        user.usageDaily = {};
        user.usageByPlatform = {};
        user.quotaBlocked = false;
        store.write(db);
        console.log(`✔ حجم مصرفی «${user.username}» صفر شد.`);
        break;
      }
      if (!value) fail('مقدار سهمیه را وارد کنید (گیگابایت یا unlimited).');
      if (value === 'unlimited' || value === 'none' || value === 'null') {
        user.quotaBytes = null;
        user.quotaBlocked = false;
      } else {
        const gb = Number(value);
        if (!Number.isFinite(gb) || gb < 0) fail('مقدار سهمیه معتبر نیست.');
        user.quotaBytes = Math.round(gb * 1e9);
        if (user.usageBytes < user.quotaBytes) user.quotaBlocked = false;
      }
      pushEvent(db, {
        type: 'quota',
        userId: user.id,
        username: user.username,
        message: 'سهمیه حجم مصرفی از طریق CLI تغییر کرد.'
      });
      store.write(db);
      console.log(
        user.quotaBytes === null
          ? `✔ سهمیه «${user.username}» نامحدود شد.`
          : `✔ سهمیه «${user.username}» روی ${(user.quotaBytes / 1e9).toFixed(2)} GB تنظیم شد.`
      );
      break;
    }
    case 'resetusage': {
      const { db, user } = withUser(args[0]);
      user.usageBytes = 0;
      user.usageDaily = {};
      user.usageByPlatform = {};
      user.quotaBlocked = false;
      store.write(db);
      console.log(`✔ حجم مصرفی «${user.username}» صفر شد.`);
      break;
    }
    case 'key': {
      const { db, user } = withUser(args[0]);
      user.streamKey = randomStreamKey();
      pushEvent(db, { type: 'stream', userId: user.id, username: user.username, message: 'کلید پخش از طریق CLI بازنشانی شد.' });
      store.write(db);
      console.log(`✔ کلید پخش جدید «${user.username}»:`);
      console.log(user.streamKey);
      break;
    }
    case 'passwd': {
      const { db, user } = withUser(args[0]);
      const password = args[1] || randomPassword(12);
      if (password.length < 6) fail('رمز عبور باید حداقل ۶ کاراکتر باشد.');
      user.password = hashPassword(password);
      store.write(db);
      console.log(`✔ رمز عبور «${user.username}» تغییر کرد: ${password}`);
      break;
    }
    case 'destinations': {
      const { db, user } = withUser(args[0]);
      if (!Array.isArray(user.destinations) || user.destinations.length === 0) {
        user.destinations = makeDefaultDestinations();
        store.write(db);
      }
      for (const dest of user.destinations) {
        console.log(`${pad(dest.platform, 10)} ${pad(dest.label, 20)} ${dest.enabled ? 'ON ' : 'off'} ${dest.serverUrl || ''}`);
      }
      break;
    }
    case 'help':
    case '--help':
    case '-h': {
      showHelp();
      break;
    }
    default: {
      fail(`دستور ناشناخته: ${verb} (برای دیدن دستورها help را بزنید)`);
    }
  }
}

function startRepl() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'restream> ',
    terminal: true
  });

  console.log('');
  console.log('Restream 42 — کنسول مدیریت');
  console.log('برای خروج exit یا Ctrl+C را بزنید.');
  console.log('مثال: set admin username  |  remove admin username  |  list  |  help');
  console.log('');

  rl.prompt();
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }
    if (['exit', 'quit', '.exit', 'خروج'].includes(text.toLowerCase())) {
      rl.close();
      return;
    }
    if (text === 'clear' || text === 'cls') {
      console.clear();
      rl.prompt();
      return;
    }

    const cleaned = text.replace(/^node\s+cli(?:\.js)?\s*/i, '');
    const parts = cleaned.split(/\s+/).filter(Boolean);
    try {
      execute(parts);
    } catch (err) {
      console.error(`✖ ${err.message}`);
    }
    rl.prompt();
  });
  rl.on('SIGINT', () => rl.close());
  rl.on('close', () => {
    console.log('خروج.');
    process.exit(0);
  });
}

if (forceInteractive || (!argv.length && process.stdin.isTTY)) {
  startRepl();
} else {
  try {
    execute(argv);
  } catch (err) {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  }
}

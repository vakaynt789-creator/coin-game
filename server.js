
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data.json');

// Токен бота Telegram (для проверки подписи initData Mini App)
const BOT_TOKEN = process.env.BOT_TOKEN || '9083407614:AAGMaFxAt4l8vqsgG_zg_peGc8PytvGZ-Sc';

// Проверяет подпись initData от Telegram Mini App по алгоритму:
// secret = HMAC_SHA256("WebAppData", bot_token)
// hash   = HMAC_SHA256(secret, data_check_string)
function verifyInitData(initData) {
  if (!initData || typeof initData !== 'string') return false;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return false;
  const checkArr = [];
  params.forEach((v, k) => { if (k !== 'hash') checkArr.push(k + '=' + v); });
  const dataCheckString = checkArr.sort().join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN)
    .digest();
  const calcHash = crypto.createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');
  return calcHash === hash;
}

// Пароль для доступа к админ-панели. Задай свой — замени строку ниже.
// Если оставить 'admin', игроки, знающие /admin.html, смогут войти.
// (пароль больше не используется — авторизация по Telegram ID)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin2026';

// Telegram ID, которым разрешён доступ к админ-панели (по данным Mini App).
const ALLOWED_ADMIN_IDS = (process.env.ALLOWED_ADMIN_IDS || '1497464101').split(',').map(s => s.trim()).filter(Boolean);

// Вспомогательная функция: прочитать telegram_id из проверенных initData
function tgIdFromInitData(initData) {
  if (!verifyInitData(initData)) return null;
  try {
    const params = new URLSearchParams(initData);
    const userRaw = params.get('user');
    if (!userRaw) return null;
    const user = JSON.parse(userRaw);
    return String(user.id);
  } catch (e) { return null; }
}

// Простой токен сессии (выдаётся после проверки Telegram ID)
function makeAdminToken() { return crypto.randomBytes(24).toString('hex'); }
let adminToken = null; // активируется при успешной авторизации

// Деньги храним целым числом в единицах 1e-8 (8 знаков после запятой).
// 0.00000003  ->  3 единицы
const UNIT = 1e-8;
const TAP_INCREMENT = 3; // 0.00000003 за тап (в единицах 1e-8)
const BOOSTS_ALLOWED = [1, 1.5, 2, 3, 5]; // допустимые множители буста
const CODE_LENGTH = 18;
// Символы для кода: латиница + цифры (без похожих: 0/O, 1/I)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ================= Хранилище =================
let db = { players: {}, codes: {} };
if (fs.existsSync(DATA_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Не удалось прочитать data.json, создаю новое:', e.message);
  }
}

function saveDb() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

// Онлайн-статус: игрок онлайн, если его lastSeen был недавно
const ONLINE_WINDOW_MS = 60 * 1000; // 1 минута
function isOnline(p) {
  if (!p.lastSeen) return false;
  return (Date.now() - new Date(p.lastSeen).getTime()) < ONLINE_WINDOW_MS;
}

// ================= Утилиты =================
function randomCode(length) {
  const arr = new Uint32Array(length);
  crypto.randomFillSync(arr);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[arr[i] % CODE_ALPHABET.length];
  }
  return code;
}

// гарантируем уникальность кода
function makeUniquePlayerCode() {
  let code;
  do {
    code = randomCode(CODE_LENGTH);
  } while (db.codes[code]);
  return code;
}

function toUnits(str) {
  // новый баланс в единицах
  return Math.max(0, Math.floor(Number(str) || 0));
}

function fmt(units) {
  // из единиц в строку с 8 знаками после запятой
  return (units * UNIT).toFixed(8);
}

// Код игрока -> только латиница/цифры
function sanitizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const c = raw.trim().toUpperCase();
  return /^[A-Z0-9]{18}$/.test(c) ? c : null;
}

function findPlayerByCode(code) {
  // сначала точный код
  if (db.players[code]) return db.players[code];
  // поиск по коду как по ключу в players
  return db.players[code] || null;
}

function getPlayer(code) {
  const c = sanitizeCode(code);
  if (!c) return null;
  return db.players[c] || null;
}

// Статус кода: 'playing' (нейтральный/играющий) или 'prize' (получил приз -> чёрный список)
function codeStatus(code) {
  const s = db.codes[code];
  if (s === 'prize') return 'prize';
  return 'playing';
}

// ================= JSON-ответы =================
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit = 10000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > limit) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

// ================= АПИ =================
async function handleApi(req, res, url) {
  // Админ-авторизация: проверка Telegram ID (из initData Mini App) -> выдаём токен
  if (url.pathname === '/api/admin/login' && req.method === 'POST') {
    const body = await readBody(req);
    const tid = tgIdFromInitData(body.initData);
    if (tid && ALLOWED_ADMIN_IDS.includes(String(tid))) {
      adminToken = makeAdminToken();
      return sendJson(res, 200, { ok: true, token: adminToken });
    }
    return sendJson(res, 403, { error: 'Доступ запрещён: ты не в списке администраторов' });
  }

  // Все остальные /api/admin/* требуют валидный токен
  if (url.pathname.startsWith('/api/admin/')) {
    if (url.pathname === '/api/admin/login') { /* уже обработано */ }
    else {
      const auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      if (!adminToken || auth !== adminToken) {
        return sendJson(res, 401, { error: 'Нет доступа к панели' });
      }
    }
  }

  // Вход по Telegram (Mini App): по telegram_id без ввода ника
  if (url.pathname === '/api/login-tg' && req.method === 'POST') {
    const body = await readBody(req);
    const tgId = String(body.telegram_id || '').trim().slice(0, 40);
    const nick = String(body.nick || 'Игрок').trim().slice(0, 24) || 'Игрок';
    if (!tgId) return sendJson(res, 400, { error: 'Нет данных Telegram' });
    // проверяем подпись initData (передаётся с клиента Mini App)
    if (!verifyInitData(body.initData)) {
      return sendJson(res, 401, { error: 'Недействительные данные Telegram' });
    }

    // ищем игрока по telegram_id в nick или отдельном поле
    let player = Object.values(db.players).find(p => p.tgId === tgId);
    if (!player) {
      // создаём нового игрока по telegram_id
      const code = makeUniquePlayerCode();
      player = {
        code, nick, tgId, balance: 0, taps: 0, boost: 1,
        createdAt: new Date().toISOString(), lastSeen: new Date().toISOString()
      };
      db.players[code] = player;
      db.codes[code] = 'playing';
      saveDb();
      return sendJson(res, 201, {
        ok: true, player: publicPlayer(player), code, balance: fmt(0),
        boost: 1, taps: 0, status: 'playing'
      });
    }
    // обновляем ник/активность существующего
    player.nick = nick; player.lastSeen = new Date().toISOString(); saveDb();
    return sendJson(res, 200, {
      ok: true, player: publicPlayer(player), code: player.code,
      balance: fmt(player.balance), boost: Number(player.boost) || 1,
      taps: player.taps, status: codeStatus(player.code)
    });
  }

  // Вход/создание игрока по нику -> выдаём 18-значный код входа
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    const nick = String(body.nick || '').trim().slice(0, 24);
    if (!nick) return sendJson(res, 400, { error: 'Введите ник' });

    // существующий игрок с таким ником -> возвращаем его код и данные
    let existing = Object.values(db.players).find(p => p.nick.toLowerCase() === nick.toLowerCase());
    if (existing) {
      existing.lastSeen = new Date().toISOString();
      saveDb();
      return sendJson(res, 200, {
        ok: true, player: publicPlayer(existing), code: existing.code,
        balance: fmt(existing.balance), boost: Number(existing.boost) || 1,
        taps: existing.taps, status: codeStatus(existing.code)
      });
    }

    // нового — создаём с кодом входа
    const code = makeUniquePlayerCode();
    const player = {
      code,
      nick,
      balance: 0,
      taps: 0,
      boost: 1,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString()
    };
    db.players[code] = player;
    db.codes[code] = 'playing';
    saveDb();
    return sendJson(res, 201, {
      ok: true, player: publicPlayer(player), code, balance: fmt(0),
      boost: 1, taps: 0, status: 'playing'
    });
  }

  // Тап: увеличиваем баланс на базовой тап * буст (единицы)
  if (url.pathname === '/api/tap' && req.method === 'POST') {
    const body = await readBody(req);
    const code = sanitizeCode(body.code);
    const p = code ? db.players[code] : null;
    if (!p) return sendJson(res, 404, { error: 'Игрок не найден' });
    if (codeStatus(code) === 'prize') {
      return sendJson(res, 403, { error: 'Этот код получил приз и заблокирован' });
    }
    const mult = Number(p.boost) || 1;
    const gain = Math.round(TAP_INCREMENT * mult); // целые единицы
    p.balance += gain;
    p.taps++;
    p.lastSeen = new Date().toISOString();
    saveDb();
    return sendJson(res, 200, { ok: true, balance: fmt(p.balance), taps: p.taps, boost: mult, gain: fmt(gain) });
  }

  // Текущий баланс/профиль
  if (url.pathname === '/api/player' && req.method === 'GET') {
    const code = sanitizeCode(url.searchParams.get('code'));
    const p = code ? db.players[code] : null;
    if (!p) return sendJson(res, 404, { error: 'Игрок не найден' });
    // сам факт запроса = игрок на странице -> отмечаем активность
    p.lastSeen = new Date().toISOString();
    return sendJson(res, 200, {
      ok: true, player: publicPlayer(p), balance: fmt(p.balance),
      boost: Number(p.boost) || 1, taps: p.taps, status: codeStatus(code)
    });
  }

  // ----------------- Админка (панель кодов) -----------------
  if (url.pathname.startsWith('/api/admin/')) {
    return handleAdmin(res, url, req);
  }

  return sendJson(res, 404, { error: 'Не найдено' });
}

function publicPlayer(p) {
  return { nick: p.nick, code: p.code, tgId: p.tgId || null, taps: p.taps, boost: Number(p.boost) || 1, createdAt: p.createdAt, lastSeen: p.lastSeen };
}

async function handleAdmin(res, url, req) {
  // Список всех кодов с балансами, статусом и активностью
  if (url.pathname === '/api/admin/codes' && req.method === 'GET') {
    const list = Object.values(db.players).map(p => ({
      code: p.code, nick: p.nick, balance: fmt(p.balance),
      balanceUnits: p.balance, taps: p.taps, boost: Number(p.boost) || 1,
      status: codeStatus(p.code), online: isOnline(p),
      createdAt: p.createdAt, lastSeen: p.lastSeen
    }));
    list.sort((a, b) => b.balanceUnits - a.balanceUnits);
    return sendJson(res, 200, { ok: true, codes: list });
  }

  // Установить буст игроку: x1, x1.5, x2, x3, x5
  if (url.pathname === '/api/admin/boost' && req.method === 'POST') {
    const body = await readBody(req);
    const code = sanitizeCode(body.code);
    const mult = Number(body.boost);
    if (!code) return sendJson(res, 400, { error: 'Неверный код' });
    if (!BOOSTS_ALLOWED.includes(mult)) {
      return sendJson(res, 400, { error: 'Буст должен быть одним из: ' + BOOSTS_ALLOWED.join(', ') });
    }
    if (!db.players[code]) return sendJson(res, 404, { error: 'Игрок не найден' });
    db.players[code].boost = mult;
    saveDb();
    return sendJson(res, 200, { ok: true, code, boost: mult });
  }

  // Установить число тапов игроку
  if (url.pathname === '/api/admin/taps' && req.method === 'POST') {
    const body = await readBody(req);
    const code = sanitizeCode(body.code);
    const taps = Math.floor(Number(body.taps));
    if (!code) return sendJson(res, 400, { error: 'Неверный код' });
    if (isNaN(taps) || taps < 0) return sendJson(res, 400, { error: 'Число тапов должно быть >= 0' });
    if (!db.players[code]) return sendJson(res, 404, { error: 'Игрок не найден' });
    db.players[code].taps = taps;
    saveDb();
    return sendJson(res, 200, { ok: true, code, taps });
  }

  // Изменить статус кода: 'playing' (нейтральный) или 'prize' (чёрный список)
  if (url.pathname === '/api/admin/status' && req.method === 'POST') {
    const body = await readBody(req);
    const code = sanitizeCode(body.code);
    const status = body.status;
    if (!code) return sendJson(res, 400, { error: 'Неверный код' });
    if (status !== 'playing' && status !== 'prize') {
      return sendJson(res, 400, { error: 'Статус должен быть playing или prize' });
    }
    if (!db.players[code]) return sendJson(res, 404, { error: 'Игрок не найден' });
    db.codes[code] = status;
    saveDb();
    return sendJson(res, 200, { ok: true, code, status });
  }

  // Удалить код полностью
  if (url.pathname === '/api/admin/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const code = sanitizeCode(body.code);
    if (!code || !db.players[code]) return sendJson(res, 404, { error: 'Игрок не найден' });
    delete db.players[code];
    delete db.codes[code];
    saveDb();
    return sendJson(res, 200, { ok: true, deleted: code });
  }

  return sendJson(res, 404, { error: 'Не найдено' });
}

// ================= Статика =================
function serveStatic(req, res, url) {
  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // fallback на index.html для SPA-навигации
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ================= Сервер =================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (e) {
      sendJson(res, 400, { error: e.message || 'Ошибка запроса' });
    }
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log('=========================================');
  console.log('  FG_coin$ — сервер запущен');
  console.log(`  Откройте игру:  http://localhost:${PORT}`);
  console.log(`  Панель кодов:   http://localhost:${PORT}/admin.html`);
  console.log('-----------------------------------------');
  console.log('  Панель кодов открыта без пароля');
  console.log('  Данные сохраняются в data.json');
  console.log('=========================================');
});

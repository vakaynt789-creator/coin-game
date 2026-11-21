# 🪙 Coin Game — Telegram Mini App

Тапалка-кликер с виртуальным балансом. Работает как обычная web-игра и как
Telegram Mini App (автовход по Telegram-аккаунту).

## Что это

- **`server.js`** — Node.js-сервер (без внешних зависимостей, только встроенные модули).
- **`public/`** — игра (`index.html`), логотип, админ-панель (`admin.html`).
- **`data.json`** — данные игроков (создаётся автоматически, если нет).

## Как запустить локально

```bash
npm start
# или
node server.js
```
Открой `http://localhost:3000`.

Админ-панель: `http://localhost:3000/admin.html` (защищена паролем,
`ADMIN_PASSWORD` в `server.js`, значение по умолчанию `admin2026`).

---

## Деплой на Render (бесплатно)

1. Зарегистрируйся/войди на https://render.com (удобно через GitHub).
2. Нажми **New → Web Service**.
3. Подключи GitHub-репозиторий (куда зальёшь файлы этого проекта).
4. Настройки Web Service:
   - **Name:** `coin-game`
   - **Environment:** Node
   - **Region:** Frankfurt (или ближайший)
   - **Build Command:** *(оставь пустым)*
   - **Start Command:** `node server.js`
   - **Plan:** Free
5. Нажми **Create Web Service** → дождись статуса **Live** (~1–2 мин).
6. Получишь адрес вида `https://coin-game.onrender.com`.

### Переменные окружения (по желанию)
Пароль админки: **Environment → New variable** →
`ADMIN_PASSWORD` = `твой_пароль`

---

## Подключение к Telegram (Mini App)

1. Открой **@BotFather**, команда `/newapp`.
2. Укажи:
   - **Title:** Coin Game
   - **Short name:** `coin_game`
   - **Web App URL:** `https://coin-game.onrender.com`
3. Включи кнопку-меню:
   `/mybots` → бот → **Bot Settings** → **Menu Button** → **Set WebApp** → ссылка.
4. Готово — игра откроется кнопкой в чате с ботом.

> Игра внутри Telegram автоматически входит по `telegram_id` (без ввода ника).

---

## Админка на хостинге
`https://coin-game.onrender.com/admin.html` — тоже под паролем.

---

## Примечание о данных на бесплатном плане
Бесплатный Render может перезагружать сервер при простое и хранение `data.json`
не гарантировано. Для постоянных данных подключи базу (Render Postgres) —
по запросу помогу.
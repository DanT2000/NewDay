# Планировщик дня

Веб-приложение для личного планирования: расписание, задачи, привычки, спорт, отслеживание веса и печать A4.

## Стек

- **Backend:** Node.js + Express
- **База данных:** SQLite через `better-sqlite3` — файловая БД, хранится внутри проекта в `data/planner.db`, никакого отдельного сервиса
- **Авторизация:** server-side sessions (express-session + connect-pg-simple), httpOnly cookie, bcrypt
- **Frontend:** чистый HTML + CSS + JavaScript, без фреймворков
- **Deploy:** Docker + docker-compose, совместимо с Coolify

---

## Быстрый старт (локально)

### Требования

- Node.js 18+
- PostgreSQL 14+ (или Docker)

### 1. Клонируйте / распакуйте проект

```bash
cd planner-app
```

### 2. Установите зависимости

```bash
npm install
```

### 3. Создайте файл .env

```bash
cp .env.example .env
```

Отредактируйте `.env`:

```env
NODE_ENV=development
PORT=3000
DB_PATH=./data/planner.db
SESSION_SECRET=your_super_secret_string_here_at_least_32_chars
```

### 4. Запустите

```bash
npm start
```

Миграции применяются автоматически при старте.

Откройте браузер: **http://localhost:3000**

---

## Запуск через Docker Compose (локально)

```bash
# Скопируйте .env
cp .env.example .env

# Сгенерируйте SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# Вставьте результат в .env -> SESSION_SECRET=...

# Запустите
docker compose up --build -d

# Посмотреть логи
docker compose logs -f app
```

Откройте браузер: **http://localhost:3000**

---

## Деплой через Coolify

### 1. Подготовка репозитория

Загрузите проект в Git-репозиторий (GitHub, GitLab, Gitea и т.д.).

### 2. Создание проекта в Coolify

1. Войдите в Coolify
2. **New Resource → Docker Compose**
3. Укажите репозиторий
4. Coolify автоматически найдёт `docker-compose.yml`

### 3. Переменные окружения

В Coolify перейдите в раздел **Environment Variables** и добавьте:

| Переменная | Значение |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `DB_PATH` | `/app/data/planner.db` |
| `SESSION_SECRET` | *(длинная случайная строка)* |

Для генерации SESSION_SECRET:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

> **Данные сохраняются** в Docker volume `planner_data`, смонтированном в `/app/data` — при перезапуске контейнера данные не теряются.

### 4. Домен

В Coolify назначьте домен для сервиса `app` (порт 3000).
Включите HTTPS через Let's Encrypt.

### 5. Деплой

Нажмите **Deploy**. Coolify соберёт один образ (`app`) и смонтирует volume для данных.

---

## Использование

### Регистрация и вход

1. Откройте сайт → вы будете перенаправлены на `/login`
2. Нажмите **Зарегистрироваться** → создайте аккаунт
3. После входа сессия сохраняется на 30 дней

### Импорт дня из JSON

1. Нажмите **↑ Импорт JSON** в боковой панели
2. Вставьте JSON или загрузите файл `.json`
3. Нажмите **Импортировать**

Пример файла: `samples/sample-day.json`

### Печать дня / PDF

**Способ 1:** Кнопка **🖨 Печать** в верхней части дня  
**Способ 2:** Горячая клавиша **P** (английская)  
**Способ 3:** В прогресс-панели справа → **🖨 Печать / PDF**

Откроется страница в формате A4 — используйте **Ctrl+P** / **Cmd+P** для печати или сохранения в PDF.

### Экспорт

- **Скачать день JSON:** в правой панели → **↓ Скачать день JSON**
- **Экспорт всей базы:** кнопка **↓ Экспорт базы** в боковой панели

### Редактирование

- Все поля редактируются прямо на странице (клик → ввод)
- Чекбоксы сохраняются автоматически
- Вес, фокус, заметки — редактируются inline
- Задачи и строки расписания — добавляются и удаляются кнопками

---

## API

| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/auth/register` | Регистрация |
| POST | `/api/auth/login` | Вход |
| POST | `/api/auth/logout` | Выход |
| GET | `/api/auth/me` | Текущий пользователь |
| GET | `/api/days` | Список дней |
| GET | `/api/days/:date` | Получить день |
| POST | `/api/days` | Создать день |
| PUT | `/api/days/:date` | Обновить день |
| DELETE | `/api/days/:date` | Удалить день |
| POST | `/api/days/import` | Импорт (upsert) |
| GET | `/api/days/:date/export` | Скачать день JSON |
| GET | `/api/export/all` | Скачать все дни JSON |

---

## Структура проекта

```
planner-app/
├── server/
│   ├── index.js          # Express app + server start
│   ├── db.js             # PostgreSQL pool + migrations
│   ├── auth.js           # requireAuth middleware
│   ├── validation.js     # Input validation
│   └── routes/
│       ├── auth.js       # Auth routes
│       └── days.js       # Days CRUD routes
├── public/
│   ├── login.html        # Login page
│   ├── register.html     # Register page
│   ├── app.html          # Main app
│   ├── print.html        # A4 print view
│   ├── styles.css        # App styles
│   └── app.js            # Frontend logic
├── samples/
│   └── sample-day.json   # Example day structure
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── package.json
```

---

## Безопасность

- Пароли хранятся как bcrypt-хэш (cost=12)
- Сессия хранится в PostgreSQL, cookie httpOnly
- Каждый пользователь видит только свои дни (user_id проверяется на сервере)
- JSON-импорт валидируется на сервере, ограничен 1 МБ
- Пользовательский контент экранируется при выводе (защита от XSS)

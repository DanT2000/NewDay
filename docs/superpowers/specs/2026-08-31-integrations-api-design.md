# Интеграционный API: source, externalId и /integrations/apply

Дата: 2026-08-31. Статус: одобрено (диалог, включая пять условий заказчика).

## Зачем

Внешние интеграции (ChatGPT, Telegram-бот, Claude и любые другие) пишут в
NewDay через обычный REST, но не могут понять, «их» это запись или человека:
повторный запуск создаёт дубли, а обновление рискует перетереть ручную правку.
Нужна универсальная механика идентичности и идемпотентного применения — не
привязанная к конкретному сервису. После неё интеграции не нужен локальный
state.json: вся правда живёт на сервере.

## Модель данных

Шести сущностям — `schedule_items`, `tasks`, `meals`, `sport_sets`, `habits`,
`series` — добавляются колонки:

- `source TEXT NULL` — кто создал запись (`chatgpt`, `telegram`, …). NULL —
  запись человека.
- `external_id TEXT NULL` — стабильный идентификатор записи на стороне
  интеграции.
- `last_modified_by TEXT NOT NULL DEFAULT 'user'` — кто менял последним:
  `user` либо имя source.

`created_at`/`updated_at` во всех шести таблицах уже есть и отдаются наружу.

Уникальность — частичные индексы (`WHERE source IS NOT NULL`):

- строки дня: `UNIQUE (user_id, date, source, external_id)`;
- привычки и series: `UNIQUE (user_id, source, external_id)`.

**Неизменяемость.** `source` и `external_id` после создания не меняются никогда
и никаким путём — это идентичность записи. Ни `/integrations/apply`, ни обычные
PATCH их не принимают.

**Авторство.** Запись пришла через `/integrations/apply` →
`last_modified_by = source`. Запись изменена любым другим путём — сайт,
приложение, обычный API, даже с тем же токеном — `last_modified_by = 'user'`.

## Надгробия (integration_tombstones)

Человек удалил запись, созданную интеграцией, — интеграция не вправе её
воскресить. Таблица:

```
integration_tombstones (
  user_id, entity, date NULL, source, external_id, created_at,
  UNIQUE (user_id, entity, date, source, external_id)
)
```

- Ставится при удалении записи с `source` любым «человеческим» путём
  (DELETE строки, PUT дня целиком, архив/удаление привычки, удаление series).
- `apply` по записи с надгробием отвечает `conflict / removed_by_user` и ничего
  не создаёт.
- Снять надгробие явно: `DELETE /api/v1/integrations/tombstones` c
  `{ source, entity, externalId, date? }` — для случая «человек передумал и
  хочет запись обратно». Удаление интеграцией собственной записи через
  `delete: true` надгробия НЕ ставит.

## POST /api/v1/integrations/apply

Авторизация: обычный Bearer-токен со scope `write` (или сессия/устройство).

```json
{
  "source": "chatgpt",
  "dryRun": false,
  "items": [
    { "entity": "schedule", "externalId": "evt-42", "date": "2026-09-01",
      "data": { "time": "9:00-10:30", "title": "Отчёт", "alarmMode": "notify" } },
    { "entity": "habit", "externalId": "h-1", "data": { "title": "Вода" } },
    { "entity": "task", "externalId": "t-9", "date": "2026-09-01", "delete": true }
  ]
}
```

- `source`: обязателен, ≤ 64 символов, только `[a-zA-Z0-9._-]`. Иначе 400.
- `items`: 1..100. `entity` ∈ schedule | task | meal | sport | habit | series.
  Строкам дня обязателен `date`.
- `data` — **PATCH-семантика**: применяются только переданные поля, поля тех же
  имён и правил, что у обычных POST/PATCH соответствующей сущности (включая
  `time` строкой у расписания). Непереданное поле не трогается — интеграция,
  не приславшая `color`, его не сотрёт.

Исход по каждому элементу (запись ищется по user + source + externalId
[+ date у строк дня]):

| Ситуация | Исход |
|---|---|
| записи нет, `delete` нет | создать → `created` |
| записи нет, надгробие есть | `conflict` / `removed_by_user` |
| записи нет, `delete: true` | `unchanged` (идемпотентность) |
| есть, `last_modified_by == source`, тело совпало | `unchanged` |
| есть, `last_modified_by == source`, тело отличается | обновить → `updated` |
| есть, `last_modified_by == 'user'` или другой source | `conflict` / `modified_by_user` + `current` |
| есть, `delete: true`, правил только source | удалить → `deleted` |
| есть, `delete: true`, правил человек/другой | `conflict` / `modified_by_user` + `current` |

Каждый `conflict` обязан нести причину:

```json
{ "status": "conflict", "reason": "modified_by_user", "current": { … } }
{ "status": "conflict", "reason": "removed_by_user" }
```

Ответ целиком:

```json
{
  "dryRun": false,
  "results": [{ "entity", "externalId", "date", "status", "reason?", "id?", "current?" }],
  "counts": { "created": 1, "updated": 0, "unchanged": 1, "deleted": 1, "conflict": 0 }
}
```

- Повторный одинаковый запрос дублей не создаёт (идемпотентность по ключу
  идентичности + сравнение тел).
- `dryRun: true` — те же исходы, ни одной записи в базу.
- Весь батч применяется в одной транзакции записи; conflict элемента не
  останавливает остальные.
- После настоящих (не dryRun) изменений `schedule`/`meal` — пересчёт очереди
  уведомлений (`planUpcoming`, как `/push/replan`).

## Особенности сущностей

- `series`: правка правила не переписывает уже материализованные дни — та же
  семантика, что у ручной правки повтора. Повтору обязателен `startDate`
  (как в обычном POST /series), шаблону — `name`.
- `habit`: сущность — сама привычка; отметки журнала интеграция ставит
  существующим `PUT /habits/{id}/log/{date}`. `delete: true` архивирует
  (мягкое удаление, как в UI).
- Материализация повторов и шаблона создаёт строки как `user` (это действия
  системы от имени человека).

## Что снаружи

- `GET`-ответы всех шести сущностей отдают `source`, `external_id`,
  `last_modified_by`, `created_at`, `updated_at` (колонки и так уезжают через
  `SELECT *`).
- OpenAPI: пути `/integrations/apply`, `/integrations/tombstones`.
- docs/api.md: раздел «Интеграции».

## Тесты (test/api/integrations.test.js)

создание · идемпотентный повтор → unchanged · PATCH-обновление не трогает
непереданные поля · conflict modified_by_user после ручной правки ·
надгробие после ручного удаления → conflict removed_by_user · снятие
надгробия возвращает возможность создать · delete: true своих /
чужих записей · dryRun ничего не пишет · валидация source · лимит 100 ·
уникальность (две записи с одним externalId невозможны) · habits/series
создание и обновление · scope read получает 403.

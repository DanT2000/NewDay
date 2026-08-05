/**
 * Экран «Настройки» по эталонному макету.
 *
 * Структура и размеры взяты из прототипа: карточка аккаунта, затем группы
 * «оформление», «питание», «день», «звуки», «устройства», «приложение».
 * Внутри группы — строки 15/12 с переключателем или шевроном; всё
 * редактирование в нижних шторках.
 *
 * Раздел «помощник» виден только администратору: ИИ подключается один раз
 * на весь экземпляр, ключ — секрет владельца, и в обычном профиле этому
 * разделу делать нечего.
 */

import './theme.js';
import { h, add, replace, $ } from './dom.js';
import { icon } from './vendor/icons.js';
import { bottomNav } from './shell.js';
import * as api from './api.js';
import { toast } from './toast.js';
import { openSheet, confirmSheet } from './components/sheet.js';
import {
  ACCENTS, getTheme, setTheme, getAccent, setAccent, THEME_LABEL,
} from './theme.js';
import * as push from './push.js';
import * as native from './native.js';
import * as appUpdate from './update.js';
import { formatShort } from './dates.js';

let profile = null;
let devices = [];
let tokens = [];
let aiCfg = null;      // только у администратора
let col;

// ── Строительные блоки эталона ───────────────────────────────

const group = (label, ...children) =>
  h('div', h('div.rgroup-label', { text: label }), ...children);

const card = (...children) => h('div.rcard', ...children);
const cardPad = (...children) => h('div.rcard.pad', ...children);

/** Строка с переключателем. */
function switchRow(label, hint, on, onChange) {
  const sw = h('button.rswitch', {
    type: 'button', role: 'switch',
    'aria-checked': on ? 'true' : 'false',
    'aria-label': label,
  }, h('i'));
  const row = h('button.rrow', {
    type: 'button',
    onclick: () => {
      const next = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', next ? 'true' : 'false');
      onChange(next);
    },
  });
  add(row,
    h('div.rrow-body',
      h('div.rrow-title', { text: label }),
      hint ? h('div.rrow-hint', { text: hint }) : null),
    sw);
  return row;
}

/** Строка со шевроном: ведёт в шторку. */
function linkRow(label, { hint, value, iconName, accentIcon = false, onclick, accentText = false } = {}) {
  const row = h('button.rrow', { type: 'button', class: accentText ? 'is-accent' : '', onclick });
  add(row,
    iconName ? icon(iconName, { size: '18px', cls: `rrow-ico${accentIcon ? ' is-accent' : ''}` }) : null,
    h('div.rrow-body',
      h('div.rrow-title', { text: label }),
      hint ? h('div.rrow-hint', { text: hint }) : null),
    value ? h('span.rrow-value', { text: value }) : null,
    icon('caret-right', { size: '15px', cls: 'rrow-chev' }));
  return row;
}

/** Сегмент из нескольких вариантов. */
function segment(options, current, onPick) {
  const box = h('div.rseg');
  add(box, ...options.map(([value, label]) => h('button', {
    type: 'button', text: label,
    'aria-pressed': value === current ? 'true' : 'false',
    onclick: e => {
      [...e.currentTarget.parentNode.children].forEach(n => n.setAttribute('aria-pressed', 'false'));
      e.currentTarget.setAttribute('aria-pressed', 'true');
      onPick(value);
    },
  })));
  return box;
}

// ── Группы экрана ────────────────────────────────────────────

function accountCard() {
  const row = h('button.raccount', { type: 'button', onclick: openAccount });
  const avatar = h('span.ravatar');
  add(avatar, icon('user', { size: '19px' }));
  add(row, avatar,
    h('div', { style: { flex: '1', minWidth: '0' } },
      h('div.rrow-title', { text: profile.email || profile.username }),
      h('div.rrow-hint', { text: profile.isAdmin ? 'администратор' : 'аккаунт' })));
  return row;
}

function appearanceGroup() {
  const swatches = h('div.rswatches');
  add(swatches, ...ACCENTS.map(a => {
    const btn = h('button.rswatch', {
      type: 'button', title: a.label,
      'aria-pressed': a.key === getAccent() ? 'true' : 'false',
      onclick: () => { setAccent(a.key); render(); },
    });
    const sw = h('i', { style: { background: 'var(--accent-preview)' } });
    // цвет свотча — свой, не текущий акцент: иначе все четыре одинаковые
    sw.style.setProperty('background', document.documentElement.dataset.theme === 'dark' ? a.dark : a.light);
    sw.style.setProperty('color', document.documentElement.dataset.theme === 'dark' ? a.dark : a.light);
    add(sw, icon('check-bold', { size: '16px' }));
    add(btn, sw, h('span', { text: a.label }));
    return btn;
  }));

  return group('оформление', cardPad(
    h('div.rrow-title', { text: 'Тема' }),
    segment([['system', 'Система'], ['light', 'Светлая'], ['dark', 'Тёмная']],
      getTheme(), v => { setTheme(v); render(); }),
    h('div.rrow-title', { text: 'Цвет приложения', style: { marginTop: '20px' } }),
    swatches));
}

const FOOD_SWITCHES = [
  ['slots', 'Делить на приёмы пищи', 'завтрак, обед, ужин, перекус — иначе один список'],
  ['kcal', 'Показывать калории', 'счётчик и дневная цель'],
  ['toSched', 'Питание со временем — в расписание', 'приём пищи с точным временем займёт блок'],
];

function foodGroup() {
  const s = profile.settings || {};
  const box = card();
  add(box, ...FOOD_SWITCHES.map(([key, label, hint]) =>
    switchRow(label, hint, s[`food_${key}`] !== false && s[`food_${key}`] !== undefined ? Boolean(s[`food_${key}`]) : key === 'slots',
      val => saveSettings({ [`food_${key}`]: val }))));
  return group('питание', box);
}

const DAY_SWITCHES = [
  ['carry', 'Переносить невыполненное на завтра', 'задачи, которые остались неотмеченными'],
  ['template', 'Заполнять новый день общим расписанием', 'шаблон подставляется, когда день пустой'],
];

function dayGroup() {
  const s = profile.settings || {};
  const box = card();
  add(box,
    ...DAY_SWITCHES.map(([key, label, hint]) =>
      switchRow(label, hint, Boolean(s[`day_${key}`]), val => saveSettings({ [`day_${key}`]: val }))),
    linkRow('Общее расписание', {
      hint: 'шаблон без дат — подставляется в новые дни',
      iconName: 'calendar-check', accentIcon: true,
      onclick: () => toast('Общее расписание — следующий этап переноса'),
    }));
  return group('день', box);
}

function notifyGroup() {
  const perm = push.permission();
  const box = card();

  add(box, linkRow('Уведомления в браузере', {
    hint: perm === 'granted' ? 'разрешены' : perm === 'denied' ? 'заблокированы в браузере' : 'не спрошены',
    iconName: 'bell', accentIcon: true,
    value: perm === 'granted' ? 'вкл' : '',
    onclick: async () => {
      if (perm === 'granted') { await push.sendTest(); toast('Отправил проверочное'); return; }
      const res = await push.enable();
      if (res.ok) { toast('Уведомления включены'); render(); }
      else toast('Не получилось включить уведомления', 'error');
    },
  }));

  if (native.available()) {
    add(box, linkRow('Будильник', {
      hint: 'разрешения и проверка на этом телефоне',
      iconName: 'alarm-fill', accentIcon: true,
      onclick: () => { location.href = '/settings.html#alarm'; },
    }));
  }
  return group('уведомления', box);
}

function devicesGroup() {
  const box = card();
  add(box, ...devices.map(d => {
    const row = h('div.rrow');
    add(row,
      icon(d.platform === 'android' ? 'device-mobile' : 'laptop', { size: '18px', cls: 'rrow-ico' }),
      h('div.rrow-body',
        h('div.rrow-title', { text: d.name || 'Устройство' }),
        h('div.rrow-hint', { text: d.last_seen_at ? `был ${formatShort(d.last_seen_at.slice(0, 10))}` : 'ещё не заходил' })),
      h('button.rtag', {
        type: 'button', text: 'отозвать',
        onclick: async () => {
          const ok = await confirmSheet('Отозвать устройство?',
            `«${d.name || 'Устройство'}» потеряет доступ немедленно.`, { okText: 'Отозвать' });
          if (!ok) return;
          try { await api.devices.revoke(d.id); await reload(); toast('Отозвано'); }
          catch (e) { toast(e.message, 'error'); }
        },
      }));
    return row;
  }));
  add(box, linkRow('Показать код входа', {
    iconName: 'scan', accentIcon: true, accentText: true, onclick: openPairing,
  }));
  return group('устройства', box);
}

function appGroup() {
  const box = card();
  add(box,
    linkRow('Печать дня', { iconName: 'printer', onclick: () => { location.href = '/app.html'; } }),
    linkRow('Экспорт данных', { iconName: 'file-arrow-down', onclick: openExport }),
    linkRow('Импорт данных', { iconName: 'file-arrow-up', onclick: openImport }),
    linkRow('Доступ для ботов', { iconName: 'key', value: tokens.length ? `${tokens.length}` : '', onclick: openTokens }));
  return group('приложение', box);
}

function versionGroup() {
  const box = card();
  const row = linkRow('Версия и обновление', {
    iconName: 'arrows-clockwise', onclick: openVersion,
  });
  add(box, row);
  return group('о приложении', box);
}

// ── Помощник: только для администратора ──────────────────────

/**
 * Подключение стандартное: адрес, совместимый с OpenAI, ключ и модель.
 * Так подходят и OpenAI, и AI Tunnel, и локальная LM Studio — путь
 * /v1/chat/completions у всех одинаковый.
 *
 * Настройка одна на весь экземпляр: владелец подключает свой ИИ, и он
 * работает у всех, кому владелец дал доступ. Поэтому в обычном профиле
 * раздела нет вовсе.
 */
function aiGroup() {
  if (!profile.isAdmin) return null;
  const box = card();
  add(box, linkRow('Подключение ИИ', {
    iconName: 'sparkle-fill', accentIcon: true,
    hint: aiCfg?.ready
      ? `${aiCfg.model} · ${hostOf(aiCfg.baseUrl)}`
      : 'адрес, ключ и модель — один раз на всех',
    value: aiCfg?.ready ? 'вкл' : 'выкл',
    onclick: openAi,
  }));
  return group('помощник · только для админа', box,
    h('div.rnote', { text: 'Ключ виден только вам и наружу не отдаётся. Помощник станет доступен всем пользователям этого сервера.' }));
}

const hostOf = url => { try { return new URL(url).host; } catch { return url; } };

const AI_PRESETS = [
  { label: 'AI Tunnel', url: 'https://api.aitunnel.ru/v1', model: 'gpt-4o-mini' },
  { label: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'LM Studio', url: 'http://localhost:1234/v1', model: '' },
];

function openAi() {
  let draft = {
    baseUrl: aiCfg?.baseUrl || '',
    model: aiCfg?.model || '',
    apiKey: '',
    enabled: Boolean(aiCfg?.enabled),
  };

  openSheet('Подключение ИИ', (body, { close }) => {
    const urlInput = h('input.rinput', {
      value: draft.baseUrl, placeholder: 'https://api.aitunnel.ru/v1',
      inputMode: 'url', 'aria-label': 'Адрес API',
      oninput: e => { draft.baseUrl = e.target.value.trim(); },
    });
    const keyInput = h('input.rinput', {
      type: 'password', value: '',
      placeholder: aiCfg?.hasKey ? `сохранён, оканчивается на ${aiCfg.keyTail}` : 'sk-…',
      'aria-label': 'Ключ',
      oninput: e => { draft.apiKey = e.target.value; },
    });
    const modelInput = h('input.rinput', {
      value: draft.model, placeholder: 'gpt-4o-mini',
      'aria-label': 'Модель',
      oninput: e => { draft.model = e.target.value.trim(); },
    });
    const result = h('div.rnote');

    const presets = h('div.rchips');
    add(presets, ...AI_PRESETS.map(p => h('button.rchip', {
      type: 'button', text: p.label,
      onclick: () => {
        urlInput.value = p.url; draft.baseUrl = p.url;
        if (p.model) { modelInput.value = p.model; draft.model = p.model; }
      },
    })));

    add(body, h('div.stack',
      h('div', h('span.rfield-label', { text: 'готовые адреса' }), presets),
      h('div', h('span.rfield-label', { text: 'адрес api' }), urlInput),
      h('div', h('span.rfield-label', { text: 'ключ' }), keyInput,
        h('div.rnote', { text: 'Пустое поле — оставить прежний ключ.' })),
      h('div', h('span.rfield-label', { text: 'модель' }), modelInput),
      switchRow('Помощник включён', 'выключенный ИИ не показывается пользователям',
        draft.enabled, v => { draft.enabled = v; }),
      result,
      h('div.row', { style: { gap: 'var(--s-2)' } },
        h('button.btn', {
          type: 'button', text: 'Проверить связь',
          onclick: async () => {
            result.textContent = 'Проверяю…';
            try {
              await api.PATCH('/admin/ai', { baseUrl: draft.baseUrl, apiKey: draft.apiKey, model: draft.model });
              draft.apiKey = ''; keyInput.value = '';
              const r = await api.POST('/admin/ai/test', {});
              result.textContent = r.ok
                ? `Связь есть, ${r.ms} мс${r.models?.length ? `. Моделей доступно: ${r.models.length}` : ''}`
                : `Не вышло: ${r.message}`;
              if (r.ok && r.models?.length && !draft.model) {
                modelInput.value = r.models[0]; draft.model = r.models[0];
              }
            } catch (e) { result.textContent = e.message; }
          },
        }),
        aiCfg?.hasKey
          ? h('button.btn.btn-danger', {
              type: 'button', text: 'Удалить ключ',
              onclick: async () => {
                await api.PATCH('/admin/ai', { apiKey: null });
                aiCfg = await api.GET('/admin/ai');
                result.textContent = 'Ключ удалён';
              },
            })
          : null),
      h('button.btn-sheet', {
        text: 'Сохранить',
        onclick: async () => {
          try {
            aiCfg = await api.PATCH('/admin/ai', draft);
            close();
            toast(aiCfg.ready ? 'ИИ подключён' : 'Сохранено');
            render();
          } catch (e) { toast(e.message, 'error'); }
        },
      })));
  });
}

// ── Шторки прочих разделов ───────────────────────────────────

function openAccount() {
  openSheet(profile.email || profile.username, (body, { close }) => {
    add(body, h('div.stack',
      h('div.rnote', { text: profile.isAdmin ? 'Вы администратор этого сервера.' : 'Обычный аккаунт.' }),
      h('button.btn.btn-block', {
        text: 'Сменить пароль',
        onclick: () => { close(); openPasswordChange(); },
      }),
      h('button.btn.btn-block.btn-danger', {
        text: 'Выйти из аккаунта',
        onclick: async () => { await api.logout(); location.href = '/login.html'; },
      })));
  });
}

/**
 * Смена пароля. Текущий спрашиваем, хотя человек уже вошёл: сессия могла
 * остаться открытой на чужом устройстве, и тогда смена пароля без
 * подтверждения — способ отобрать аккаунт, а не защитить его.
 */
function openPasswordChange() {
  openSheet('Смена пароля', (body, { close }) => {
    const cur = h('input.rinput', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Текущий пароль' });
    const next = h('input.rinput', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Новый пароль' });
    const err = h('div.rnote');

    add(body, h('div.stack',
      h('div', h('span.rfield-label', { text: 'текущий пароль' }), cur),
      h('div', h('span.rfield-label', { text: 'новый пароль' }), next,
        h('div.rnote', { text: 'Не короче восьми символов.' })),
      err,
      h('button.btn-sheet', {
        text: 'Сохранить',
        onclick: async () => {
          err.textContent = '';
          try {
            await api.changePassword(cur.value, next.value);
            close();
            toast('Пароль изменён');
          } catch (e) { err.textContent = e.message; }
        },
      })));
    cur.focus();
  });
}

async function openPairing() {
  try {
    const { code, shortCode } = await api.devices.pair();
    const { qrSvg } = await import('./qr.js');
    openSheet('Код для входа', body => {
      add(body, h('div.stack', { style: { alignItems: 'center' } },
        qrSvg(`${location.origin}/pair#${code}`, { size: 200 }),
        h('div.rnote', { text: 'Наведите камеру приложения. Код живёт две минуты.' }),
        h('div', { text: shortCode, style: { font: 'var(--t-num)', letterSpacing: '.2em' } })));
    });
  } catch (e) { toast(e.message, 'error'); }
}

function openExport() {
  openSheet('Экспорт данных', (body, { close }) => {
    add(body, h('div.stack',
      h('div.rnote', { text: 'Своя выгрузка — это всё: дни, привычки, отметки и повторы. Календарь (.ics) открывается в любом календаре.' }),
      h('a.btn-sheet', {
        href: '/api/v1/export?download=1', download: '',
        text: 'Скачать JSON', style: { display: 'grid', placeItems: 'center', textDecoration: 'none' },
        onclick: () => setTimeout(close, 300),
      }),
      h('a.btn.btn-block', { href: '/api/v1/export.ics', download: '', text: 'Скачать календарь (.ics)' })));
  });
}

function openImport() {
  let file = null;
  let mode = 'merge';
  openSheet('Импорт данных', (body, { close }) => {
    const name = h('span.rrow-hint', { text: 'Файл не выбран' });
    const input = h('input', {
      type: 'file', accept: 'application/json,.json', class: 'sr-only',
      onchange: e => { file = e.target.files[0] || null; name.textContent = file ? file.name : 'Файл не выбран'; },
    });
    add(body, h('div.stack',
      input,
      h('div.row', { style: { gap: 'var(--s-2)' } },
        h('button.btn', { type: 'button', text: 'Выбрать файл', onclick: () => input.click() }), name),
      h('div', h('span.rfield-label', { text: 'как загружать' }),
        segment([['merge', 'Добавить к текущим'], ['replace', 'Заменить всё']], mode, v => { mode = v; })),
      h('button.btn-sheet', {
        text: 'Загрузить',
        onclick: async () => {
          if (!file) { toast('Выберите файл', 'error'); return; }
          if (mode === 'replace') {
            const ok = await confirmSheet('Заменить все данные?',
              'Текущие дни, привычки и отметки будут стёрты.', { okText: 'Заменить' });
            if (!ok) return;
          }
          try {
            await api.importAll(JSON.parse(await file.text()), mode);
            close(); toast('Данные загружены'); await reload();
          } catch (e) { toast(e.message || 'Не удалось прочитать файл', 'error'); }
        },
      })));
  });
}

function openTokens() {
  openSheet('Доступ для ботов', (body) => {
    const list = h('div.stack');
    const draw = () => replace(list, ...(tokens.length
      ? tokens.map(t => {
          const row = h('div.rrow');
          add(row,
            h('div.rrow-body',
              h('div.rrow-title', { text: t.name || 'Токен' }),
              h('div.rrow-hint', { text: `${t.scope === 'write' ? 'чтение и запись' : 'только чтение'} · ${t.prefix}…` })),
            h('button.rtag', {
              type: 'button', text: 'удалить',
              onclick: async () => {
                await api.tokens.revoke(t.id);
                tokens = await api.tokens.list();
                draw();
              },
            }));
          return row;
        })
      : [h('div.rnote', { text: 'Токенов нет. Он нужен, чтобы бот или нейросеть заполняли день за вас.' })]));
    draw();

    add(body, h('div.stack',
      list,
      h('button.btn-sheet', {
        text: 'Создать токен',
        onclick: async () => {
          try {
            const t = await api.tokens.create('Бот', 'write');
            tokens = await api.tokens.list();
            draw();
            openSheet('Токен создан', b => {
              add(b, h('div.stack',
                h('div.rnote', { text: 'Показывается один раз: сервер хранит только его хеш.' }),
                h('textarea.rinput', { value: t.token, readonly: true, rows: 3 })));
            });
          } catch (e) { toast(e.message, 'error'); }
        },
      })));
  });
}

function openVersion() {
  openSheet('Версия и обновление', (body) => {
    const line = h('div.rnote', { text: 'Проверяю…' });
    add(body, h('div.stack', line));
    (async () => {
      const [me, top] = await Promise.all([appUpdate.installed(), appUpdate.latest()]);
      const parts = [];
      if (me) parts.push(`установлена ${me.versionName}`);
      parts.push(top ? `на сервере ${top.versionName}` : 'на сервере версия не выложена');
      line.textContent = parts.join(' · ');
      if (me && top && Number(top.versionCode) > Number(me.versionCode)) {
        add(body.firstChild, h('button.btn-sheet', {
          text: `Обновить до ${top.versionName}`, onclick: () => appUpdate.offer(me, top),
        }));
      }
    })();
  });
}

// ── Сохранение и загрузка ────────────────────────────────────

async function saveSettings(patch) {
  try {
    profile = { ...profile, settings: { ...(profile.settings || {}), ...patch } };
    await api.saveSettings({ settings: patch });
    await native.pushAlarmConfig(profile);
  } catch (e) { toast(e.message, 'error'); }
}

function render() {
  replace(col,
    h('div.rtitle', { text: 'Настройки' }),
    accountCard(),
    appearanceGroup(),
    aiGroup(),
    notifyGroup(),
    foodGroup(),
    dayGroup(),
    devicesGroup(),
    appGroup(),
    versionGroup());
}

async function reload() {
  [profile, tokens, devices] = await Promise.all([
    api.getSettings(),
    api.tokens.list().catch(() => []),
    api.devices.list().catch(() => []),
  ]);
  if (profile.isAdmin) {
    aiCfg = await api.GET('/admin/ai').catch(() => null);
  }
  render();
}

function layout() {
  const c = h('div.rscreen', { id: 'settings-col' });
  replace($('#app'), c, bottomNav('settings'));
  return c;
}

async function boot() {
  col = layout();
  try { await reload(); }
  catch (e) { toast(e.message, 'error'); }
}

boot();

if (location.search.includes('diag=1')) import('./dev-overflow.js');

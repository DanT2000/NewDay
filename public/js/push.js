/**
 * Подписка браузера на уведомления.
 *
 * Разрешение не спрашивается при загрузке страницы: браузеры такое наказывают,
 * а человек, не понимающий, зачем его спросили, жмёт «Блокировать» навсегда.
 * Спрашиваем только по явному нажатию в настройках.
 */

import * as api from './api.js';

const urlBase64ToUint8Array = base64 => {
  const padded = (base64 + '='.repeat((4 - base64.length % 4) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
};

export const supported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export function permission() {
  if (!supported()) return 'unsupported';
  return Notification.permission;   // default | granted | denied
}

/**
 * Зарегистрированный service worker — или отказ по времени.
 *
 * `navigator.serviceWorker.ready` — обещание, которое никогда не разрешится,
 * если worker не зарегистрирован: в вебвью приложения, на странице, где
 * регистрация не прошла, в приватном окне. Нажатие «Разрешить уведомления»
 * при этом висело молча — ни ответа, ни сообщения. Ждём не дольше пяти
 * секунд: дольше регистрация всё равно не идёт.
 */
async function registration() {
  const ждать = new Promise((_, отказ) => {
    setTimeout(() => отказ(new Error('Уведомления в этом окне недоступны')), 5000);
  });
  return Promise.race([navigator.serviceWorker.ready, ждать]);
}

export async function currentSubscription() {
  if (!supported()) return null;
  const reg = await registration();
  return reg.pushManager.getSubscription();
}

/**
 * Запрашивает разрешение и подписывает браузер.
 * @returns { ok } либо { ok: false, reason }
 */
export async function enable() {
  if (!supported()) return { ok: false, reason: 'UNSUPPORTED' };

  const { enabled, publicKey } = await api.GET('/push/key');
  if (!enabled) return { ok: false, reason: 'SERVER_DISABLED' };

  const granted = await Notification.requestPermission();
  if (granted !== 'granted') return { ok: false, reason: 'DENIED' };

  const reg = await registration();
  const sub = await reg.pushManager.getSubscription()
    ?? await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

  await api.POST('/push/subscribe', { subscription: sub.toJSON() });
  return { ok: true };
}

export async function disable() {
  const sub = await currentSubscription();
  if (!sub) return { ok: true };
  /*
   * Отказ не проглатываем молча: «Отключить» должно либо отключить, либо
   * сказать, что не вышло. Раньше здесь стоял пустой catch, и экран после
   * неудачи снова показывал «этот браузер подписан» — человек нажимал ещё
   * раз с тем же исходом.
   */
  let серверЗнает = true;
  try {
    await api.DELETE_BODY('/push/subscribe', { endpoint: sub.endpoint });
  } catch (e) {
    // 404 значит, что на сервере подписки и так нет: цель достигнута
    if (e?.status !== 404) серверЗнает = false;
  }
  await sub.unsubscribe().catch(() => {});
  return серверЗнает ? { ok: true } : { ok: false, reason: 'SERVER_KEPT' };
}

export const status = () => api.GET('/push/status');
export const sendTest = () => api.POST('/push/test');

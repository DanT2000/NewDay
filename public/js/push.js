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

async function registration() {
  return navigator.serviceWorker.ready;
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
  await api.DELETE('/push/subscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
  return { ok: true };
}

export const status = () => api.GET('/push/status');
export const sendTest = () => api.POST('/push/test');

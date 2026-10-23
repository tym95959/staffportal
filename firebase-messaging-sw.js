// Push notification service worker (Firebase Cloud Messaging).
// Must live at the site root. Config is shared with the pages via /js/config.js.
importScripts('/js/config.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp(self.FIREBASE_CONFIG);
const messaging = firebase.messaging();

// Messages with a `notification` payload are shown automatically while the app is in the background.
// This handles data-only messages, just in case.
messaging.onBackgroundMessage(payload => {
  if (payload.notification) return;
  const d = payload.data || {};
  self.registration.showNotification(d.title || 'Staff Portal', { body: d.body || '', icon: '/icons/icon-192.png', data: { link: d.link || '/dashboard.html' } });
});

self.addEventListener('notificationclick', event => {
  const link = event.notification?.data?.link || event.notification?.data?.FCM_MSG?.data?.link || '/dashboard.html';
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.navigate(link); return c.focus(); } }
    return clients.openWindow(link);
  }));
});

/* eslint-disable no-undef */
// MeriBaari — Background Web Push Service Worker
// Compatible with Firebase Cloud Messaging (FCM) and standard W3C Web Push

importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

// Parse Firebase config from SW registration URL query params if provided
try {
  const urlParams = new URL(self.location.href).searchParams;
  const config = {
    apiKey: urlParams.get('apiKey'),
    authDomain: urlParams.get('authDomain'),
    projectId: urlParams.get('projectId'),
    storageBucket: urlParams.get('storageBucket'),
    messagingSenderId: urlParams.get('messagingSenderId'),
    appId: urlParams.get('appId'),
  };

  if (config.apiKey && config.projectId) {
    firebase.initializeApp(config);
  }
} catch (e) {
  // Config may be provided via message event
}

let messaging = null;
try {
  if (firebase && firebase.messaging && firebase.messaging.isSupported()) {
    messaging = firebase.messaging();
  }
} catch (e) {
  console.log('[MeriBaari SW] Firebase messaging initialization skipped:', e);
}

// Background push notification handler via FCM SDK
if (messaging) {
  messaging.onBackgroundMessage((payload) => {
    const title = payload.notification?.title || payload.data?.title || 'MeriBaari — Live Queue Update';
    const body = payload.notification?.body || payload.data?.body || 'Your appointment queue status has updated.';
    const actionUrl = payload.data?.url || '/patient/queue';
    const tag = payload.data?.tag || 'meribaari-queue';

    const options = {
      body: body,
      icon: '/assets/images/icon.png',
      badge: '/assets/images/favicon.png',
      tag: tag,
      renotify: true,
      requireInteraction: true,
      vibrate: [200, 100, 200],
      data: {
        url: actionUrl,
        ...payload.data,
      },
    };

    return self.registration.showNotification(title, options);
  });
}

// Standard Web Push fallback handler
self.addEventListener('push', (event) => {
  if (!event.data) return;
  try {
    const json = event.data.json();
    const title = json.notification?.title || json.data?.title || 'MeriBaari — Live Queue Update';
    const body = json.notification?.body || json.data?.body || '';
    const actionUrl = json.data?.url || json.url || '/patient/queue';
    const tag = json.data?.tag || 'meribaari-queue';

    const options = {
      body: body,
      icon: '/assets/images/icon.png',
      badge: '/assets/images/favicon.png',
      tag: tag,
      renotify: true,
      requireInteraction: true,
      vibrate: [200, 100, 200],
      data: {
        url: actionUrl,
        ...json.data,
      },
    };

    event.waitUntil(self.registration.showNotification(title, options));
  } catch {
    const text = event.data.text();
    event.waitUntil(
      self.registration.showNotification('MeriBaari Live Queue', {
        body: text,
        icon: '/assets/images/icon.png',
        badge: '/assets/images/favicon.png',
        data: { url: '/patient/queue' },
      })
    );
  }
});

// Notification click event: focus or open the live queue page
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/patient/queue';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // 1. Check if a tab with this exact URL is already open
      for (const client of windowClients) {
        if (client.url && client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      // 2. Check if any MeriBaari window is open, focus and navigate it
      for (const client of windowClients) {
        if ('focus' in client && 'navigate' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      // 3. Otherwise open a new window
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

// Self-skip waiting on new service worker installation
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

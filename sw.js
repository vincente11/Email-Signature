"use strict";

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch (error) {
    console.error("Push notification payload was invalid JSON:", error);
    return;
  }

  const title = typeof payload.title === "string" ? payload.title : "EFFICIENT SIGN";
  const options = {
    body: typeof payload.body === "string" ? payload.body : "Your sign-off request has been updated.",
    icon: new URL("efficient-engineering-mark.png", self.registration.scope).href,
    badge: new URL("efficient-engineering-mark.png", self.registration.scope).href,
    tag: typeof payload.tag === "string" ? payload.tag : "efficient-sign-update",
    data: {
      url: typeof payload.url === "string" ? payload.url : new URL("collaboration.html", self.registration.scope).href,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const serviceWorkerScope = new URL(".", self.location.href);
  let targetUrl = new URL(
    typeof event.notification.data?.url === "string"
      ? event.notification.data.url
      : "collaboration.html",
    serviceWorkerScope,
  );
  if (
    targetUrl.origin !== serviceWorkerScope.origin ||
    !targetUrl.pathname.startsWith(serviceWorkerScope.pathname)
  ) {
    targetUrl = new URL("collaboration.html", serviceWorkerScope);
  }

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === targetUrl.origin) {
        await client.navigate(targetUrl.href);
        return client.focus();
      }
    }
    return self.clients.openWindow(targetUrl.href);
  })());
});

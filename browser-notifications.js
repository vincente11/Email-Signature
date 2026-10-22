(() => {
  "use strict";

  function attach(button, options) {
    let userId = null;
    let pushEnabled = false;
    let isBusy = false;
    let setupError = "";

    function isSupported() {
      return Boolean(
        window.isSecureContext &&
        "Notification" in window &&
        "serviceWorker" in navigator &&
        "PushManager" in window,
      );
    }

    function getServiceWorkerScope() {
      return new URL(".", window.location.href).pathname;
    }

    function render() {
      if (!userId) {
        button.hidden = true;
        return;
      }

      button.hidden = false;
      if (!isSupported()) {
        button.disabled = true;
        button.textContent = "Push alerts unavailable";
        button.title = "Push notifications require Chrome and a secure HTTPS connection.";
      } else if (Notification.permission === "denied") {
        button.disabled = true;
        button.textContent = "Notifications blocked";
        button.title = "Allow notifications for this site in Chrome's site settings.";
      } else if (pushEnabled) {
        button.disabled = isBusy;
        button.textContent = isBusy ? "Turning off alerts…" : "Turn off push alerts";
        button.title = "Stop Chrome push notifications for this browser.";
      } else {
        button.disabled = isBusy;
        button.textContent = isBusy
          ? "Setting up push alerts…"
          : setupError
            ? "Retry push setup"
            : Notification.permission === "granted"
              ? "Set up push alerts"
              : "Enable push alerts";
        button.title = setupError || "Allow push notifications for sign-off updates, including when the site is closed.";
      }
    }

    async function saveSubscription(subscription, expectedUserId) {
      const authClient = options.getAuthClient();
      if (!authClient || userId !== expectedUserId) {
        throw new Error("Sign in again before enabling push notifications.");
      }

      const serialized = subscription.toJSON();
      const { endpoint, keys } = serialized;
      if (!endpoint || !keys?.p256dh || !keys.auth) {
        throw new Error("Chrome returned an incomplete push subscription.");
      }

      const { error } = await authClient.rpc("save_push_subscription", {
        p_endpoint: endpoint,
        p_p256dh: keys.p256dh,
        p_auth: keys.auth,
      });
      if (error) throw error;
      if (userId !== expectedUserId) {
        throw new Error("Your account changed while push notifications were being enabled.");
      }
    }

    async function findExistingSubscription(expectedUserId) {
      if (!userId || userId !== expectedUserId || !isSupported() || Notification.permission !== "granted") return;
      try {
        const registration = await navigator.serviceWorker.getRegistration(getServiceWorkerScope());
        const subscription = await registration?.pushManager.getSubscription();
        if (!subscription || userId !== expectedUserId) return;
        await saveSubscription(subscription, expectedUserId);
        pushEnabled = true;
        setupError = "";
      } catch (error) {
        console.error("Saved browser push subscription could not be restored:", error);
        setupError = error?.message || "The saved push subscription could not be restored.";
      }
      render();
    }

    async function enablePush() {
      const expectedUserId = userId;
      if (!expectedUserId || !isSupported()) return;
      isBusy = true;
      setupError = "";
      render();
      try {
        let permission = Notification.permission;
        if (permission === "default") {
          permission = await Notification.requestPermission();
        }
        if (permission !== "granted") {
          if (permission === "denied") {
            setupError = "Notifications are blocked. Allow them in Chrome's site settings.";
          }
          return;
        }

        const registration = await navigator.serviceWorker.register(
          new URL("sw.js", window.location.href),
          { scope: getServiceWorkerScope() },
        );
        const configResponse = await fetch(`${options.supabaseUrl}/functions/v1/send-push`, {
          method: "GET",
          cache: "no-store",
        });
        if (!configResponse.ok) {
          throw new Error("Push service is not configured yet. Contact the site administrator.");
        }
        const config = await configResponse.json();
        if (typeof config.publicKey !== "string" || !config.publicKey) {
          throw new Error("The push service returned an invalid application key.");
        }

        const applicationServerKey = Uint8Array.from(
          atob(config.publicKey.replace(/-/g, "+").replace(/_/g, "/")),
          (character) => character.charCodeAt(0),
        );
        const subscription = await registration.pushManager.getSubscription() ||
          await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey,
          });
        await saveSubscription(subscription, expectedUserId);
        pushEnabled = true;
        setupError = "";
        await registration.showNotification("EFFICIENT SIGN push alerts enabled", {
          body: "You'll receive collaboration updates even when the site is closed.",
          icon: new URL("efficient-engineering-mark.png", registration.scope).href,
          tag: "efficient-sign-push-enabled",
        });
      } catch (error) {
        console.error("Browser push notifications could not be enabled:", error);
        setupError = error?.message || "Push notifications could not be enabled.";
      } finally {
        isBusy = false;
        render();
      }
    }

    async function disablePush(force = false) {
      const expectedUserId = userId;
      if (!expectedUserId || (!pushEnabled && !force)) return;
      isBusy = true;
      setupError = "";
      render();
      try {
        if (!isSupported()) {
          pushEnabled = false;
          return;
        }
        const registration = await navigator.serviceWorker.getRegistration(getServiceWorkerScope());
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          const authClient = options.getAuthClient();
          if (!authClient || userId !== expectedUserId) {
            throw new Error("Sign in again before turning off push notifications.");
          }
          const { error } = await authClient.rpc("remove_push_subscription", {
            p_endpoint: subscription.endpoint,
          });
          if (error) throw error;
          await subscription.unsubscribe();
        }
        pushEnabled = false;
      } catch (error) {
        console.error("Browser push notifications could not be disabled:", error);
        setupError = error?.message || "Push notifications could not be disabled.";
      } finally {
        isBusy = false;
        render();
      }
    }

    button.addEventListener("click", () => {
      if (pushEnabled) void disablePush();
      else void enablePush();
    });
    render();
    return {
      setUserId(nextUserId) {
        userId = nextUserId;
        pushEnabled = false;
        setupError = "";
        render();
        if (userId && isSupported() && Notification.permission === "granted") {
          void findExistingSubscription(userId);
        }
      },
      disable: () => disablePush(true),
    };
  }

  window.EfficientSignNotifications = { attach };
})();

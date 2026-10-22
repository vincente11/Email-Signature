(() => {
  "use strict";

  const STORAGE_KEY_PREFIX = "efficientSign:browserNotifications:";
  const MAX_SAVED_SIGNATURES = 100;

  function attach(button) {
    let userId = null;
    let requestingPermission = false;
    let permissionError = false;

    function render() {
      if (!userId) {
        button.hidden = true;
        return;
      }

      button.hidden = false;
      if (!window.isSecureContext || !("Notification" in window)) {
        button.disabled = true;
        button.textContent = "Notifications unavailable";
        button.title = "Browser notifications require a supported browser and a secure HTTPS connection.";
      } else if (Notification.permission === "granted") {
        button.disabled = true;
        button.textContent = "Browser alerts on";
        button.title = "Chrome alerts are enabled. Updates are checked while EFFICIENT SIGN is open.";
      } else if (Notification.permission === "denied") {
        button.disabled = true;
        button.textContent = "Notifications blocked";
        button.title = "Allow notifications for this site in Chrome's site settings.";
      } else {
        button.disabled = requestingPermission;
        button.textContent = permissionError ? "Retry browser alerts" : "Enable browser alerts";
        button.title = permissionError
          ? "Notification permission could not be requested. Check Chrome's site settings, then try again."
          : "Allow Chrome alerts for collaboration updates while EFFICIENT SIGN is open.";
      }
    }

    button.addEventListener("click", async () => {
      if (!userId || !window.isSecureContext || !("Notification" in window)) return;
      if (Notification.permission === "granted" || Notification.permission === "denied") {
        render();
        return;
      }

      requestingPermission = true;
      permissionError = false;
      render();
      try {
        const permission = await Notification.requestPermission();
        if (permission === "granted") {
          const confirmation = new Notification("EFFICIENT SIGN alerts enabled", {
            body: "You'll receive collaboration updates while this site is open.",
            icon: "efficient-engineering-mark.png"
          });
          confirmation.onclick = () => {
            window.focus();
            confirmation.close();
          };
        }
      } catch (error) {
        console.error("Browser notification permission could not be requested:", error);
        permissionError = true;
      } finally {
        requestingPermission = false;
        render();
      }
    });

    document.addEventListener("visibilitychange", render);
    render();
    return {
      setUserId(nextUserId) {
        userId = nextUserId;
        render();
      },
      show(requestUserId, requestId, signature, title, body) {
        if (
          !requestUserId ||
          requestUserId !== userId ||
          !document.hidden ||
          !window.isSecureContext ||
          !("Notification" in window) ||
          Notification.permission !== "granted"
        ) {
          return;
        }

        const key = `${STORAGE_KEY_PREFIX}${requestUserId}`;
        try {
          const saved = localStorage.getItem(key);
          const signatures = saved ? JSON.parse(saved) : {};
          if (!signatures || typeof signatures !== "object" || Array.isArray(signatures)) {
            throw new Error("Saved browser notification state is invalid.");
          }
          if (signatures[requestId] === signature) return;

          const notification = new Notification(title, {
            body,
            icon: "efficient-engineering-mark.png",
            tag: `efficient-sign-${requestId}`
          });
          notification.onclick = () => {
            window.focus();
            if (!window.location.pathname.endsWith("/collaboration.html")) {
              window.location.href = new URL("collaboration.html", window.location.href).href;
            }
            notification.close();
          };

          signatures[requestId] = signature;
          const savedRequestIds = Object.keys(signatures);
          if (savedRequestIds.length > MAX_SAVED_SIGNATURES) {
            for (const oldRequestId of savedRequestIds.slice(0, savedRequestIds.length - MAX_SAVED_SIGNATURES)) {
              delete signatures[oldRequestId];
            }
          }
          localStorage.setItem(key, JSON.stringify(signatures));
        } catch (error) {
          console.error("Browser collaboration notification could not be shown:", error);
        }
      }
    };
  }

  window.EfficientSignNotifications = { attach };
})();

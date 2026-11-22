import { useEffect, useRef } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

const CHECK_EVERY_MS = 60 * 60 * 1000;

/**
 * Asks the user to switch to a new version once its service worker is waiting (registerType 'prompt').
 * An installed iPhone web app is resumed rather than reloaded, so the browser seldom checks for a new worker on
 * its own: check when the app becomes visible again and once an hour.
 * Mounted once, by Root, so it is there on every screen (boot, errors, login, shell) and registers the worker once.
 */
export function UpdatePrompt() {
  const live = useRef(true);
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      cleanup.current?.();
      cleanup.current = null;
    };
  }, []);

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      // Registration can finish after unmount; then there is nothing to schedule.
      if (!registration || !live.current) return;
      cleanup.current?.();
      const check = () => {
        if (registration.installing || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
        registration.update().catch(() => {});
      };
      const onVisible = () => {
        if (document.visibilityState === 'visible') check();
      };
      const timer = setInterval(check, CHECK_EVERY_MS);
      document.addEventListener('visibilitychange', onVisible);
      cleanup.current = () => {
        clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisible);
      };
    },
  });

  if (!needRefresh) return null;
  return (
    <div className="update-prompt" role="alert">
      <span>有新版本可用</span>
      <button type="button" className="primary" onClick={() => void updateServiceWorker(true)}>
        更新
      </button>
      <button type="button" onClick={() => setNeedRefresh(false)}>
        稍后
      </button>
    </div>
  );
}

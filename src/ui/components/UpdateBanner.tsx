import { useEffect, useState } from 'react';
import { t } from '../../i18n';

/**
 * Checks /version.json (never cached) against the build this page runs, on
 * open, when the app comes back to the foreground and every 10 minutes, and
 * offers a refresh when a newer build is published (D-59).
 */

const CHECK_EVERY_MS = 10 * 60_000;

async function latestBuild(): Promise<{ id: string; built: string } | null> {
  try {
    const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as { id: string; built: string };
  } catch {
    return null; // offline: nothing to say
  }
}

/** Load the newest build: refresh the service worker, drop old caches, reload. */
export async function refreshApp(): Promise<void> {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.update().catch(() => undefined)));
    const keys = (await caches?.keys?.()) ?? [];
    await Promise.all(keys.map((k) => caches.delete(k)));
  } finally {
    window.location.reload();
  }
}

export function UpdateBanner() {
  const [newer, setNewer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof __APP_BUILD_ID__ !== 'string' || !import.meta.env.PROD) return;
    let stopped = false;
    const check = async () => {
      const latest = await latestBuild();
      if (!stopped && latest && latest.id !== __APP_BUILD_ID__) setNewer(latest.built);
    };
    void check();
    const onVisible = () => document.visibilityState === 'visible' && void check();
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(() => void check(), CHECK_EVERY_MS);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, []);

  if (!newer) return null;
  return (
    <div className="update-banner" role="status">
      <span>{t('update.available', { built: newer })}</span>
      <button
        type="button"
        className="button button-primary button-small"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void refreshApp();
        }}
      >
        {busy ? t('update.refreshing') : t('update.refresh')}
      </button>
    </div>
  );
}

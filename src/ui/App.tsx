import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { useSettings, useVault, useVaultVersion } from './hooks';
import { href, useRoute } from './router';
import { AccountsPage } from './pages/AccountsPage';
import { BudgetPage } from './pages/BudgetPage';
import { CategoriesPage } from './pages/CategoriesPage';
import { DashboardPage } from './pages/DashboardPage';
import { LockScreen, RecoveryKeyStep } from './pages/LockScreen';
import { SettingsPage } from './pages/SettingsPage';
import { TransactionsPage } from './pages/TransactionsPage';

const NAV = [
  ['', 'nav.dashboard'],
  ['budget', 'nav.budget'],
  ['transactions', 'nav.transactions'],
  ['accounts', 'nav.accounts'],
  ['categories', 'nav.categories'],
  ['settings', 'nav.settings'],
] as const;

export function App() {
  const vault = useVault();
  useVaultVersion();
  // Shown once, right after the vault is created (the vault is already unlocked then).
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  if (recoveryKey && vault.status === 'unlocked') {
    return <RecoveryKeyStep recoveryKey={recoveryKey} onDone={() => setRecoveryKey(null)} />;
  }
  if (vault.status !== 'unlocked') return <LockScreen onCreated={setRecoveryKey} />;
  return <Shell />;
}

function Shell() {
  const vault = useVault();
  const route = useRoute();
  const section = route.path[0] ?? '';
  useAutoLock();
  const mainRef = useRef<HTMLElement>(null);

  // Move focus to the page on navigation so keyboard and screen-reader users land in the content.
  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [section]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>
        {t('nav.skip')}
      </a>
      <header className="topbar">
        <a className="brand" href={href('')}>
          <img src="./icon.svg" alt="" width="24" height="24" />
          <span>Kassa</span>
        </a>
        <button type="button" className="button button-quiet" onClick={() => vault.lock()}>
          <span aria-hidden="true">🔒 </span>
          {t('nav.lock')}
        </button>
      </header>
      <nav className="mainnav" aria-label={t('nav.label')}>
        <ul>
          {NAV.map(([path, key]) => (
            <li key={path}>
              <a href={href(path)} aria-current={section === path ? 'page' : undefined}>
                {t(key)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" ref={mainRef} tabIndex={-1}>
        <Page section={section} />
      </main>
    </div>
  );
}

function Page({ section }: { section: string }) {
  switch (section) {
    case 'budget':
      return <BudgetPage />;
    case 'transactions':
      return <TransactionsPage />;
    case 'accounts':
      return <AccountsPage />;
    case 'categories':
      return <CategoriesPage />;
    case 'settings':
      return <SettingsPage />;
    default:
      return <DashboardPage />;
  }
}

/** Lock after N minutes without keyboard, pointer or touch input (default 15). */
function useAutoLock() {
  const vault = useVault();
  const { autoLockMinutes } = useSettings();
  useEffect(() => {
    let last = Date.now();
    const bump = () => {
      last = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
    for (const e of events) window.addEventListener(e, bump, { passive: true, capture: true });
    const check = () => {
      if (Date.now() - last >= autoLockMinutes * 60_000) vault.lock();
    };
    const timer = window.setInterval(check, 15_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      for (const e of events) window.removeEventListener(e, bump, { capture: true });
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [vault, autoLockMinutes]);
}

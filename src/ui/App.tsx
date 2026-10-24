import { useEffect, useRef, useState } from 'react';
import { t, type MessageKey } from '../i18n';
import { ensureInvestments } from './actions';
import { cleanUpLedger, cleanUpMessage } from './importActions';
import { useToast } from './components/Toast';
import { UpdateBanner } from './components/UpdateBanner';
import { Icon, type IconName } from './components/Icon';
import { useSettings, useStore, useVault, useVaultVersion } from './hooks';
import { href, useRoute } from './router';
import { AccountsPage } from './pages/AccountsPage';
import { BudgetPage } from './pages/BudgetPage';
import { CategoriesPage } from './pages/CategoriesPage';
import { DashboardPage } from './pages/DashboardPage';
import { ImportPage } from './pages/ImportPage';
import { InboxPage } from './pages/InboxPage';
import { InsightsPage } from './pages/InsightsPage';
import { PlanPage } from './pages/PlanPage';
import { RulesPage } from './pages/RulesPage';
import { ScenariosTab } from './pages/ScenariosTab';
import { TaxTab } from './pages/TaxTab';
import { LockScreen, RecoveryKeyStep } from './pages/LockScreen';
import { SettingsPage } from './pages/SettingsPage';
import { TransactionsPage } from './pages/TransactionsPage';

const NAV = [
  ['', 'nav.dashboard', 'home'],
  ['budget', 'nav.budget', 'budget'],
  ['inbox', 'nav.inbox', 'inbox'],
  ['plan', 'nav.plan', 'chart'],
  ['insights', 'nav.insights', 'insights'],
  ['transactions', 'nav.transactions', 'list'],
  ['import', 'nav.import', 'upload'],
  ['accounts', 'nav.accounts', 'bank'],
  ['categories', 'nav.categories', 'tag'],
  ['rules', 'nav.rules', 'rules'],
  ['settings', 'nav.settings', 'settings'],
] as const satisfies readonly (readonly [string, MessageKey, IconName])[];

/** On phones the first five sit in the bottom bar; the rest live under "More". */
const PRIMARY = new Set(['', 'budget', 'inbox', 'plan', 'insights']);

export function App() {
  const vault = useVault();
  useVaultVersion();
  // Shown once, right after the vault is created (the vault is already unlocked then).
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  if (recoveryKey && vault.status === 'unlocked') {
    return <RecoveryKeyStep recoveryKey={recoveryKey} onDone={() => setRecoveryKey(null)} />;
  }
  return (
    <>
      <UpdateBanner />
      {vault.status !== 'unlocked' ? <LockScreen onCreated={setRecoveryKey} /> : <Shell />}
    </>
  );
}

function Shell() {
  const vault = useVault();
  const route = useRoute();
  const section = route.path[0] ?? '';
  const inboxCount = useStore('transactions').filter((x) => x.status === 'new' || x.status === 'suggested').length;
  useAutoLock();
  const mainRef = useRef<HTMLElement>(null);
  // One-time additions for vaults created before a feature existed.
  const notify = useToast();
  useEffect(() => {
    void ensureInvestments(vault);
    // Duplicated transfer sides from before D-68 (and any since) are removed on unlock.
    void cleanUpLedger(vault).then((r) => {
      const msg = cleanUpMessage(r);
      if (msg) notify(msg);
    });
  }, [vault]);

  // Move focus to the page on navigation so keyboard and screen-reader users land in the content.
  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [section]);

  const badge = inboxCount > 0 && <span className="nav-count" aria-label={t('nav.inboxCount', { n: inboxCount })}>{inboxCount}</span>;
  const moreActive = section === 'more' || !PRIMARY.has(section);

  return (
    <div className="shell">
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>
        {t('nav.skip')}
      </a>
      <header className="topbar">
        <a className="brand" href={href('')}>
          <img src="./icon.svg" alt="" width="26" height="26" />
          <span>{t('app.short')}</span>
        </a>
        <button type="button" className="icon-button" onClick={() => vault.lock()} aria-label={t('nav.lock')}>
          <Icon name="lock" />
        </button>
      </header>
      <main id="main" ref={mainRef} tabIndex={-1}>
        {section === 'more' ? <MorePage /> : <Page section={section} />}
      </main>
      <nav className="tabbar" aria-label={t('nav.label')}>
        {NAV.filter(([path]) => PRIMARY.has(path)).map(([path, key, icon]) => (
          <a key={path} href={href(path)} aria-current={section === path ? 'page' : undefined}>
            <span className="tab-icon">
              <Icon name={icon} size={22} />
              {path === 'inbox' && badge}
            </span>
            <span>{t(key)}</span>
          </a>
        ))}
        <a href={href('more')} aria-current={moreActive ? 'page' : undefined}>
          <span className="tab-icon"><Icon name="more" size={22} /></span>
          <span>{t('nav.more')}</span>
        </a>
      </nav>
    </div>
  );
}

/** Phone-only list of the sections that do not fit in the tab bar. */
function MorePage() {
  const vault = useVault();
  return (
    <>
      <h1>{t('nav.more')}</h1>
      <ul className="more-list">
        {NAV.filter(([path]) => !PRIMARY.has(path)).map(([path, key, icon]) => (
          <li key={path}>
            <a href={href(path)}>
              <Icon name={icon} />
              <span>{t(key)}</span>
              <Icon name="chevronRight" size={18} />
            </a>
          </li>
        ))}
        <li>
          <button type="button" onClick={() => vault.lock()}>
            <Icon name="lock" />
            <span>{t('nav.lock')}</span>
          </button>
        </li>
      </ul>
    </>
  );
}

function Page({ section }: { section: string }) {
  switch (section) {
    case 'budget':
      return <BudgetPage />;
    case 'transactions':
      return <TransactionsPage />;
    case 'inbox':
      return <InboxPage />;
    case 'insights':
      return <InsightsPage />;
    case 'plan':
      return <PlanPage extraTabs={{ scenarios: <ScenariosTab />, tax: <TaxTab /> }} />;
    case 'rules':
      return <RulesPage />;
    case 'import':
      return <ImportPage />;
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

import { useEffect, useState, type FormEvent } from 'react';
import { addMonths, currentMonth, formatDate, todayIso } from '../../domain/dates';
import { STORE_NAMES } from '../../domain/types';
import { monthName, t } from '../../i18n';
import {
  BackupError,
  decryptBackup,
  encryptBackup,
  isEncryptedBackup,
  readPlainExport,
  snapshotHash,
  toPlainExport,
  type PlainExport,
} from '../../storage/backup';
import { MIN_PASSPHRASE_LENGTH, VaultError } from '../../storage/vault';
import { download, loadDemo, restoreSnapshot, saveSettings } from '../actions';
import { SelectField, TextField } from '../components/fields';
import { useToast } from '../components/Toast';
import { useDocumentTitle, useSettings, useStore, useVault } from '../hooks';
import { useRoute } from '../router';

export function SettingsPage() {
  useDocumentTitle(t('nav.settings'));
  const route = useRoute();
  const section = route.query.get('section');
  useEffect(() => {
    if (section) document.getElementById(`settings-${section}`)?.scrollIntoView();
  }, [section]);
  return (
    <>
      <h1>{t('nav.settings')}</h1>
      <BudgetSettings />
      <BackupSection />
      <RestoreSection />
      <SecuritySection />
      <DataSection />
    </>
  );
}

function BudgetSettings() {
  const vault = useVault();
  const notify = useToast();
  const settings = useSettings();
  const categories = useStore('categories');
  const months = Array.from({ length: 37 }, (_, i) => addMonths(currentMonth(), i - 24));
  if (!months.includes(settings.budgetStartMonth)) months.unshift(settings.budgetStartMonth);
  const [lockMinutes, setLockMinutes] = useState(String(settings.autoLockMinutes));
  const save = async (patch: Parameters<typeof saveSettings>[1]) => {
    await saveSettings(vault, patch);
    notify(t('settings.saved'));
  };
  return (
    <section className="card" id="settings-budget" aria-labelledby="sb-h">
      <h2 id="sb-h">{t('settings.budget')}</h2>
      <SelectField
        label={t('settings.startMonth')}
        value={settings.budgetStartMonth}
        onChange={(e) => void save({ budgetStartMonth: e.target.value })}
        hint={t('settings.startMonthHint')}
      >
        {months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
      </SelectField>
      <SelectField
        label={t('settings.sweepTarget')}
        value={settings.sweepTargetCategoryId ?? ''}
        onChange={(e) => void save({ sweepTargetCategoryId: e.target.value || undefined })}
        hint={t('settings.sweepTargetHint')}
      >
        <option value="">{t('common.none')}</option>
        {categories.filter((c) => !c.isIncome).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </SelectField>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(lockMinutes);
          if (Number.isInteger(n) && n >= 1 && n <= 60) void save({ autoLockMinutes: n });
        }}
      >
        <TextField
          label={t('settings.autoLock')}
          inputMode="numeric"
          value={lockMinutes}
          onChange={(e) => setLockMinutes(e.target.value.replace(/\D/g, ''))}
          hint={t('settings.autoLockHint')}
          error={lockMinutes && (Number(lockMinutes) < 1 || Number(lockMinutes) > 60) ? t('settings.autoLockRange') : undefined}
        />
        <button className="button">{t('common.save')}</button>
      </form>
    </section>
  );
}

function BackupSection() {
  const vault = useVault();
  const notify = useToast();
  const settings = useSettings();
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [plainOk, setPlainOk] = useState(false);
  const [lastHash, setLastHash] = useState<string>();

  async function encrypted(e: FormEvent) {
    e.preventDefault();
    if (pass.length < MIN_PASSPHRASE_LENGTH || pass !== confirm) return;
    setBusy(true);
    try {
      const plain = await toPlainExport(vault.snapshot());
      const file = await encryptBackup(plain, pass);
      download(`kassa-backup-${todayIso()}.kassa.json`, JSON.stringify(file));
      await saveSettings(vault, { lastBackupAt: new Date().toISOString() });
      setLastHash(plain.hash);
      setPass('');
      setConfirm('');
      notify(t('backup.done'));
    } finally {
      setBusy(false);
    }
  }

  async function plainExport() {
    const plain = await toPlainExport(vault.snapshot());
    download(`kassa-export-${todayIso()}.json`, JSON.stringify(plain, null, 1));
    notify(t('backup.exportDone'));
  }

  return (
    <section className="card" id="settings-backup" aria-labelledby="bk-h">
      <h2 id="bk-h">{t('backup.title')}</h2>
      <p>
        {settings.lastBackupAt
          ? t('backup.last', { date: formatDate(todayIso(new Date(settings.lastBackupAt))) })
          : t('backup.never')}
      </p>
      <form onSubmit={encrypted} noValidate>
        <TextField
          label={t('backup.passphrase')}
          type="password"
          autoComplete="new-password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          hint={t('backup.passphraseHint', { n: MIN_PASSPHRASE_LENGTH })}
        />
        <TextField
          label={t('backup.confirm')}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={confirm && confirm !== pass ? t('setup.mismatch') : undefined}
        />
        <button className="button button-primary" disabled={busy || pass.length < MIN_PASSPHRASE_LENGTH || pass !== confirm}>
          {busy ? t('lock.working') : t('backup.download')}
        </button>
      </form>
      {lastHash && <p className="hint">{t('backup.hash', { hash: lastHash.slice(0, 16) })}</p>}
      <h3>{t('backup.plainTitle')}</h3>
      <p className="notice notice-warn">⚠ {t('backup.plainWarning')}</p>
      <label className="check">
        <input type="checkbox" checked={plainOk} onChange={(e) => setPlainOk(e.target.checked)} />
        {t('backup.plainConfirm')}
      </label>
      <button type="button" className="button" disabled={!plainOk} onClick={() => void plainExport()}>
        {t('backup.plainDownload')}
      </button>
    </section>
  );
}

function RestoreSection() {
  const vault = useVault();
  const notify = useToast();
  const [file, setFile] = useState<unknown>(null);
  const [fileName, setFileName] = useState('');
  const [pass, setPass] = useState('');
  const [preview, setPreview] = useState<PlainExport | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();

  const errorText = (e: unknown) =>
    e instanceof BackupError ? t(`restore.error.${e.code}`) : t('restore.error.notBackup');

  async function choose(f: File | undefined) {
    setPreview(null);
    setError(undefined);
    setResult(undefined);
    setPass('');
    if (!f) return;
    setFileName(f.name);
    try {
      const parsed: unknown = JSON.parse(await f.text());
      setFile(parsed);
      if (!isEncryptedBackup(parsed)) setPreview(await readPlainExport(parsed));
    } catch (e) {
      setFile(null);
      setError(errorText(e));
    }
  }

  async function decrypt(e: FormEvent) {
    e.preventDefault();
    if (!isEncryptedBackup(file)) return;
    setBusy(true);
    setError(undefined);
    try {
      setPreview(await decryptBackup(file, pass));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!preview) return;
    setBusy(true);
    try {
      await restoreSnapshot(vault, preview.stores);
      const after = await snapshotHash(vault.snapshot());
      const ok = after === preview.hash;
      setResult(ok ? t('restore.verified', { hash: after.slice(0, 16) }) : t('restore.mismatch'));
      notify(ok ? t('restore.done') : t('restore.mismatch'), ok ? 'ok' : 'error');
      setPreview(null);
      setFile(null);
    } catch {
      setError(t('common.unexpectedError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" id="settings-restore" aria-labelledby="rs-h">
      <h2 id="rs-h">{t('restore.title')}</h2>
      <p>{t('restore.intro')}</p>
      <div className="field">
        <label htmlFor="restore-file">{t('restore.file')}</label>
        <input id="restore-file" type="file" accept=".json,application/json" onChange={(e) => void choose(e.target.files?.[0])} />
      </div>
      {isEncryptedBackup(file) && !preview && (
        <form onSubmit={decrypt} noValidate>
          <TextField label={t('restore.passphrase')} type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} />
          <button className="button" disabled={busy || !pass}>{busy ? t('lock.working') : t('restore.decrypt')}</button>
        </form>
      )}
      {error && <p className="error" role="alert">⚠ {error}</p>}
      {preview && (
        <div className="notice">
          <p>
            <strong>{fileName}</strong> · {t('restore.hash', { hash: preview.hash.slice(0, 16) })}
          </p>
          <ul className="counts">
            {STORE_NAMES.filter((n) => preview.stores[n].length > 0).map((n) => (
              <li key={n}>
                {n}: {preview.stores[n].length}
              </li>
            ))}
          </ul>
          <p className="notice-warn">⚠ {t('restore.replaceWarning')}</p>
          <button type="button" className="button button-danger" disabled={busy} onClick={() => void restore()}>
            {t('restore.replace')}
          </button>
        </div>
      )}
      {result && <p role="status">✓ {result}</p>}
    </section>
  );
}

function SecuritySection() {
  const vault = useVault();
  const notify = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(() => {
    void navigator.storage?.persisted?.().then(setPersisted);
  }, []);

  async function change(e: FormEvent) {
    e.preventDefault();
    if (next.length < MIN_PASSPHRASE_LENGTH || next !== confirm) return;
    setBusy(true);
    setError(undefined);
    try {
      await vault.changePassphrase(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      notify(t('security.changed'));
    } catch (err) {
      setError(err instanceof VaultError && err.code === 'badPassphrase' ? t('lock.badPassphrase') : t('common.unexpectedError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" id="settings-security" aria-labelledby="sec-h">
      <h2 id="sec-h">{t('security.title')}</h2>
      <p>
        {persisted === null ? t('security.persistUnknown') : persisted ? `✓ ${t('security.persisted')}` : `⚠ ${t('security.notPersisted')}`}{' '}
        {persisted === false && (
          <button type="button" className="button" onClick={() => void navigator.storage.persist().then(setPersisted)}>
            {t('security.requestPersist')}
          </button>
        )}
      </p>
      <form onSubmit={change} noValidate>
        <h3>{t('security.changeTitle')}</h3>
        <TextField label={t('security.current')} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <TextField label={t('security.new')} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} hint={t('setup.passphraseHint', { n: MIN_PASSPHRASE_LENGTH })} />
        <TextField label={t('security.confirm')} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={confirm && confirm !== next ? t('setup.mismatch') : undefined} />
        {error && <p className="error" role="alert">⚠ {error}</p>}
        <button className="button" disabled={busy || !current || next.length < MIN_PASSPHRASE_LENGTH || next !== confirm}>
          {busy ? t('lock.working') : t('security.change')}
        </button>
      </form>
      <p className="hint">{t('security.recoveryNote')}</p>
    </section>
  );
}

function DataSection() {
  const vault = useVault();
  const notify = useToast();
  const [demoConfirm, setDemoConfirm] = useState(false);
  const [wipeText, setWipeText] = useState('');
  const [busy, setBusy] = useState(false);
  const word = t('data.wipeWord');
  return (
    <section className="card" id="settings-data" aria-labelledby="dt-h">
      <h2 id="dt-h">{t('data.title')}</h2>
      <h3>{t('data.demoTitle')}</h3>
      <p>{t('data.demoIntro')}</p>
      <label className="check">
        <input type="checkbox" checked={demoConfirm} onChange={(e) => setDemoConfirm(e.target.checked)} />
        {t('data.demoConfirm')}
      </label>
      <button
        type="button"
        className="button"
        disabled={!demoConfirm || busy}
        onClick={() => {
          setBusy(true);
          void loadDemo(vault).then(() => {
            notify(t('data.demoLoaded'));
            setDemoConfirm(false);
            setBusy(false);
          });
        }}
      >
        {t('data.demoLoad')}
      </button>
      <h3>{t('data.wipeTitle')}</h3>
      <p>{t('data.wipeIntro')}</p>
      <TextField label={t('data.wipeLabel', { word })} value={wipeText} onChange={(e) => setWipeText(e.target.value)} autoComplete="off" />
      <button type="button" className="button button-danger" disabled={wipeText !== word || busy} onClick={() => void vault.destroy()}>
        {t('data.wipe')}
      </button>
    </section>
  );
}

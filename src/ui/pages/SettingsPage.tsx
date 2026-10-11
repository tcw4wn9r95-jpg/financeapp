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
import { changeBudgetStart, canShareFiles, download, loadDemo, shareFile, restoreSnapshot, saveMembers, saveSettings } from '../actions';
import { MoneyField, SelectField, TextField, useMoneyInput } from '../components/fields';
import { useToast } from '../components/Toast';
import { useDocumentTitle, useSettings, useStore, useVault } from '../hooks';
import { href, useRoute } from '../router';
import { passkeysAvailable, PasskeyError, registerPasskey } from '../../infra/passkey';
import { DEFAULT_THRESHOLD } from '../../domain/learn';

/** January 2020 up to a year ahead, newest first. */
export function startMonthOptions(): string[] {
  const out: string[] = [];
  for (let m = addMonths(currentMonth(), 12); m >= '2020-01'; m = addMonths(m, -1)) out.push(m);
  return out;
}

export function SettingsPage() {
  useDocumentTitle(t('nav.settings'));
  const route = useRoute();
  const section = route.query.get('section');
  useEffect(() => {
    // After the shell's scroll-to-top on navigation.
    if (!section) return;
    const id = window.setTimeout(() => document.getElementById(`settings-${section}`)?.scrollIntoView(), 0);
    return () => window.clearTimeout(id);
  }, [section]);
  return (
    <>
      <h1>{t('nav.settings')}</h1>
      <BudgetSettings />
      <HouseholdSection />
      <LearningSection />
      <BackupSection />
      <RestoreSection />
      <FaceIdSection />
      <SecuritySection />
      <DataSection />
    </>
  );
}

const THRESHOLDS = [0.8, 0.85, 0.9, 0.92, 0.95, 0.99];

/** Automatic categorising: threshold and the optional Claude fallback (M4, D-37). */
function LearningSection() {
  const vault = useVault();
  const notify = useToast();
  const settings = useSettings();
  const [key, setKey] = useState(settings.ai?.apiKey ?? '');
  const [show, setShow] = useState(false);
  // Local state so the box ticks at once; the vault write follows.
  const [enabled, setEnabled] = useState(!!settings.ai?.enabled);
  const save = async (patch: Parameters<typeof saveSettings>[1]) => {
    await saveSettings(vault, patch);
    notify(t('settings.saved'));
  };
  return (
    <section className="card" id="settings-learning" aria-labelledby="ln-h">
      <h2 id="ln-h">{t('learnSettings.title')}</h2>
      <SelectField
        label={t('learnSettings.threshold')}
        value={String(settings.autoApplyThreshold ?? DEFAULT_THRESHOLD)}
        onChange={(e) => void save({ autoApplyThreshold: Number(e.target.value) })}
        hint={t('learnSettings.thresholdHint')}
      >
        {THRESHOLDS.map((v) => <option key={v} value={v}>{Math.round(v * 100)} %</option>)}
        <option value="1.01">{t('learnSettings.never')}</option>
      </SelectField>
      <p><a href={href('rules')}>{t('learnSettings.rulesLink')}</a></p>
      <h3>{t('learnSettings.claude')}</h3>
      <p className="hint">{t('learnSettings.claudeHint')}</p>
      <label className="check">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            void save({ ai: { enabled: e.target.checked, apiKey: settings.ai?.apiKey ?? '' } });
          }}
        />
        {t('learnSettings.enable')}
      </label>
      {enabled && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ ai: { enabled: true, apiKey: key.trim() } });
          }}
        >
          <TextField
            label={t('learnSettings.key')}
            type={show ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            hint={t('learnSettings.keyHint')}
          />
          <button type="button" className="button button-quiet" onClick={() => setShow(!show)}>{show ? t('learnSettings.hide') : t('learnSettings.show')}</button>
          <button className="button">{t('common.save')}</button>
        </form>
      )}
      {enabled && settings.ai?.apiKey && (
        <button type="button" className="button button-quiet" onClick={() => { setKey(''); setEnabled(false); void save({ ai: { enabled: false, apiKey: '' } }); }}>
          {t('learnSettings.forget')}
        </button>
      )}
    </section>
  );
}

function BudgetSettings() {
  const vault = useVault();
  const notify = useToast();
  const settings = useSettings();
  const categories = useStore('categories');
  const months = startMonthOptions();
  if (!months.includes(settings.budgetStartMonth)) months.unshift(settings.budgetStartMonth);
  const [lockMinutes, setLockMinutes] = useState(String(settings.autoLockMinutes));
  const buffer = useMoneyInput(settings.minimumBuffer ?? 0);
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
        onChange={(e) => {
          void changeBudgetStart(vault, e.target.value).then((n) =>
            notify(n > 0 ? t(n === 1 ? 'settings.startMovedOne' : 'settings.startMoved', { n, month: monthName(e.target.value) }) : t('settings.saved')),
          );
        }}
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
          if (buffer.cents !== null && buffer.cents >= 0) void save({ minimumBuffer: buffer.cents });
        }}
      >
        <MoneyField label={t('settings.buffer')} state={buffer} hint={t('settings.bufferHint')} />
        <button className="button">{t('common.save')}</button>
      </form>
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

function HouseholdSection() {
  const vault = useVault();
  const notify = useToast();
  const settings = useSettings();
  const [members, setMembers] = useState(settings.members ?? []);
  const [newName, setNewName] = useState('');
  const save = async (next: typeof members) => {
    setMembers(next);
    await saveMembers(vault, next);
    notify(t('settings.saved'));
  };
  return (
    <section className="card" id="settings-household" aria-labelledby="hh-h">
      <h2 id="hh-h">{t('household.title')}</h2>
      <p>{t('household.intro')}</p>
      <ul className="plain-list">
        {members.map((m, i) => (
          <li key={m.id} className="inline-form">
            <TextField
              label={t('household.memberName', { n: i + 1 })}
              value={m.name}
              onChange={(e) => setMembers(members.map((x) => (x.id === m.id ? { ...x, name: e.target.value } : x)))}
              onBlur={() => void save(members)}
            />
            <button type="button" className="button button-quiet" onClick={() => void save(members.filter((x) => x.id !== m.id))} aria-label={t('household.removeNamed', { name: m.name })}>
              {t('household.remove')}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newName.trim()) return;
          void save([...members, { id: crypto.randomUUID(), name: newName.trim() }]);
          setNewName('');
        }}
      >
        <TextField label={t('household.add')} value={newName} onChange={(e) => setNewName(e.target.value)} autoComplete="off" />
        <button className="button" disabled={!newName.trim()}>{t('household.addButton')}</button>
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
  const sharing = canShareFiles();
  // Encryption takes a moment, and browsers only open the share sheet straight
  // after a tap; so "Share" first prepares the file, then a second tap shares it.
  const [prepared, setPrepared] = useState<{ name: string; text: string; hash: string } | null>(null);

  async function encrypted(e: FormEvent) {
    e.preventDefault();
    if (pass.length < MIN_PASSPHRASE_LENGTH || pass !== confirm) return;
    const share = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'share';
    setBusy(true);
    try {
      const plain = await toPlainExport(vault.snapshot());
      const file = await encryptBackup(plain, pass);
      const name = `casaressan-backup-${todayIso()}.json`;
      if (share) {
        setPrepared({ name, text: JSON.stringify(file), hash: plain.hash });
        setPass('');
        setConfirm('');
        return;
      }
      download(name, JSON.stringify(file));
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
    download(`casaressan-export-${todayIso()}.json`, JSON.stringify(plain, null, 1));
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
        {sharing && (
          <button className="button" name="action" value="share" disabled={busy || pass.length < MIN_PASSPHRASE_LENGTH || pass !== confirm}>
            {t('backup.share')}
          </button>
        )}
        {sharing && <p className="hint">{t('backup.shareHint')}</p>}
        {prepared && (
          <button
            type="button"
            className="button button-primary"
            onClick={async () => {
              try {
                if (!(await shareFile(prepared.name, prepared.text, t('backup.shareTitle')))) return;
                await saveSettings(vault, { lastBackupAt: new Date().toISOString() });
                setLastHash(prepared.hash);
                setPrepared(null);
                notify(t('backup.done'));
              } catch {
                notify(t('common.unexpectedError'), 'error');
              }
            }}
          >
            {t('backup.shareNow')}
          </button>
        )}
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

/** Unlock with Face ID / Touch ID through a passkey (D-44). */
function FaceIdSection() {
  const vault = useVault();
  const notify = useToast();
  const settings = useSettings();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [slots, setSlots] = useState<Awaited<ReturnType<typeof vault.passkeys>>>([]);
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const refresh = () => void vault.passkeys().then(setSlots);
  useEffect(() => {
    void passkeysAvailable().then(setAvailable);
    refresh();
  }, []);

  async function enable(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      // Check the passphrase first so a typo does not leave an unused passkey behind.
      if (!(await vault.verifyPassphrase(pass))) throw new VaultError('badPassphrase');
      const name = settings.members?.length ? `${t('app.short')} · ${settings.members.map((m) => m.name).join(' & ')}` : t('app.name');
      const r = await registerPasskey(name);
      await vault.addPasskey(pass, { ...r, label: deviceLabel() });
      setPass('');
      refresh();
      notify(t('faceid.enabled'));
    } catch (err) {
      setError(
        err instanceof VaultError && err.code === 'badPassphrase' ? t('lock.badPassphrase')
        : err instanceof PasskeyError ? t(`faceid.err.${err.code}`)
        : t('common.unexpectedError'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: Uint8Array) {
    await vault.removePasskey(id);
    refresh();
    notify(t('faceid.removed'));
  }

  return (
    <section className="card" id="settings-faceid" aria-labelledby="fid-h">
      <h2 id="fid-h">{t('faceid.title')}</h2>
      <p className="hint">{t('faceid.intro')}</p>
      {slots.length > 0 && (
        <ul className="plain-list">
          {slots.map((s) => (
            <li key={s.createdAt} className="split-row">
              <span>✓ {s.label} <span className="muted">· {formatDate(s.createdAt.slice(0, 10))}</span></span>
              <button type="button" className="button button-quiet" onClick={() => void remove(s.credentialId)}>{t('faceid.remove')}</button>
            </li>
          ))}
        </ul>
      )}
      {available === false ? (
        <p className="notice">{t('faceid.unavailable')}</p>
      ) : slots.length === 0 && (
        <form onSubmit={enable} noValidate>
          <TextField label={t('faceid.passphrase')} type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} hint={t('faceid.passphraseHint')} />
          {error && <p className="error" role="alert">⚠ {error}</p>}
          <button className="button button-primary" disabled={busy || !pass}>{busy ? t('lock.working') : t('faceid.enable')}</button>
        </form>
      )}
    </section>
  );
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  return t('faceid.thisDevice');
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
      <p className="hint">{t('data.version', { v: typeof __APP_BUILT__ === 'string' ? __APP_BUILT__ : 'dev' })}</p>
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

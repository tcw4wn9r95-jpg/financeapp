import { useEffect, useState, type FormEvent } from 'react';
import { evaluatePasskey, PasskeyError } from '../../infra/passkey';
import { MIN_PASSPHRASE_LENGTH, VaultError } from '../../storage/vault';
import { monthName, t } from '../../i18n';
import { addSuggestedCategories, changeBudgetStart, getSettings, loadDemo, saveSettings } from '../actions';
import { startMonthOptions } from './SettingsPage';
import { SelectField, TextField } from '../components/fields';
import { useVault } from '../hooks';
import { navigate } from '../router';

/** First run (create the vault), unlock, and recovery. */
export function LockScreen({ onCreated }: { onCreated: (recoveryKey: string) => void }) {
  const vault = useVault();
  return (
    <div className="lock">
      <div className="lock-card">
        <h1 className="lock-title">
          <img src="./icon.svg" alt="" width="44" height="44" />
          <span>{t('app.name')}</span>
        </h1>
        {vault.status === 'empty' ? <CreateForm onCreated={onCreated} /> : <UnlockForm />}
      </div>
    </div>
  );
}

function errorText(e: unknown): string {
  if (e instanceof VaultError) {
    switch (e.code) {
      case 'badPassphrase':
        return t('lock.badPassphrase');
      case 'badRecoveryKey':
        return t('lock.badRecoveryKey');
      case 'badPasskey':
        return t('faceid.bad');
      case 'weakPassphrase':
        return t('lock.weakPassphrase', { n: MIN_PASSPHRASE_LENGTH });
      default:
        return t('common.unexpectedError');
    }
  }
  if (e instanceof PasskeyError) return t(`faceid.err.${e.code}`);
  return t('common.unexpectedError');
}

function CreateForm({ onCreated }: { onCreated: (recoveryKey: string) => void }) {
  const vault = useVault();
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const tooShort = pass.length > 0 && pass.length < MIN_PASSPHRASE_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== pass;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pass.length < MIN_PASSPHRASE_LENGTH || pass !== confirm) return;
    setBusy(true);
    setError(undefined);
    try {
      // Ask the browser to keep IndexedDB even under storage pressure.
      void navigator.storage?.persist?.();
      const key = await vault.create(pass);
      await saveSettings(vault, {});
      onCreated(key);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <h2>{t('setup.title')}</h2>
      <p>{t('setup.intro')}</p>
      <TextField
        label={t('setup.passphrase')}
        type="password"
        autoComplete="new-password"
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        hint={t('setup.passphraseHint', { n: MIN_PASSPHRASE_LENGTH })}
        error={tooShort ? t('lock.weakPassphrase', { n: MIN_PASSPHRASE_LENGTH }) : undefined}
        required
        autoFocus
      />
      <TextField
        label={t('setup.confirm')}
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={mismatch ? t('setup.mismatch') : undefined}
        required
      />
      {error && <p className="error" role="alert">⚠ {error}</p>}
      <button className="button button-primary button-block" disabled={busy || pass.length < MIN_PASSPHRASE_LENGTH || pass !== confirm}>
        {busy ? t('lock.working') : t('setup.create')}
      </button>
      <p className="hint">{t('setup.privacy')}</p>
    </form>
  );
}

export function RecoveryKeyStep({ recoveryKey, onDone }: { recoveryKey: string; onDone: () => void }) {
  const vault = useVault();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startMonth, setStartMonth] = useState(getSettings(vault).budgetStartMonth);
  const start = async (how: 'empty' | 'suggested' | 'demo' | 'restore') => {
    setBusy(true);
    await changeBudgetStart(vault, startMonth);
    if (how === 'suggested') await addSuggestedCategories(vault);
    if (how === 'demo') await loadDemo(vault);
    navigate(how === 'restore' ? 'settings' : how === 'suggested' ? 'categories' : '', how === 'restore' ? { section: 'restore' } : undefined);
    onDone();
  };
  return (
    <div className="lock">
      <div className="lock-card">
        <h1>{t('recovery.title')}</h1>
        <p>{t('recovery.intro')}</p>
        <p className="recovery-key" aria-label={t('recovery.keyLabel')}>
          <code>{recoveryKey}</code>
        </p>
        <div className="row">
          <button type="button" className="button" onClick={() => window.print()}>
            {t('recovery.print')}
          </button>
          <button type="button" className="button" onClick={() => void navigator.clipboard?.writeText(recoveryKey)}>
            {t('recovery.copy')}
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          {t('recovery.confirm')}
        </label>
        <h2>{t('start.title')}</h2>
        <SelectField label={t('settings.startMonth')} value={startMonth} onChange={(e) => setStartMonth(e.target.value)} hint={t('start.monthHint')}>
          {startMonthOptions().map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
        </SelectField>
        <div className="stack">
          <button type="button" className="button button-primary" disabled={!saved || busy} onClick={() => void start('suggested')}>
            {t('start.suggested')}
          </button>
          <button type="button" className="button" disabled={!saved || busy} onClick={() => void start('demo')}>
            {t('start.demo')}
          </button>
          <button type="button" className="button" disabled={!saved || busy} onClick={() => void start('restore')}>
            {t('start.restore')}
          </button>
          <button type="button" className="button button-quiet" disabled={!saved || busy} onClick={() => void start('empty')}>
            {t('start.empty')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Once per page load. */
let autoPrompted = false;

function UnlockForm() {
  const vault = useVault();
  const [mode, setMode] = useState<'pass' | 'recover'>('pass');
  const [pass, setPass] = useState('');
  const [rkey, setRkey] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // null until known, so the passphrase box does not grab focus (and the keyboard) before Face ID is offered.
  const [slots, setSlots] = useState<Awaited<ReturnType<typeof vault.passkeys>> | null>(null);

  async function faceId(quiet = false) {
    if (!slots?.length) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await evaluatePasskey(slots);
      await vault.unlockWithPasskey(r.credentialId, r.prf);
    } catch (err) {
      // An automatic prompt the browser refused (no tap yet) stays silent.
      if (!(quiet && err instanceof PasskeyError && err.code === 'cancelled')) setError(errorText(err));
      setBusy(false);
    }
  }

  useEffect(() => {
    void vault.passkeys().then(setSlots);
  }, [vault]);
  // Offer Face ID straight away when the app is opened — not after "Lock",
  // which would unlock again at once.
  useEffect(() => {
    if (slots?.length && !autoPrompted) {
      autoPrompted = true;
      void faceId(true);
    }
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (mode === 'pass') await vault.unlock(pass);
      else await vault.recover(rkey, next);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  if (slots === null) return null;
  return (
    <form onSubmit={submit} noValidate>
      <h2>{mode === 'pass' ? t('lock.title') : t('lock.recoverTitle')}</h2>
      {mode === 'pass' && !!slots?.length && (
        <>
          <button type="button" className="button button-primary button-block faceid-button" disabled={busy} onClick={() => void faceId()}>
            {t('faceid.unlock')}
          </button>
          <p className="or-divider"><span>{t('faceid.or')}</span></p>
        </>
      )}
      {mode === 'pass' ? (
        <TextField
          label={t('lock.passphrase')}
          type="password"
          autoComplete="current-password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          autoFocus={!slots?.length}
          required
        />
      ) : (
        <>
          <TextField label={t('lock.recoveryKey')} value={rkey} onChange={(e) => setRkey(e.target.value)} autoComplete="off" spellCheck={false} autoFocus required />
          <TextField
            label={t('lock.newPassphrase')}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            hint={t('setup.passphraseHint', { n: MIN_PASSPHRASE_LENGTH })}
            required
          />
        </>
      )}
      {error && <p className="error" role="alert">⚠ {error}</p>}
      <button className={`button button-block ${mode === 'pass' && slots?.length ? '' : 'button-primary'}`} disabled={busy}>
        {busy ? t('lock.working') : mode === 'pass' ? t('lock.unlock') : t('lock.recover')}
      </button>
      <button type="button" className="link-button" onClick={() => { setMode(mode === 'pass' ? 'recover' : 'pass'); setError(undefined); }}>
        {mode === 'pass' ? t('lock.forgot') : t('lock.backToPassphrase')}
      </button>
      <p className="hint">{t('lock.autoLockNote')}</p>
    </form>
  );
}

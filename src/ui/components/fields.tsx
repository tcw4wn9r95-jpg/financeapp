import { useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { formatDate, parseDate } from '../../domain/dates';
import { formatMoneyInput, parseMoney } from '../../domain/money';
import type { Cents, IsoDate } from '../../domain/types';
import { t } from '../../i18n';

interface FieldShellProps {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
}

/** Label, control, hint and error wired together for screen readers. */
export function Field({ label, hint, error, children }: FieldShellProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field ${error ? 'field-error' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children({ id, describedBy })}
      {hint && <p id={hintId} className="hint">{hint}</p>}
      {error && (
        <p id={errId} className="error" role="alert">
          <span aria-hidden="true">⚠ </span>
          {error}
        </p>
      )}
    </div>
  );
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & { label: string; hint?: string | undefined; error?: string | undefined };

export function TextField({ label, hint, error, ...rest }: InputProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {({ id, describedBy }) => <input id={id} aria-describedby={describedBy} aria-invalid={!!error} {...rest} />}
    </Field>
  );
}

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> & { label: string; hint?: string | undefined; error?: string | undefined; children: ReactNode };

export function SelectField({ label, hint, error, children, ...rest }: SelectProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {({ id, describedBy }) => (
        <select id={id} aria-describedby={describedBy} aria-invalid={!!error} {...rest}>
          {children}
        </select>
      )}
    </Field>
  );
}

/** State for a money text box: keeps what the user typed, exposes parsed cents. */
export function useMoneyInput(initial?: Cents) {
  const [text, setText] = useState(initial === undefined ? '' : formatMoneyInput(initial));
  const cents = parseMoney(text);
  return { text, setText, cents, valid: text.trim() === '' || cents !== null };
}

export function useDateInput(initial: IsoDate) {
  const [text, setText] = useState(formatDate(initial));
  const iso = parseDate(text);
  return { text, setText, iso };
}

/**
 * Money input. Phone number pads have no minus key, so `signed` adds a
 * button that flips the sign (for balances that can be below zero).
 */
export function MoneyField({ label, hint, error, state, signed = false, ...rest }: Omit<InputProps, 'value' | 'onChange'> & { state: ReturnType<typeof useMoneyInput>; signed?: boolean }) {
  const negative = /^\s*[-−]/.test(state.text);
  const flip = () => {
    const body = state.text.replace(/^\s*[-−]\s*/, '');
    state.setText(negative ? body : `-${body || ''}`);
  };
  return (
    <Field label={label} hint={hint ?? t('field.moneyHint')} error={error ?? (!state.valid ? t('field.moneyInvalid') : undefined)}>
      {({ id, describedBy }) => {
        const input = (
          <input
            id={id}
            aria-describedby={describedBy}
            aria-invalid={!!(error ?? !state.valid)}
            inputMode="decimal"
            autoComplete="off"
            value={state.text}
            onChange={(e) => state.setText(e.target.value)}
            {...rest}
          />
        );
        if (!signed) return input;
        return (
          <div className="signed-input">
            <button type="button" className={`sign-toggle ${negative ? 'sign-neg' : ''}`} onClick={flip} aria-pressed={negative} aria-label={t('field.negative')}>
              {negative ? '−' : '+'}
            </button>
            {input}
          </div>
        );
      }}
    </Field>
  );
}

export function DateField({ label, error, state, ...rest }: Omit<InputProps, 'value' | 'onChange'> & { state: ReturnType<typeof useDateInput> }) {
  return (
    <TextField
      label={label}
      hint={t('field.dateHint')}
      error={error ?? (state.text && !state.iso ? t('field.dateInvalid') : undefined)}
      inputMode="numeric"
      placeholder="dd/mm/yyyy"
      autoComplete="off"
      value={state.text}
      onChange={(e) => state.setText(e.target.value)}
      {...rest}
    />
  );
}

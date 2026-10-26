import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { CategoryAnalysis, MonthPoint, MonthVariance, VarianceLine } from '../../domain/insights';
import { monthVariance } from '../../domain/insights';
import { formatMoney, formatWholeEuros } from '../../domain/money';
import type { Cents, MonthKey } from '../../domain/types';
import { monthName, t, type MessageKey } from '../../i18n';
import { Dialog } from './Dialog';

/**
 * Spending against the plan, month by month (D-107), drawn the way finance
 * reports do (IBCS notation, Stephen Few's bullet graph): the plan as an
 * outlined column, what was spent as a solid one inside it, the part over the
 * plan marked on top. Tapping it opens the month-by-month explanation: plan
 * against spent, then the lines that made the difference as bars either side
 * of zero (over to the right, under to the left, each with its sign and
 * amount, so colour is never the only cue), then every line in a table.
 */

const PAD = { top: 12, right: 6, bottom: 24, left: 40 };
const monthAbbr = (m: MonthKey) => t(`month.${Number(m.slice(5))}` as MessageKey).slice(0, 3);

function compact(cents: Cents): string {
  const v = Math.abs(cents / 100);
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 || v % 1000 === 0 ? 0 : 1).replace('.', ',')}K`;
  return String(Math.round(v));
}

const pct = (spent: Cents, planned: Cents) => (planned > 0 ? Math.round(((spent - planned) / planned) * 100) : null);
const signed = (c: Cents) => `${c > 0 ? '+' : c < 0 ? '−' : ''}${formatWholeEuros(Math.abs(c))}`;

function useWidth(initial = 340) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Plan (outlined) and spent (solid) per month, the part over the plan marked; a tooltip per month. */
export function PlanColumns({ points, height = 170, selected, onSelect, title }: { points: MonthPoint[]; height?: number; selected?: number; onSelect?: (i: number) => void; title: string }) {
  const [wrap, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();
  const n = points.length;
  const hi = Math.max(1, ...points.flatMap((p) => [p.budgeted, p.spent])) * 1.06;
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const slot = plotW / Math.max(1, n);
  const pw = Math.max(8, Math.min(32, slot * 0.72));
  const aw = Math.max(4, Math.round(pw * 0.5));
  const cx = (i: number) => PAD.left + slot * i + slot / 2;
  const y = (v: number) => PAD.top + plotH - (Math.max(0, v) / hi) * plotH;
  const base = y(0);
  const step = hi / 100 > 20_000 ? 1_000_000 : hi / 100 > 4000 ? 500_000 : 100_000;
  const ticks = [0, step, step * 2, step * 3, step * 4, step * 5, step * 6, step * 8, step * 10, step * 15, step * 20].filter((v) => v <= hi).filter((_, i, a) => a.length <= 5 || i % 2 === 0);
  const every = slot >= 26 ? 1 : slot >= 13 ? 2 : 3;
  const tip = active === null ? null : points[active]!;
  const tipLeft = active === null ? 0 : Math.min(Math.max(cx(active) - 92, 0), width - 188);
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight') setActive((a) => Math.min(n - 1, (a ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? n) - 1));
    else if (e.key === 'Enter' && active !== null) onSelect?.(active);
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  };
  const pick = (clientX: number, svg: SVGSVGElement) => Math.max(0, Math.min(n - 1, Math.floor((clientX - svg.getBoundingClientRect().left - PAD.left) / slot)));
  return (
    <figure className="chart" aria-labelledby={titleId}>
      <figcaption id={titleId} className="visually-hidden">{title}</figcaption>
      <ul className="chart-legend">
        <li><span className="pva-key pva-key-plan" aria-hidden="true" />{t('pva.plan')}</li>
        <li><span className="pva-key pva-key-spent" aria-hidden="true" />{t('pva.spent')}</li>
        <li><span className="pva-key pva-key-over" aria-hidden="true" />{t('pva.overPlan')}</li>
      </ul>
      <div ref={wrap} className="chart-box">
        <svg width={width} height={height} role="img" aria-label={title} tabIndex={0} onKeyDown={onKey} onBlur={() => setActive(null)}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} className="chart-grid" />
              <text x={PAD.left - 6} y={y(v)} className="chart-tick" textAnchor="end" dominantBaseline="middle">{compact(v)}</text>
            </g>
          ))}
          {selected !== undefined && selected >= 0 && selected < n && <rect x={PAD.left + slot * selected} y={PAD.top - 4} width={slot} height={plotH + 4} rx={4} className="chart-selected" />}
          {points.map((p, i) => {
            const x = cx(i);
            const top = y(p.budgeted);
            const s = y(p.spent);
            const over = p.spent > p.budgeted;
            return (
              <g key={p.month} className={p.kind === 'current' ? 'pva-current' : undefined}>
                {p.budgeted > 0 && <path d={`M${x - pw / 2},${base}V${top + 3}Q${x - pw / 2},${top} ${x - pw / 2 + 3},${top}H${x + pw / 2 - 3}Q${x + pw / 2},${top} ${x + pw / 2},${top + 3}V${base}`} className="pva-plan" />}
                {p.spent > 0 && <rect x={x - aw / 2} y={over ? top : s} width={aw} height={Math.max(0, base - (over ? top : s))} className="pva-spent" />}
                {over && <path d={`M${x - aw / 2},${top}V${s + 3}Q${x - aw / 2},${s} ${x - aw / 2 + 3},${s}H${x + aw / 2 - 3}Q${x + aw / 2},${s} ${x + aw / 2},${s + 3}V${top}Z`} className="pva-over" />}
                {!over && p.spent > 0 && <rect x={x - aw / 2} y={s} width={aw} height={2} className="pva-spent-cap" />}
                {i % every === 0 && <text x={x} y={height - 8} className={`chart-tick ${selected === i ? 'chart-tick-on' : ''}`} textAnchor="middle">{monthAbbr(p.month)}</text>}
              </g>
            );
          })}
          <line x1={PAD.left} x2={PAD.left + plotW} y1={base} y2={base} className="chart-base" />
          {active !== null && <rect x={PAD.left + slot * active} y={PAD.top} width={slot} height={plotH} className="chart-hover" />}
          <rect
            x={PAD.left}
            y={0}
            width={plotW}
            height={height}
            fill="transparent"
            style={onSelect ? { cursor: 'pointer' } : undefined}
            onPointerDown={(e) => {
              e.preventDefault();
              setActive(pick(e.clientX, e.currentTarget.ownerSVGElement!));
            }}
            onPointerUp={(e) => onSelect?.(pick(e.clientX, e.currentTarget.ownerSVGElement!))}
            onPointerMove={(e) => setActive(pick(e.clientX, e.currentTarget.ownerSVGElement!))}
            onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
          />
        </svg>
        {tip && (
          <div className="chart-tip chart-tip-wide" style={{ left: tipLeft }} role="status">
            <div className="chart-tip-title">{monthName(tip.month)}{tip.kind === 'current' ? ` · ${t('chart.soFar')}` : ''}</div>
            <div className="chart-tip-row"><span className="pva-key pva-key-plan" aria-hidden="true" /><strong>{formatMoney(tip.budgeted)}</strong><span className="muted">{t('pva.plan')}</span></div>
            <div className="chart-tip-row"><span className="pva-key pva-key-spent" aria-hidden="true" /><strong>{formatMoney(tip.spent)}</strong><span className="muted">{t('pva.spent')}</span></div>
            <div className="chart-tip-row muted">{tip.spent > tip.budgeted ? t('pva.overBy', { amount: formatWholeEuros(tip.spent - tip.budgeted), pct: pct(tip.spent, tip.budgeted) ?? '–' }) : t('pva.underBy', { amount: formatWholeEuros(tip.budgeted - tip.spent), pct: Math.abs(pct(tip.spent, tip.budgeted) ?? 0) })}</div>
          </div>
        )}
      </div>
    </figure>
  );
}

/** The Insights card: the columns and one line; a tap opens the explanation. */
export function PlanVsActualCard({ points, cats, income }: { points: MonthPoint[]; cats: readonly CategoryAnalysis[]; income: ReadonlyMap<MonthKey, Cents> }) {
  const [open, setOpen] = useState<number | null>(null);
  const shown = points.filter((p) => p.kind !== 'projected');
  if (!shown.length) return null;
  const full = shown.filter((p) => p.kind === 'past');
  const over = full.filter((p) => p.spent > p.budgeted).length;
  const gap = full.length ? Math.round(full.reduce((s, p) => s + p.spent - p.budgeted, 0) / full.length) : 0;
  const lastFull = full.length ? shown.indexOf(full.at(-1)!) : shown.length - 1;
  return (
    <section className="card pva-card" aria-labelledby="pva-h">
      <h2 id="pva-h" className="card-title">{t('pva.title')}</h2>
      <p className="pva-lead">
        {full.length ? t('pva.lead', { over, n: full.length }) : t('pva.leadNone')}
        {full.length > 0 && <span className="muted"> · {gap > 0 ? t('pva.avgOver', { amount: formatWholeEuros(gap) }) : t('pva.avgUnder', { amount: formatWholeEuros(-gap) })}</span>}
      </p>
      <PlanColumns points={shown} title={t('pva.title')} onSelect={(i) => setOpen(i)} height={160} />
      <button type="button" className="button button-block" onClick={() => setOpen(lastFull)}>{t('pva.explain')} ›</button>
      {open !== null && <PlanVsActualDialog points={shown} cats={cats} income={income} start={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** The month-by-month explanation, in an overlay. */
function PlanVsActualDialog({ points, cats, income, start, onClose }: { points: MonthPoint[]; cats: readonly CategoryAnalysis[]; income: ReadonlyMap<MonthKey, Cents>; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  const p = points[i]!;
  const v = monthVariance(cats, p.month);
  return (
    <Dialog open title={t('pva.dialogTitle')} onClose={onClose} wide>
      <PlanColumns points={points} title={t('pva.title')} selected={i} onSelect={setI} height={150} />
      <div className="pva-nav">
        <button type="button" className="button button-small" disabled={i === 0} onClick={() => setI(i - 1)} aria-label={t('pva.prev')}>‹</button>
        <strong>{monthName(p.month)}{p.kind === 'current' ? ` · ${t('chart.soFar')}` : ''}</strong>
        <button type="button" className="button button-small" disabled={i === points.length - 1} onClick={() => setI(i + 1)} aria-label={t('pva.next')}>›</button>
      </div>
      <MonthExplanation v={v} income={income.get(p.month)} />
    </Dialog>
  );
}

function MonthExplanation({ v, income }: { v: MonthVariance; income: Cents | undefined }) {
  const gap = v.spent - v.planned;
  const p = pct(v.spent, v.planned);
  const over = v.lines.filter((l) => l.diff > 0);
  const under = v.lines.filter((l) => l.diff < 0);
  const max = Math.max(v.planned, v.spent, 1);
  const rows: { key: string; name: string; sub: string; diff: Cents; line?: VarianceLine }[] = [
    ...v.lines.map((l) => ({ key: l.categoryId, name: l.name, sub: t('pva.lineSub', { plan: formatWholeEuros(l.planned), spent: formatWholeEuros(l.spent) }), diff: l.diff, line: l })),
    ...(v.rest && v.rest.diff !== 0 ? [{ key: 'rest', name: t('pva.rest', { n: v.rest.count }), sub: t('pva.lineSub', { plan: formatWholeEuros(v.rest.planned), spent: formatWholeEuros(v.rest.spent) }), diff: v.rest.diff }] : []),
  ];
  const reach = Math.max(1, ...rows.map((r) => Math.abs(r.diff)));
  return (
    <>
      <p className="pva-sentence">
        {v.kind === 'current' ? t('pva.sentenceNow', { spent: formatWholeEuros(v.spent), plan: formatWholeEuros(v.planned) }) : t('pva.sentence', { spent: formatWholeEuros(v.spent), plan: formatWholeEuros(v.planned) })}{' '}
        <strong>{gap > 0 ? t('pva.overSentence', { amount: formatWholeEuros(gap), pct: p ?? '–' }) : gap < 0 ? t('pva.underSentence', { amount: formatWholeEuros(-gap), pct: Math.abs(p ?? 0) }) : t('pva.onPlan')}</strong>
      </p>

      <div className="pva-totals" role="img" aria-label={t('pva.totalsLabel', { plan: formatMoney(v.planned), spent: formatMoney(v.spent) })}>
        <div className="pva-total-row">
          <span className="pva-total-name">{t('pva.plan')}</span>
          <span className="pva-track"><span className="pva-bar pva-bar-plan" style={{ width: `${(v.planned / max) * 100}%` }} /></span>
          <span className="pva-total-value">{formatWholeEuros(v.planned)}</span>
        </div>
        <div className="pva-total-row">
          <span className="pva-total-name">{v.kind === 'current' ? t('pva.spentSoFar') : t('pva.spent')}</span>
          <span className="pva-track">
            <span className="pva-bar pva-bar-spent" style={{ width: `${(Math.min(v.spent, v.planned) / max) * 100}%` }} />
            {gap > 0 && <span className="pva-bar pva-bar-over" style={{ width: `${(gap / max) * 100}%` }} />}
          </span>
          <span className="pva-total-value">{formatWholeEuros(v.spent)}</span>
        </div>
      </div>

      {rows.length > 0 && (
        <section aria-labelledby="pva-why">
          <h3 id="pva-why" className="plan-h">{t('pva.why')}</h3>
          <p className="hint">{t('pva.whyHint')}</p>
          <ul className="plain-list pva-diffs">
            {rows.map((r) => (
              <li key={r.key} className="pva-diff">
                <span className="pva-diff-name">
                  {r.name}
                  <span className="muted">{r.sub}</span>
                </span>
                <span className="pva-diverge" aria-hidden="true">
                  <span className="pva-half pva-half-under">{r.diff < 0 && <span className="pva-bar pva-bar-under" style={{ width: `${(-r.diff / reach) * 100}%` }} />}</span>
                  <span className="pva-zero" />
                  <span className="pva-half">{r.diff > 0 && <span className="pva-bar pva-bar-over" style={{ width: `${(r.diff / reach) * 100}%` }} />}</span>
                </span>
                <span className={`pva-diff-value ${r.diff > 0 ? 'pva-worse' : 'pva-better'}`}>
                  {r.diff > 0 ? '▲' : '▼'} {signed(r.diff)}
                  <span className="visually-hidden"> {r.diff > 0 ? t('pva.overPlan') : t('pva.underPlan')}</span>
                </span>
              </li>
            ))}
          </ul>
          {(over.length > 0 || under.length > 0) && (
            <p className="hint">
              {over.length > 0 && t('pva.mostly', { list: over.slice(0, 3).map((l) => `${l.name} ${signed(l.diff)}`).join(', ') })}
              {over.length > 0 && under.length > 0 && ' '}
              {under.length > 0 && t('pva.saved', { list: under.slice(0, 3).map((l) => `${l.name} ${signed(l.diff)}`).join(', ') })}
            </p>
          )}
        </section>
      )}

      <details>
        <summary>{t('pva.table')}</summary>
        <div className="tax-compare-wrap">
          <table className="table">
            <thead>
              <tr><th scope="col">{t('pva.line')}</th><th scope="col" className="num">{t('pva.plan')}</th><th scope="col" className="num">{t('pva.spent')}</th><th scope="col" className="num">{t('pva.diff')}</th></tr>
            </thead>
            <tbody>
              {v.lines.map((l) => (
                <tr key={l.categoryId}><th scope="row">{l.name}</th><td className="num">{formatWholeEuros(l.planned)}</td><td className="num">{formatWholeEuros(l.spent)}</td><td className="num">{signed(l.diff)}</td></tr>
              ))}
              {v.rest && <tr><th scope="row">{t('pva.rest', { n: v.rest.count })}</th><td className="num">{formatWholeEuros(v.rest.planned)}</td><td className="num">{formatWholeEuros(v.rest.spent)}</td><td className="num">{signed(v.rest.diff)}</td></tr>}
              <tr><th scope="row"><strong>{t('pva.total')}</strong></th><td className="num"><strong>{formatWholeEuros(v.planned)}</strong></td><td className="num"><strong>{formatWholeEuros(v.spent)}</strong></td><td className="num"><strong>{signed(gap)}</strong></td></tr>
            </tbody>
          </table>
        </div>
      </details>

      {income !== undefined && income > 0 && v.kind !== 'current' && (
        <p className="hint pva-left">{t('pva.left', { income: formatWholeEuros(income), left: signed(income - v.spent) })}</p>
      )}
    </>
  );
}

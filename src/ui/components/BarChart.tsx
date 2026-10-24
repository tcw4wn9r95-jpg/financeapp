import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatMoney } from '../../domain/money';
import type { Cents } from '../../domain/types';
import { t } from '../../i18n';

/**
 * Columns of spending per month with the budget as a tick across each one
 * (D-86, dataviz skill specs): bars at most 24px wide with a 4px rounded end,
 * one series colour, months ahead in a lighter step of the same hue and
 * labelled "Projected", hairline grid, compact euro ticks, a tooltip on
 * touch, mouse and keyboard. The values are also in a table next to it.
 */

export interface Bar {
  /** Full label for the tooltip, e.g. "October 2026". */
  label: string;
  /** Short label under the bar, e.g. "Oct". */
  axis: string;
  value: Cents;
  budget?: Cents;
  kind: 'past' | 'current' | 'projected';
}

const PAD = { top: 14, right: 8, bottom: 26, left: 44 };

function compact(cents: Cents): string {
  const v = cents / 100;
  const abs = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1).replace('.', ',')}M`;
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(abs >= 10_000 || abs % 1000 === 0 ? 0 : 1).replace('.', ',')}K`;
  return `${sign}${Math.round(abs)}`;
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min];
  const span = max - min;
  const raw = span / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => span / s <= count) ?? 10 * pow;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step / 2; v += step) out.push(v);
  return out;
}

/** A column with a 4px rounded data end and a square base. */
function column(x: number, w: number, base: number, top: number): string {
  const h = Math.abs(base - top);
  const r = Math.min(4, w / 2, h);
  if (h < 0.5) return '';
  if (top < base) return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
  return `M${x},${base}V${top - r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top - r}V${base}Z`;
}

export function BarChart({ bars, title, height = 220, selected, onSelect, valueLabel = t('chart.spent') }: { bars: Bar[]; title: string; height?: number; selected?: number; onSelect?: (i: number) => void; valueLabel?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(340);
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setActive(null), [bars.length]);

  const n = bars.length;
  const all = bars.flatMap((b) => [b.value, b.budget ?? 0]);
  const lo = Math.min(...all, 0);
  const hi = Math.max(...all, 1);
  const ticks = niceTicks(lo, hi);
  const yMin = Math.min(lo, ticks[0]!);
  const yMax = Math.max(hi, ticks.at(-1)!);
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const slot = plotW / Math.max(1, n);
  const bw = Math.max(4, Math.min(24, slot * 0.62));
  const cx = (i: number) => PAD.left + slot * i + slot / 2;
  const y = (v: number) => PAD.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
  const base = y(0);
  // Every label when they fit, else every second or third.
  const every = slot >= 26 ? 1 : slot >= 13 ? 2 : 3;
  const firstAhead = bars.findIndex((b) => b.kind === 'projected');

  const pick = (clientX: number, rect: DOMRect) => {
    const i = Math.floor((clientX - rect.left - PAD.left) / slot);
    return Math.max(0, Math.min(n - 1, i));
  };
  const onPointer = (e: PointerEvent<SVGRectElement>) => setActive(pick(e.clientX, (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()));
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight') setActive((a) => Math.min(n - 1, (a ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? n) - 1));
    else if (e.key === 'Enter' && active !== null) onSelect?.(active);
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  };
  const tipLeft = active === null ? 0 : Math.min(Math.max(cx(active) - 90, 0), width - 184);
  const tip = active === null ? null : bars[active]!;

  return (
    <figure className="chart" aria-labelledby={titleId}>
      <figcaption id={titleId} className="visually-hidden">{title}</figcaption>
      <ul className="chart-legend">
        <li><span className="bar-key" aria-hidden="true" />{valueLabel}</li>
        {firstAhead >= 0 && <li><span className="bar-key bar-key-ahead" aria-hidden="true" />{t('chart.projected')}</li>}
        {bars.some((b) => b.budget !== undefined) && <li><span className="line-key budget-key" aria-hidden="true" />{t('chart.budget')}</li>}
      </ul>
      <div ref={wrap} className="chart-box">
        <svg width={width} height={height} role="img" aria-label={title} tabIndex={0} onKeyDown={onKey} onBlur={() => setActive(null)}>
          {ticks.map((tv) => (
            <g key={tv}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(tv)} y2={y(tv)} className="chart-grid" />
              <text x={PAD.left - 6} y={y(tv)} className="chart-tick" textAnchor="end" dominantBaseline="middle">{compact(tv)}</text>
            </g>
          ))}
          {firstAhead > 0 && (
            <g>
              <rect x={PAD.left + slot * firstAhead} y={PAD.top} width={slot * (n - firstAhead)} height={plotH} className="chart-ahead" />
              <text x={PAD.left + slot * firstAhead + 4} y={PAD.top - 3} className="chart-ref-label">{t('chart.projected')} →</text>
            </g>
          )}
          {selected !== undefined && selected >= 0 && selected < n && <rect x={PAD.left + slot * selected} y={PAD.top} width={slot} height={plotH} rx={4} className="chart-selected" />}
          {bars.map((b, i) => (
            <g key={i}>
              <path
                d={column(cx(i) - bw / 2, bw, base, y(b.value))}
                className={`chart-bar ${b.kind === 'projected' ? 'chart-bar-ahead' : ''}`}
              />
              {b.budget !== undefined && <line x1={cx(i) - Math.min(bw / 2 + 4, slot / 2 - 3)} x2={cx(i) + Math.min(bw / 2 + 4, slot / 2 - 3)} y1={y(b.budget)} y2={y(b.budget)} className="chart-budget" />}
              {i % every === 0 && (
                <text x={cx(i)} y={height - 8} className={`chart-tick ${selected === i ? 'chart-tick-on' : ''}`} textAnchor="middle">{b.axis}</text>
              )}
            </g>
          ))}
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
              onPointer(e);
            }}
            onPointerUp={(e) => onSelect?.(pick(e.clientX, (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()))}
            onPointerMove={onPointer}
            onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
          />
        </svg>
        {tip && (
          <div className="chart-tip chart-tip-wide" style={{ left: tipLeft }} role="status">
            <div className="chart-tip-title">{tip.label}</div>
            <div className="chart-tip-row">
              <span className={`bar-key ${tip.kind === 'projected' ? 'bar-key-ahead' : ''}`} aria-hidden="true" />
              <strong>{formatMoney(tip.value)}</strong>
              <span className="muted">{tip.kind === 'projected' ? t('chart.projected') : tip.kind === 'current' ? t('chart.soFar') : valueLabel}</span>
            </div>
            {tip.budget !== undefined && (
              <>
                <div className="chart-tip-row">
                  <span className="line-key budget-key" aria-hidden="true" />
                  <strong>{formatMoney(tip.budget)}</strong>
                  <span className="muted">{t('chart.budget')}</span>
                </div>
                <div className="chart-tip-row muted">
                  {tip.value > tip.budget ? t('chart.over', { amount: formatMoney(tip.value - tip.budget) }) : t('chart.under', { amount: formatMoney(tip.budget - tip.value) })}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </figure>
  );
}

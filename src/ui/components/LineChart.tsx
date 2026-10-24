import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatMoney } from '../../domain/money';
import type { Cents } from '../../domain/types';

/**
 * Small SVG line chart for cash projections (dataviz skill specs): 2px lines,
 * a 10% wash under the first series, hairline grid, compact euro ticks, a
 * labelled reference line, crosshair + tooltip on touch, mouse and keyboard.
 * Identity never relies on colour alone: a legend for 2+ series and the
 * values in the tooltip and the table view below the chart.
 */

export interface Series {
  name: string;
  /** CSS colour token, e.g. var(--series-1). */
  color: string;
  values: Cents[];
  /** From this index on the line is a projection: drawn dashed. */
  dashFrom?: number;
}

export interface LineChartProps {
  labels: string[];
  /** Short labels for the x axis (shown at start, middle, end). */
  axisLabels?: string[];
  series: Series[];
  reference?: { value: Cents; label: string };
  /** Index to mark with a dot and a label (e.g. first month below the buffer). */
  mark?: { index: number; label: string };
  height?: number;
  title: string;
}

const PAD = { top: 16, right: 12, bottom: 28, left: 44 };

function compact(cents: Cents): string {
  const v = cents / 100;
  const abs = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1).replace('.', ',')}M`;
  if (abs >= 1000) return `${sign}${Math.round(abs / 1000)}K`;
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

export function LineChart({ labels, axisLabels, series, reference, mark, height = 220, title }: LineChartProps) {
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
  useEffect(() => setActive(null), [labels.length]);

  const n = labels.length;
  const all = series.flatMap((s) => s.values).concat(reference ? [reference.value] : []);
  const lo = Math.min(...all, 0);
  const hi = Math.max(...all, 1);
  const ticks = niceTicks(lo, hi);
  const yMin = Math.min(lo, ticks[0]!);
  const yMax = Math.max(hi, ticks.at(-1)!);
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
  const path = (vals: Cents[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const pathFrom = (vals: Cents[], from: number) => vals.map((v, i) => (i < from ? '' : `${i === from ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join('');
  const first = series[0];
  const area = first ? `${path(first.values)}L${x(n - 1)},${y(Math.max(yMin, 0))}L${x(0)},${y(Math.max(yMin, 0))}Z` : '';
  const xi = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);

  const pick = (clientX: number, rect: DOMRect) => {
    const rel = (clientX - rect.left - PAD.left) / plotW;
    setActive(Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1)))));
  };
  const onPointer = (e: PointerEvent<SVGRectElement>) => pick(e.clientX, (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect());
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight') setActive((a) => Math.min(n - 1, (a ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? n) - 1));
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  };
  const tipLeft = active === null ? 0 : Math.min(Math.max(x(active) - 80, 0), width - 168);

  return (
    <figure className="chart" aria-labelledby={titleId}>
      <figcaption id={titleId} className="visually-hidden">{title}</figcaption>
      {series.length > 1 && (
        <ul className="chart-legend">
          {series.map((s) => (
            <li key={s.name}>
              <span className="line-key" style={{ background: s.color }} aria-hidden="true" />
              {s.name}
            </li>
          ))}
        </ul>
      )}
      <div ref={wrap} className="chart-box">
        <svg width={width} height={height} role="img" aria-label={title} tabIndex={0} onKeyDown={onKey} onBlur={() => setActive(null)}>
          {ticks.map((tv) => (
            <g key={tv}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(tv)} y2={y(tv)} className="chart-grid" />
              <text x={PAD.left - 6} y={y(tv)} className="chart-tick" textAnchor="end" dominantBaseline="middle">{compact(tv)}</text>
            </g>
          ))}
          {xi.map((i) => (
            <text key={i} x={x(i)} y={height - 8} className="chart-tick" textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
              {(axisLabels ?? labels)[i]}
            </text>
          ))}
          {reference && (
            <g>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(reference.value)} y2={y(reference.value)} className="chart-ref" />
              <text x={PAD.left + plotW} y={y(reference.value) - 5} className="chart-ref-label" textAnchor="end">{reference.label}</text>
            </g>
          )}
          {first && <path d={area} style={{ fill: first.color }} className="chart-area" />}
          {series.map((s) =>
            s.dashFrom !== undefined && s.dashFrom < n - 1 ? (
              <g key={s.name}>
                <path d={path(s.values.slice(0, s.dashFrom + 1))} style={{ stroke: s.color }} className="chart-line" />
                <path d={pathFrom(s.values, s.dashFrom)} style={{ stroke: s.color }} className="chart-line chart-line-ahead" />
              </g>
            ) : (
              <path key={s.name} d={path(s.values)} style={{ stroke: s.color }} className="chart-line" />
            ),
          )}
          {mark && series[series.length - 1] && (
            <g>
              <circle cx={x(mark.index)} cy={y(series[series.length - 1]!.values[mark.index]!)} r={5} className="chart-mark" />
              <text
                x={x(mark.index)}
                y={y(series[series.length - 1]!.values[mark.index]!) + 18}
                className="chart-mark-label"
                textAnchor={mark.index > n * 0.7 ? 'end' : mark.index < n * 0.3 ? 'start' : 'middle'}
              >
                {mark.label}
              </text>
            </g>
          )}
          {active !== null && (
            <g>
              <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotH} className="chart-cross" />
              {series.map((s) => (
                <circle key={s.name} cx={x(active)} cy={y(s.values[active]!)} r={4} style={{ fill: s.color }} className="chart-dot" />
              ))}
            </g>
          )}
          <rect
            x={PAD.left}
            y={0}
            width={plotW}
            height={height}
            fill="transparent"
            onPointerDown={(e) => {
              // Touch and mouse do not move keyboard focus to the chart.
              e.preventDefault();
              onPointer(e);
            }}
            onPointerMove={onPointer}
            onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
          />
        </svg>
        {active !== null && (
          <div className="chart-tip" style={{ left: tipLeft }} role="status">
            <div className="chart-tip-title">{labels[active]}</div>
            {series.map((s) => (
              <div key={s.name} className="chart-tip-row">
                <span className="line-key" style={{ background: s.color }} aria-hidden="true" />
                <strong>{formatMoney(s.values[active]!)}</strong>
                {series.length > 1 && <span className="muted">{s.name}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}

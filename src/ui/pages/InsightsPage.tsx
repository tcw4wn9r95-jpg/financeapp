import { useMemo, useState } from 'react';
import { addMonths, todayIso } from '../../domain/dates';
import { analyseSpending, SPEND_GROUPS, sumPoints, type CategoryAnalysis, type Insight, type InsightAction, type MonthPoint, type SpendGroup, type SpendingAnalysis } from '../../domain/insights';
import { formatWholeEuros } from '../../domain/money';
import type { MonthKey, Transaction } from '../../domain/types';
import { monthName, t, type MessageKey } from '../../i18n';
import { changeBudgetLine } from '../actions';
import { BarChart, type Bar } from '../components/BarChart';
import { CategoryTransactions } from '../components/CategoryTransactions';
import { Dialog } from '../components/Dialog';
import { LineChart } from '../components/LineChart';
import { Money } from '../components/Money';
import { useToast } from '../components/Toast';
import { useBudgetInput, useDocumentTitle, useSettings, useStore, useVault } from '../hooks';
import { groupLabel } from '../labels';
import { href, useRoute } from '../router';
import { periodMonths, ProvisionsTab, TransfersTab } from './InsightsFlows';
import { TransactionDialog } from './TransactionsPage';

type Period = '6' | '12' | 'year';
const AHEAD = 6;

/** "1.234 €": insights speak in whole euros. */
export const euros = formatWholeEuros;
const monthAbbr = (m: MonthKey) => t(`month.${Number(m.slice(5))}` as MessageKey).slice(0, 3);

export function useSpendingAnalysis(period: Period = '12'): SpendingAnalysis {
  const input = useBudgetInput();
  const provisions = useStore('provisions');
  return useMemo(() => {
    const today = todayIso();
    const current = today.slice(0, 7);
    const from = period === 'year' ? `${current.slice(0, 4)}-01` : addMonths(current, -Number(period));
    return analyseSpending(input, { today, from, ahead: AHEAD, provisions });
  }, [input, provisions, period]);
}

/** The words of one insight. */
export function insightText(i: Insight): string {
  const v = i.values;
  const m = (k: string) => euros(Number(v[k]));
  switch (i.kind) {
    case 'over':
      return t('insight.over', { name: v.name!, over: v.over!, n: v.n!, spent: m('spent'), budget: m('budget'), gap: m('gap') });
    case 'under':
      return t('insight.under', { name: v.name!, n: v.n!, spent: m('spent'), budget: m('budget'), frees: m('frees'), year: euros(Number(v.frees) * 12) });
    case 'unused':
      return t('insight.unused', { name: v.name!, n: v.n!, budget: m('budget') });
    case 'unbudgeted':
      return t('insight.unbudgeted', { name: v.name!, n: v.n!, spent: m('spent') });
    case 'lumpy':
      return t('insight.lumpy', { name: v.name!, median: m('median'), max: m('max'), budget: m('budget') });
    case 'rising':
      return t('insight.rising', { name: v.name!, pct: v.pct!, recent: m('recent'), earlier: m('earlier') });
    case 'falling':
      return t('insight.falling', { name: v.name!, pct: v.pct!, recent: m('recent'), earlier: m('earlier') });
    case 'pace':
      return v.already ? t('insight.paceOver', { name: v.name!, spent: m('spent'), budget: m('budget') }) : t('insight.pace', { name: v.name!, spent: m('spent'), pace: m('pace'), budget: m('budget') });
    case 'carried':
      return t('insight.carried', { name: v.name!, short: m('short') });
    case 'yearEnd':
      return t('insight.yearEnd', { year: v.year!, projected: m('projected'), budget: m('budget'), gap: m('gap') });
    case 'onTrack':
      return t('insight.onTrack', { year: v.year!, projected: m('projected'), budget: m('budget'), gap: m('gap') });
    case 'drivers':
      return t('insight.drivers', { names: v.names!, share: v.share! });
    case 'unfiled':
      return t('insight.unfiled', { count: v.count!, out: m('out') });
  }
}

function actionLabel(a: InsightAction): string {
  if (a.type === 'inbox') return t('insight.toInbox');
  if (a.type === 'cover') return t('insight.cover');
  return a.amount === 0 ? t('insight.stopFrom', { month: monthName(a.from) }) : t('insight.setFrom', { amount: euros(a.amount), month: monthName(a.from) });
}

/** Carry out an insight's action, with Undo. */
function useRunAction() {
  const vault = useVault();
  const notify = useToast();
  return async (a: InsightAction, name: string) => {
    if (a.type === 'inbox') {
      window.location.hash = href('inbox');
      return;
    }
    const undo = a.type === 'cover'
      ? await changeBudgetLine(vault, a.categoryId, a.amount, a.month, 'month', t('insight.coverNote'))
      : await changeBudgetLine(vault, a.categoryId, a.amount, a.from, 'default');
    notify(a.type === 'cover' ? t('insight.covered', { name }) : t('insight.changed', { name, amount: euros(a.amount), month: monthName(a.from) }), 'ok', {
      label: t('inbox.undo'),
      run: () => void undo().then(() => notify(t('insight.undone'))),
    });
  };
}

const SEVERITY_ICON = { warn: '⚠', tip: '→', info: 'ℹ' } as const;

function InsightCard({ insight, onDetail }: { insight: Insight; onDetail?: () => void }) {
  const run = useRunAction();
  return (
    <li className={`insight insight-${insight.severity}`}>
      <p className="insight-kind">
        <span aria-hidden="true">{SEVERITY_ICON[insight.severity]} </span>
        {t(`insight.sev.${insight.severity}` as MessageKey)}
      </p>
      <p className="insight-text">{insightText(insight)}</p>
      {(insight.action || onDetail) && (
        <div className="insight-actions">
          {insight.action && (
            <button type="button" className="button button-small" onClick={() => void run(insight.action!, String(insight.values.name ?? ''))}>
              {actionLabel(insight.action)}
            </button>
          )}
          {onDetail && <button type="button" className="link-button" onClick={onDetail}>{t('insight.details')}</button>}
        </div>
      )}
    </li>
  );
}

/** Overspending carried in several categories, as one card. */
function CarriedCard({ items, onDetail }: { items: Insight[]; onDetail: (id: string) => void }) {
  const run = useRunAction();
  const total = items.reduce((s, i) => s + Number(i.values.short), 0);
  return (
    <li className="insight insight-warn">
      <p className="insight-kind"><span aria-hidden="true">⚠ </span>{t('insight.sev.warn')}</p>
      <p className="insight-text">{t('insight.carriedAll', { n: items.length, total: euros(total) })}</p>
      <ul className="plain-list carried-list">
        {items.map((i) => (
          <li key={i.categoryId} className="split-row">
            <button type="button" className="link-button" onClick={() => onDetail(i.categoryId!)}>{String(i.values.name)}</button>
            <span className="carried-end">
              <Money cents={-Number(i.values.short)} />
              <button type="button" className="button button-small" onClick={() => void run(i.action!, String(i.values.name))}>{t('insight.cover')}</button>
            </span>
          </li>
        ))}
      </ul>
      <p className="hint">{t('insight.carriedHint')}</p>
    </li>
  );
}

export function InsightList({ insights, limit, onDetail }: { insights: Insight[]; limit?: number; onDetail?: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const carried = insights.filter((i) => i.kind === 'carried');
  // The carried ones sit together where the first of them ranks.
  const items: (Insight | 'carried')[] = [];
  for (const i of insights) {
    if (i.kind !== 'carried') items.push(i);
    else if (carried.length === 1) items.push(i);
    else if (!items.includes('carried')) items.push('carried');
  }
  const shown = limit && !all ? items.slice(0, limit) : items;
  if (items.length === 0) return <p className="muted">{t('insight.none')}</p>;
  return (
    <>
      <ul className="plain-list insight-list">
        {shown.map((i, k) =>
          i === 'carried' ? (
            <CarriedCard key="carried" items={carried} onDetail={(id) => onDetail?.(id)} />
          ) : (
            <InsightCard key={`${i.kind}-${i.categoryId ?? k}`} insight={i} {...(onDetail && i.categoryId ? { onDetail: () => onDetail(i.categoryId!) } : {})} />
          ),
        )}
      </ul>
      {limit && items.length > limit && (
        <button type="button" className="link-button" onClick={() => setAll(!all)}>{all ? t('insight.fewer') : t('insight.all', { n: items.length })}</button>
      )}
    </>
  );
}

const toBars = (points: MonthPoint[]): Bar[] =>
  points.map((p) => ({ label: monthName(p.month), axis: monthAbbr(p.month), value: p.spent, budget: p.budgeted, kind: p.kind }));

function PointsTable({ points, caption }: { points: MonthPoint[]; caption: string }) {
  return (
    <details className="table-twin">
      <summary>{caption}</summary>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t('plan.month')}</th>
            <th scope="col" className="num">{t('chart.budget')}</th>
            <th scope="col" className="num">{t('chart.spent')}</th>
            <th scope="col" className="num">{t('insights.diff')}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.month} className={p.kind === 'projected' ? 'row-ahead' : undefined}>
              <th scope="row">{monthAbbr(p.month)} {p.month.slice(2, 4)}{p.kind === 'projected' ? ' *' : p.kind === 'current' ? ' …' : ''}</th>
              <td className="num">{euros(p.budgeted)}</td>
              <td className="num">{euros(p.spent)}</td>
              <td className="num">{euros(p.budgeted - p.spent)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">{t('insights.tableNote')}</p>
    </details>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <p className="tile-label">{label}</p>
      <p className="tile-value">{value}</p>
      {sub && <p className="tile-sub">{sub}</p>}
    </div>
  );
}

/** One category: month by month, its insights, and the transactions of a month. */
function CategoryDialog({ c, a, onClose }: { c: CategoryAnalysis; a: SpendingAnalysis; onClose: () => void }) {
  const history = c.points.filter((p) => p.kind !== 'projected');
  const [sel, setSel] = useState(history.length - 1);
  const [open, setOpen] = useState<Transaction | null>(null);
  if (open) return <TransactionDialog tx={open} onClose={() => setOpen(null)} />;
  const point = c.points[sel];
  const insights = a.insights.filter((i) => i.categoryId === c.category.id);
  return (
    <Dialog open title={c.category.name} onClose={onClose} wide>
      <p className="muted">{groupLabel(c.group)}</p>
      <div className="tiles">
        <Tile label={t('insights.avgSpent')} value={euros(c.avgSpent)} sub={t('insights.overN', { n: c.fullMonths })} />
        <Tile label={t('insights.budgetNow')} value={euros(c.assignedNow)} sub={t('insights.avgBudget', { amount: euros(c.avgBudget) })} />
        <Tile label={t('insights.usual')} value={euros(c.typical)} sub={t(`insights.usualHow.${c.group}` as MessageKey)} />
        <Tile label={t('insights.overMonths')} value={`${c.overMonths} / ${c.fullMonths}`} sub={t('insights.underMonths', { n: c.underMonths })} />
      </div>
      <BarChart bars={toBars(c.points)} title={t('insights.catChart', { name: c.category.name })} selected={sel} onSelect={(i) => setSel(i)} />
      <p className="hint">{t('insights.tapBar')}</p>
      <PointsTable points={c.points} caption={t('plan.table')} />
      {insights.length > 0 && (
        <>
          <h3 className="plan-h">{t('insights.title')}</h3>
          <InsightList insights={insights} />
        </>
      )}
      {point && point.kind !== 'projected' ? (
        <CategoryTransactions categoryId={c.category.id} month={point.month} onOpen={setOpen} />
      ) : point ? (
        <p className="hint">{t('insights.projectedHow', { month: monthName(point.month) })}</p>
      ) : null}
      <div className="row">
        <a className="button" href={href(`budget/${point?.kind === 'projected' ? a.current : point?.month ?? a.current}`)} onClick={onClose}>{t('insights.toBudget')}</a>
        <button type="button" className="button button-quiet" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Dialog>
  );
}

/** Spending by category, biggest first, with a bar against its budget. */
function CategoryList({ cats, onOpen }: { cats: CategoryAnalysis[]; onOpen: (c: CategoryAnalysis) => void }) {
  const sorted = [...cats].sort((x, y) => y.avgSpent - x.avgSpent || y.avgBudget - x.avgBudget);
  return (
    <ul className="rows">
      {sorted.map((c) => {
        const scale = Math.max(c.avgSpent, c.avgBudget, 1);
        const diff = c.avgBudget - c.avgSpent;
        return (
          <li key={c.category.id}>
            <button type="button" className="row-button" onClick={() => onOpen(c)}>
              <span className="row-main">
                <span className="row-title">{c.category.name}</span>
                <span className="row-sub">{t('insights.rowSub', { spent: euros(c.avgSpent), budget: euros(c.avgBudget) })}</span>
                <span className="bullet" aria-hidden="true">
                  <span className="bullet-fill" style={{ width: `${Math.max(0, Math.min(100, (c.avgSpent / scale) * 100))}%` }} />
                  {c.avgBudget > 0 && <span className="bullet-mark" style={{ left: `${Math.min(100, (c.avgBudget / scale) * 100)}%` }} />}
                </span>
              </span>
              <span className="row-end">
                <span className={`row-amount ${diff < 0 ? 'bad' : ''}`}>
                  {diff < 0 ? t('insights.overBy', { amount: euros(-diff) }) : diff > 0 ? t('insights.underBy', { amount: euros(diff) }) : t('insights.onBudget')}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Insights (D-86): what was budgeted and spent, month by month and per
 * category; where the year is heading; and what to do about it.
 */
export function InsightsPage() {
  useDocumentTitle(t('nav.insights'));
  const route = useRoute();
  const tab = (['spending', 'transfers', 'provisions'] as const).find((x) => x === route.query.get('tab')) ?? 'spending';
  const settings = useSettings();
  const [period, setPeriod] = useState<Period>('12');
  const [group, setGroup] = useState<SpendGroup | 'all'>('all');
  const [detail, setDetail] = useState<string | null>(null);
  const a = useSpendingAnalysis(period);
  const cats = a.categories.filter((c) => group === 'all' || c.group === group);
  const allMonths = [...a.months, ...a.ahead];
  const kindOf = (m: MonthKey) => (m === a.current ? 'current' : allMonths.indexOf(m) >= a.months.length ? 'projected' : 'past');
  const totals = sumPoints(cats, allMonths, kindOf);
  const allTotals = sumPoints(a.categories, allMonths, kindOf);
  const full = totals.filter((p) => p.kind === 'past');
  const n = full.length;
  const avgSpent = n ? Math.round(full.reduce((s, p) => s + p.spent, 0) / n) : 0;
  const avgBudget = n ? Math.round(full.reduce((s, p) => s + p.budgeted, 0) / n) : 0;
  const overCount = full.filter((p) => p.spent > p.budgeted).length;
  const income = a.fullMonths.reduce((s, m) => s + (a.income.get(m) ?? 0), 0);
  const spentAll = allTotals.filter((p) => p.kind === 'past').reduce((s, p) => s + p.spent, 0);
  const saved = n ? Math.round((income - spentAll) / n) : 0;
  const rate = income > 0 ? Math.round(((income - spentAll) / income) * 100) : 0;
  const end = a.year.at(-1);
  const detailCat = detail ? a.categories.find((c) => c.category.id === detail) : undefined;

  // Income and spending month by month: the current month uses its estimate.
  const estimateNow = a.categories.reduce((s, c) => s + c.currentEstimate, 0);
  const flowMonths = allMonths;
  const flowSpent = allTotals.map((p) => (p.kind === 'current' ? estimateNow : p.spent));
  const flowIncome = flowMonths.map((m) => (m === a.current ? Math.max(a.income.get(m) ?? 0, a.expectedIncomeNow) : a.income.get(m) ?? 0));
  const nowIndex = flowMonths.indexOf(a.current);
  const yearNow = a.year.findIndex((y) => y.month === a.current);

  return (
    <>
      <div className="page-head">
        <h1>{t('nav.insights')}</h1>
      </div>
      <p className="hint">{t('insights.intro')}</p>

      <nav className="chips" aria-label={t('insights.tabs')}>
        {(['spending', 'transfers', 'provisions'] as const).map((x) => (
          <a key={x} className="chip" href={href('insights', { tab: x === 'spending' ? undefined : x })} aria-current={tab === x ? 'page' : undefined}>
            {t(`insights.tab.${x}`)}
          </a>
        ))}
      </nav>

      <div className="toolbar filter-row">
        <label>
          <span className="visually-hidden">{t('insights.period')}</span>
          <select value={period} onChange={(e) => setPeriod(e.target.value as Period)} aria-label={t('insights.period')}>
            <option value="6">{t('insights.last6')}</option>
            <option value="12">{t('insights.last12')}</option>
            <option value="year">{t('insights.thisYear')}</option>
          </select>
        </label>
        {tab === 'spending' && (
        <label>
          <span className="visually-hidden">{t('insights.show')}</span>
          <select value={group} onChange={(e) => setGroup(e.target.value as SpendGroup | 'all')} aria-label={t('insights.show')}>
            <option value="all">{t('insights.allSpending')}</option>
            {SPEND_GROUPS.map((g) => <option key={g} value={g}>{groupLabel(g)}</option>)}
          </select>
        </label>
        )}
      </div>

      {tab === 'transfers' ? (
        <TransfersTab months={periodMonths(period, settings.budgetStartMonth)} />
      ) : tab === 'provisions' ? (
        <ProvisionsTab months={periodMonths(period, settings.budgetStartMonth)} />
      ) : null}

      {tab !== 'spending' ? null : a.months.length === 0 ? (
        <p className="muted">{t('insights.noData')}</p>
      ) : (
        <>
          <div className="tiles">
            <Tile label={t('insights.avgSpent')} value={euros(avgSpent)} sub={avgSpent > avgBudget ? t('insights.tileOver', { amount: euros(avgSpent - avgBudget) }) : t('insights.tileUnder', { amount: euros(avgBudget - avgSpent) })} />
            <Tile label={t('insights.avgBudgeted')} value={euros(avgBudget)} sub={t('insights.overBudgetIn', { over: overCount, n })} />
            <Tile label={t('insights.saved')} value={euros(saved)} sub={t('insights.rate', { rate })} />
            {end && <Tile label={t('insights.yearEnd', { year: end.month.slice(0, 4) })} value={euros(end.projected)} sub={t('insights.vsBudget', { amount: euros(end.budget) })} />}
          </div>
          {n === 0 && <p className="notice">{t('insights.fewMonths')}</p>}

          <section className="card" aria-labelledby="ins-h">
            <h2 id="ins-h" className="card-title">{t('insights.title')}</h2>
            <InsightList insights={a.insights} limit={6} onDetail={setDetail} />
          </section>

          <section className="card" aria-labelledby="bars-h">
            <h2 id="bars-h" className="card-title">{t('insights.monthly')}</h2>
            <p className="hint">{t('insights.monthlyHint')}</p>
            <BarChart bars={toBars(totals)} title={t('insights.monthly')} />
            <PointsTable points={totals} caption={t('plan.table')} />
          </section>

          {end && (
            <section className="card" aria-labelledby="year-h">
              <h2 id="year-h" className="card-title">{t('insights.yearTitle', { year: end.month.slice(0, 4) })}</h2>
              <LineChart
                title={t('insights.yearTitle', { year: end.month.slice(0, 4) })}
                labels={a.year.map((y) => monthName(y.month))}
                axisLabels={a.year.map((y) => monthAbbr(y.month))}
                series={[
                  { name: t('insights.spending'), color: 'var(--series-1)', values: a.year.map((y) => y.projected), ...(yearNow >= 0 ? { dashFrom: Math.max(0, yearNow - 1) } : {}) },
                  { name: t('chart.budget'), color: 'var(--muted)', values: a.year.map((y) => y.budget) },
                ]}
              />
              <p className="hint">{t(end.projected > end.budget ? 'insights.yearOver' : 'insights.yearUnder', { projected: euros(end.projected), budget: euros(end.budget), gap: euros(Math.abs(end.projected - end.budget)) })}</p>
            </section>
          )}

          <section className="card" aria-labelledby="flow-h">
            <h2 id="flow-h" className="card-title">{t('insights.flowTitle')}</h2>
            <LineChart
              title={t('insights.flowTitle')}
              labels={flowMonths.map((m) => monthName(m))}
              axisLabels={flowMonths.map((m) => monthAbbr(m))}
              series={[
                { name: t('insights.spending'), color: 'var(--series-1)', values: flowSpent, ...(nowIndex > 0 ? { dashFrom: nowIndex - 1 } : {}) },
                { name: t('insights.income'), color: 'var(--series-2)', values: flowIncome, ...(nowIndex > 0 ? { dashFrom: nowIndex - 1 } : {}) },
              ]}
            />
            <p className="hint">{t('insights.flowHint')}</p>
            <details className="table-twin">
              <summary>{t('plan.table')}</summary>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t('plan.month')}</th>
                    <th scope="col" className="num">{t('insights.income')}</th>
                    <th scope="col" className="num">{t('insights.spending')}</th>
                    <th scope="col" className="num">{t('insights.savedCol')}</th>
                  </tr>
                </thead>
                <tbody>
                  {flowMonths.map((m, i) => (
                    <tr key={m} className={i > nowIndex ? 'row-ahead' : undefined}>
                      <th scope="row">{monthAbbr(m)} {m.slice(2, 4)}{i > nowIndex ? ' *' : i === nowIndex ? ' …' : ''}</th>
                      <td className="num">{euros(flowIncome[i]!)}</td>
                      <td className="num">{euros(flowSpent[i]!)}</td>
                      <td className="num">{euros(flowIncome[i]! - flowSpent[i]!)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint">{t('insights.tableNote')}</p>
            </details>
          </section>

          <section className="card" aria-labelledby="cats-h">
            <h2 id="cats-h" className="card-title">{t('insights.byCategory')}</h2>
            <p className="hint">{t('insights.byCategoryHint', { n })}</p>
            {(group === 'all' ? SPEND_GROUPS : [group]).map((g) => {
              const list = cats.filter((c) => c.group === g);
              if (list.length === 0) return null;
              return (
                <div key={g} className="cat-group">
                  <h3 className="section-title">{groupLabel(g)}</h3>
                  <CategoryList cats={list} onOpen={(c) => setDetail(c.category.id)} />
                </div>
              );
            })}
          </section>
          {a.unfiled.count > 0 && (
            <p className="hint">
              {t('insights.unfiledNote', { count: a.unfiled.count, out: euros(a.unfiled.out) })} <a href={href('inbox')}>{t('explain.toInbox')}</a>
            </p>
          )}
        </>
      )}
      {detailCat && <CategoryDialog c={detailCat} a={a} onClose={() => setDetail(null)} />}
    </>
  );
}

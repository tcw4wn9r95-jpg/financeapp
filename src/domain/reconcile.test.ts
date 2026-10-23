import { describe, expect, it } from 'vitest';
import { budgetForMonth } from './budget';
import { classify, cleanUpMirrors, fileSuggestedTransfers, pairOpenTransfers, repairWeakPairs, settleGroupedTransfers, ReconcileError, unclassify } from './reconcile';
import { testClock, World } from './testkit';
import type { Allocation, Transaction } from './types';

const tx = (id: string, accountId: string, amount: number, date = '2026-09-10'): Transaction => ({
  id, accountId, date, amount, descriptionRaw: 'To Compte flexible', merchantNorm: 'COMPTE FLEXIBLE', counterparty: '',
  status: 'new', createdAt: '', updatedAt: '', source: 'manual',
});

describe('splitting one payment into categories and accounts (D-51)', () => {
  it('800 € from Revolut: 300 € for a provision, 500 € to the savings account', () => {
    const w = new World('2026-01');
    w.account('rev', 'current', 200000);
    w.account('sav', 'savings', 0);
    w.category('carIns', 'provisions', 'roll');
    const t = tx('t1', 'rev', -80000);
    const view = { accounts: w.accounts, transactions: [t], allocations: [] };
    const ch = classify(t, { kind: 'split', lines: [{ kind: 'category', categoryId: 'carIns', amount: -30000 }, { kind: 'transfer', accountId: 'sav', amount: -50000 }] }, view, testClock());
    const mirror = ch.putTransactions.find((x) => x.accountId === 'sav')!;
    expect(mirror).toMatchObject({ amount: 50000, isMirror: true });
    expect(ch.putAllocations.filter((a) => a.transactionId === 't1').map((a) => [a.targetType, a.amount])).toEqual([
      ['category', -30000],
      ['transfer', -50000],
    ]);
    w.transactions = [...ch.putTransactions];
    w.allocations = [...ch.putAllocations];
    const sep = budgetForMonth(w.input(), '2026-09')!;
    expect(sep.categories.get('carIns')!.activity).toBe(-30000);
    expect(sep.uncategorised).toBe(0);
    // Undo removes the created savings side.
    const back = unclassify(w.transactions.find((x) => x.id === 't1')!, { accounts: w.accounts, transactions: w.transactions, allocations: w.allocations }, testClock());
    expect(back.deleteTransactions).toEqual([mirror.id]);
  });

  it('pairs a part with a matching row already imported in the other account; rejects unbalanced splits', () => {
    const w = new World('2026-01');
    w.account('rev', 'current', 0);
    w.account('sav', 'savings', 0);
    w.category('fun', 'variable', 'roll');
    const t = tx('t1', 'rev', -80000);
    const arrived = tx('t2', 'sav', 50000, '2026-09-11');
    const view = { accounts: w.accounts, transactions: [t, arrived], allocations: [] };
    const ch = classify(t, { kind: 'split', lines: [{ kind: 'category', categoryId: 'fun', amount: -30000 }, { kind: 'transfer', accountId: 'sav', amount: -50000 }] }, view, testClock());
    expect(ch.putTransactions.find((x) => x.id === 't2')).toMatchObject({ status: 'reconciled' });
    expect(ch.putTransactions.some((x) => x.isMirror)).toBe(false);
    expect(() => classify(t, { kind: 'split', lines: [{ kind: 'transfer', accountId: 'sav', amount: -50000 }] }, view, testClock())).toThrow(ReconcileError);
  });
});

describe('inbox sorted by repeats (D-63, D-72)', () => {
  it('groups the same transaction again (same merchant, same amount), most repeated first, newest first', async () => {
    const { byRepeats, similar } = await import('./reconcile');
    const m = (id: string, merchant: string, amount: number, date: string): Transaction => ({ ...tx(id, 'a', amount, date), merchantNorm: merchant, descriptionRaw: merchant });
    const items = [
      m('1', 'BAKERY', -500, '2026-09-20'),
      m('2', 'NETFLIX', -1099, '2026-09-01'),
      m('3', 'NETFLIX', -1099, '2026-09-15'),
      m('4', 'SUPERMARKET', -4000, '2026-09-16'), // same shop, other amount: not the same transaction
      m('5', 'NETFLIX', -1099, '2026-09-10'),
      m('6', 'SUPERMARKET', -3000, '2026-09-30'),
      m('7', 'NETFLIX', 1099, '2026-09-11'), // a refund: other direction
    ];
    const r = byRepeats(items);
    expect(r.items.map((x) => x.id)).toEqual(['3', '5', '2', '6', '1', '4', '7']);
    expect([r.count.get('3'), r.count.get('4'), r.count.get('7')]).toEqual([3, 1, 1]);
    expect(similar(items[1]!, items).map((x) => x.id).sort()).toEqual(['3', '5']);
    expect(similar(items[3]!, items)).toEqual([]);
  });
});

describe('transfers into accounts whose own statements cover them (D-68)', () => {
  const imported = (id: string, accountId: string, amount: number, date: string): Transaction => ({ ...tx(id, accountId, amount, date), importBatchId: 'b', descriptionRaw: id, merchantNorm: id });

  it('a top-up made of several transfers, bought as one sum, leaves no duplicate', () => {
    const w = new World('2026-01');
    w.account('rev', 'current', 0);
    w.account('flex', 'savings', 0);
    // Revolut: four transfers to Flexible on 22 Aug; Flexible's own export: one 2,700 purchase on 24 Aug.
    const rev = [...[300, 350, 600, 1450].map((e, i) => imported(`r${i}`, 'rev', -e * 100, '2026-08-22')), imported('r9', 'rev', -500, '2026-09-30')];
    const flex = [imported('f0', 'flex', 50000, '2026-08-01'), imported('f1', 'flex', 270000, '2026-08-24'), imported('f2', 'flex', 10000, '2026-09-30')];
    let view = { accounts: w.accounts, transactions: [...rev, ...flex], allocations: [] as Allocation[] };
    const apply = (ch: ReturnType<typeof classify>) => {
      const del = new Set([...ch.deleteAllocations]);
      const delT = new Set(ch.deleteTransactions);
      const tIds = new Set(ch.putTransactions.map((t) => t.id));
      const aIds = new Set(ch.putAllocations.map((a) => a.id));
      view = {
        accounts: view.accounts,
        transactions: [...view.transactions.filter((t) => !delT.has(t.id) && !tIds.has(t.id)), ...ch.putTransactions],
        allocations: [...view.allocations.filter((a) => !del.has(a.id) && !aIds.has(a.id)), ...ch.putAllocations],
      };
    };
    const clock = testClock();
    for (const r of rev.slice(0, 4)) apply(classify(view.transactions.find((t) => t.id === r.id)!, { kind: 'transfer', accountId: 'flex' }, view, clock));
    apply(classify(view.transactions.find((t) => t.id === 'f1')!, { kind: 'transfer', accountId: 'rev' }, view, clock));
    expect(view.transactions.filter((t) => t.isMirror)).toHaveLength(0);
    const balance = (id: string) => view.transactions.filter((t) => t.accountId === id).reduce((s, t) => s + t.amount, 0);
    expect(balance('flex')).toBe(330000);
    // Both sides count as transfers between own accounts: nothing left uncategorised.
    const b = budgetForMonth({ startMonth: '2026-01', categories: [], defaults: [], overrides: [], accounts: view.accounts, transactions: view.transactions.filter((t) => t.date.startsWith('2026-08') && t.id !== 'f0' && t.id !== 'r9'), allocations: view.allocations }, '2026-08')!;
    expect(b.uncategorised).toBe(0);
  });

  it('cleans up mirrors left in a covered period: the real open row takes over, or the transfer points at the account', () => {
    const w = new World('2026-01');
    w.account('rev', 'current', 0);
    w.account('flex', 'savings', 0);
    w.account('visa', 'card', 0);
    const r1 = imported('r1', 'rev', -100000, '2026-05-20');
    const r2 = imported('r2', 'rev', -75000, '2026-05-20');
    const r3 = imported('r3', 'rev', -40000, '2026-05-07');
    const m1: Transaction = { ...tx('m1', 'flex', 100000, '2026-05-20'), isMirror: true, status: 'reconciled' };
    const m2: Transaction = { ...tx('m2', 'flex', 75000, '2026-05-20'), isMirror: true, status: 'reconciled' };
    const m3: Transaction = { ...tx('m3', 'visa', 40000, '2026-05-07'), isMirror: true, status: 'reconciled' };
    const f1 = imported('f1', 'flex', 100000, '2026-05-21'); // matches m1
    const f0 = imported('f0', 'flex', 5000, '2026-05-01');
    const f9 = imported('f9', 'flex', 5000, '2026-06-30');
    const a = (id: string, from: string, to: string, amount: number): Allocation => ({ id, createdAt: '', updatedAt: '', source: 'manual', transactionId: from, targetType: 'transfer', targetId: to, amount, confidence: 1, decidedBy: 'user', reason: '' });
    const view = {
      accounts: w.accounts,
      transactions: [r1, r2, r3, m1, m2, m3, f0, f1, f9],
      allocations: [a('a1', 'r1', 'm1', -100000), a('a1m', 'm1', 'r1', 100000), a('a2', 'r2', 'm2', -75000), a('a2m', 'm2', 'r2', 75000), a('a3', 'r3', 'm3', -40000), a('a3m', 'm3', 'r3', 40000)],
    };
    const { changes, fixed } = cleanUpMirrors(view, testClock());
    expect(fixed).toBe(2); // the card's mirror stays: card statements do not list repayments
    expect(changes.deleteTransactions.sort()).toEqual(['m1', 'm2']);
    expect(changes.putAllocations.find((x) => x.id === 'a1')!.targetId).toBe('f1');
    expect(changes.putAllocations.find((x) => x.transactionId === 'f1')!.targetId).toBe('r1');
    expect(changes.putAllocations.find((x) => x.id === 'a2')!.targetId).toBe('flex');
  });
});

describe('transfers between own accounts are picked up in the inbox (D-71)', () => {
  const row = (id: string, accountId: string, amount: number, date: string, descriptionRaw: string, over: Partial<Transaction> = {}): Transaction => ({
    ...tx(id, accountId, amount, date), descriptionRaw, merchantNorm: descriptionRaw.toUpperCase(), importBatchId: 'b', ...over,
  });

  it('a card top-up booked days later is paired by the date written in its text', () => {
    const w = new World('2026-01');
    w.account('spk', 'current', 0);
    w.account('rev', 'current', 0);
    const spk = row('s', 'spk', -50000, '2026-02-02', 'DEBIT REVOLUT**3501* 29.01');
    const rev = row('r', 'rev', 50000, '2026-01-29', 'Apple Pay deposit by *7418');
    const far = row('x', 'rev', 50000, '2026-01-10', 'Apple Pay deposit by *7418');
    const { changes, paired } = pairOpenTransfers({ accounts: w.accounts, transactions: [spk, rev, far], allocations: [] }, testClock());
    expect(paired).toBe(1);
    expect(changes.putAllocations.map((a) => `${a.transactionId}>${a.targetId}`).sort()).toEqual(['r>s', 's>r']);
  });

  it('links the second side to the first when the first was filed as a transfer to that account', () => {
    const w = new World('2026-01');
    w.account('spk', 'current', 0);
    w.account('rev', 'current', 0);
    const rev = row('r', 'rev', 50000, '2026-07-30', 'Apple Pay deposit by *7845', { status: 'reconciled' });
    const loose: Allocation = { id: 'a1', createdAt: '', updatedAt: '', source: 'manual', transactionId: 'r', targetType: 'transfer', targetId: 'spk', amount: 50000, confidence: 1, decidedBy: 'user', reason: '' };
    const spk = row('s', 'spk', -50000, '2026-07-31', 'INSTANT CREDIT TRANSFER S-NET');
    const { changes, paired } = pairOpenTransfers({ accounts: w.accounts, transactions: [rev, spk], allocations: [loose] }, testClock());
    expect(paired).toBe(1);
    expect(changes.deleteAllocations).toEqual(['a1']);
    expect(changes.putAllocations.map((a) => `${a.transactionId}>${a.targetId}`).sort()).toEqual(['r>s', 's>r']);
  });

  it('leaves alone rows without a transfer-like text, too far apart, or already paired elsewhere', () => {
    const w = new World('2026-01');
    w.account('a', 'current', 0);
    w.account('b', 'current', 0);
    const shop = row('s', 'a', -1359, '2026-05-13', 'Kine Madalena Martins');
    const refund = row('r', 'b', 1359, '2026-05-14', 'AXA ASSURANCES');
    const t1 = row('t1', 'a', -30000, '2026-03-01', 'Transfer to savings');
    const t2 = row('t2', 'b', 30000, '2026-03-09', 'Transfer from current');
    expect(pairOpenTransfers({ accounts: w.accounts, transactions: [shop, refund, t1, t2], allocations: [] }, testClock()).paired).toBe(0);
  });
});

describe('sure transfer suggestions are filed without a tap (D-71)', () => {
  it('files a transfer named in the text, and a loan payment with its own budget line; leaves unsure ones', () => {
    const w = new World('2026-01');
    w.account('rev', 'current', 0);
    w.account('flex', 'savings', 0);
    w.accounts.push({ id: 'car', createdAt: '', updatedAt: '', source: 'manual', name: 'Car loan', type: 'loan', institution: '', ibanLast4: '', openingBalance: -500000, categoryId: 'carCat' });
    const sg = (targetId: string, confidence: number) => ({ targetType: 'transfer' as const, targetId, confidence, decidedBy: 'rule' as const, reason: 'Mentions it' });
    const a: Transaction = { ...tx('a', 'rev', -30000, '2026-08-15'), status: 'suggested', suggestion: sg('flex', 0.9) };
    const b: Transaction = { ...tx('b', 'rev', -18888, '2026-08-20'), status: 'suggested', suggestion: sg('car', 0.9) };
    const c: Transaction = { ...tx('c', 'rev', -1000, '2026-08-21'), status: 'suggested', suggestion: sg('flex', 0.6) };
    const { changes, filed } = fileSuggestedTransfers({ accounts: w.accounts, transactions: [a, b, c], allocations: [] }, testClock());
    expect(filed).toBe(2);
    const of = (id: string) => changes.putAllocations.filter((x) => x.transactionId === id).map((x) => `${x.targetType}:${x.targetId}`);
    expect(of('a')).toHaveLength(1);
    expect(of('b')).toEqual(['category:carCat']);
    expect(of('c')).toEqual([]);
  });

  it('a loan without its own budget line is just a transfer to the loan: no category, no question (D-82)', () => {
    const w = new World('2026-01');
    w.account('rev', 'current', 0);
    w.accounts.push({ id: 'ikea', createdAt: '', updatedAt: '', source: 'manual', name: 'Ikea loan', type: 'loan', institution: '', ibanLast4: '', openingBalance: -200000 });
    const a: Transaction = { ...tx('a', 'rev', -23754, '2026-08-07'), status: 'suggested', suggestion: { targetType: 'transfer', targetId: 'ikea', confidence: 0.9, decidedBy: 'rule', reason: 'Repayment of Ikea loan' } };
    const { changes, filed } = fileSuggestedTransfers({ accounts: w.accounts, transactions: [a], allocations: [] }, testClock());
    expect(filed).toBe(1);
    expect(changes.putAllocations.map((x) => x.targetType)).toEqual(['transfer', 'transfer']);
    expect(changes.putTransactions.find((t) => t.accountId === 'ikea')!.amount).toBe(23754); // the loan goes down
  });
});

describe('transfers sent in pieces and received as one (D-81)', () => {
  const row = (id: string, accountId: string, amount: number, date: string, descriptionRaw: string, over: Partial<Transaction> = {}): Transaction => ({
    ...tx(id, accountId, amount, date), descriptionRaw, merchantNorm: descriptionRaw.toUpperCase(), importBatchId: 'b', ...over,
  });
  const base = () => {
    const w = new World('2026-01');
    w.account('rev', 'current', 0);
    w.account('flex', 'savings', 0);
    return w;
  };

  it('300 + 350 + 600 + 1,450 sent, 2,700 received: the received row and the pieces are filed together', () => {
    const w = base();
    const pieces = [300, 350, 600, 1450].map((e, i) => row(`p${i}`, 'rev', -e * 100, '2026-08-22', 'To EUR Compte flexible'));
    const big = row('big', 'flex', 270000, '2026-08-24', 'Flexible savings: money in');
    const other = row('other', 'rev', -100000, '2026-08-22', 'To EUR Compte flexible'); // not part of it
    const { changes, settled } = settleGroupedTransfers({ accounts: w.accounts, transactions: [...pieces, big, other], allocations: [] }, testClock());
    expect(settled).toBe(1);
    const filed = changes.putTransactions.map((t) => t.id).sort();
    expect(filed).toEqual(['big', 'p0', 'p1', 'p2', 'p3']);
    expect(changes.putAllocations.find((a) => a.transactionId === 'big')).toMatchObject({ targetType: 'transfer', targetId: 'rev' });
    expect(changes.putAllocations.filter((a) => a.targetId === 'flex')).toHaveLength(4);
  });

  it('pieces already filed as transfers to the account (pointing at it) are completed, not refiled', () => {
    const w = base();
    const mk = (id: string, e: number): Transaction => row(id, 'rev', -e * 100, '2026-08-22', 'To EUR Compte flexible', { status: 'reconciled' });
    const pieces = [mk('a', 300), mk('b', 350)];
    const al = pieces.map((p): Allocation => ({ id: `al-${p.id}`, createdAt: '', updatedAt: '', source: 'manual', transactionId: p.id, targetType: 'transfer', targetId: 'flex', amount: p.amount, confidence: 1, decidedBy: 'user', reason: '' }));
    const big = row('big', 'flex', 65000, '2026-08-23', 'Flexible savings: money in');
    const { changes, settled } = settleGroupedTransfers({ accounts: w.accounts, transactions: [...pieces, big], allocations: al }, testClock());
    expect(settled).toBe(1);
    expect(changes.putAllocations.find((a) => a.transactionId === 'big')).toMatchObject({ targetId: 'rev' });
  });

  it('a sum that does not fit, or rows too far apart, is left in the inbox', () => {
    const w = base();
    const a = row('a', 'rev', -30000, '2026-08-22', 'To EUR Compte flexible');
    const b = row('b', 'rev', -35000, '2026-07-01', 'To EUR Compte flexible');
    const big = row('big', 'flex', 65000, '2026-08-23', 'Flexible savings: money in');
    expect(settleGroupedTransfers({ accounts: w.accounts, transactions: [a, b, big], allocations: [] }, testClock()).settled).toBe(0);
  });
});

describe('pairing picks the best match overall and repairs weak pairs (D-81)', () => {
  const row = (id: string, accountId: string, amount: number, date: string, descriptionRaw: string, over: Partial<Transaction> = {}): Transaction => ({
    ...tx(id, accountId, amount, date), descriptionRaw, merchantNorm: descriptionRaw.toUpperCase(), importBatchId: 'b', ...over,
  });
  const auto = (id: string, from: string, to: string, amount: number): Allocation => ({
    id, createdAt: '', updatedAt: '', source: 'manual', transactionId: from, targetType: 'transfer', targetId: to, amount, confidence: 1, decidedBy: 'rule', reason: 'Same amount in X, 1 day(s) apart',
  });

  it('a top-up whose text carries its date goes with the row of that date, not a payment a day apart', () => {
    const w = new World('2026-01');
    w.account('spk', 'current', 0);
    w.account('rev', 'current', 0);
    w.account('dia', 'current', 0);
    const diana = row('diana', 'dia', 50000, '2026-01-29', 'Apple Pay deposit by *7418');
    const pablo = row('pablo', 'rev', -50000, '2026-01-28', 'Transfer to Pablo Sebastian Burneo');
    const spk = row('spk', 'spk', -50000, '2026-02-02', 'DEBIT REVOLUT**3501* 29.01');
    const { changes } = pairOpenTransfers({ accounts: w.accounts, transactions: [diana, pablo, spk], allocations: [] }, testClock());
    expect(changes.putAllocations.map((a) => `${a.transactionId}>${a.targetId}`).sort()).toEqual(['diana>spk', 'spk>diana']);
  });

  it('an automatic pair with a better partner waiting in the inbox is undone; a pair the user made stays', () => {
    const w = new World('2026-01');
    w.account('spk', 'current', 0);
    w.account('rev', 'current', 0);
    w.account('dia', 'current', 0);
    const diana = row('diana', 'dia', 50000, '2026-01-29', 'Apple Pay deposit by *7418', { status: 'reconciled' });
    const pablo = row('pablo', 'rev', -50000, '2026-01-28', 'Transfer to Pablo Sebastian Burneo', { status: 'reconciled' });
    const spk = row('spk', 'spk', -50000, '2026-02-02', 'DEBIT REVOLUT**3501* 29.01');
    const allocations = [auto('a1', 'diana', 'pablo', 50000), auto('a2', 'pablo', 'diana', -50000)];
    const r = repairWeakPairs({ accounts: w.accounts, transactions: [diana, pablo, spk], allocations }, testClock());
    expect(r.reopened).toBe(2);
    expect(r.changes.deleteAllocations.sort()).toEqual(['a1', 'a2']);
    const mine = allocations.map((a) => ({ ...a, decidedBy: 'user' as const }));
    expect(repairWeakPairs({ accounts: w.accounts, transactions: [diana, pablo, spk], allocations: mine }, testClock()).reopened).toBe(0);
  });

  it('a pair neither naming the account nor transfer-like on both sides is undone (payment to a person vs a refund)', () => {
    const w = new World('2026-01');
    w.account('spk', 'current', 0);
    w.account('rev', 'current', 0);
    const kine = row('kine', 'rev', -1359, '2026-05-30', 'Kine Madalena Martins', { status: 'reconciled' });
    const axa = row('axa', 'spk', 1359, '2026-05-26', 'CREDIT TRANSFER FROM AXA ASSURANCES', { status: 'reconciled' });
    const r = repairWeakPairs({ accounts: w.accounts, transactions: [kine, axa], allocations: [auto('x1', 'kine', 'axa', -1359), auto('x2', 'axa', 'kine', 1359)] }, testClock());
    expect(r.reopened).toBe(2);
  });
});

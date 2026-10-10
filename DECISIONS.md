# Decisions

Choices made where the PRD and build prompt leave room. Newest last. Each one says what was decided, why, and what would change it.

## M1, Foundations and budget (October 2026)

**D-01 One shared household budget.** One budget covers the whole household (answer to the PRD open question). Accounts and income categories can carry a person's name ("Salary (Alex)") without a data-model change. A per-person layer would add an `ownerId` to accounts, categories and budgetDefaults later.

**D-02 Stack.** Vite 8, React 19, TypeScript strict (plus `noUncheckedIndexedAccess`), Dexie 4, Vitest. There is no router library: hash routing is about 40 lines (`src/ui/router.ts`). The service worker is a handwritten generator in `vite.config.ts`, not a plugin, so the CSP and caching stay easy to read.

**D-03 Fully opaque storage (confirmed with the user).** IndexedDB holds a single `records` table of `{id, iv, data}` rows. The logical store name and every field sit inside the AES-GCM ciphertext, with the record id as additional authenticated data so rows cannot be swapped. Nothing on disk reveals dates, amounts, or how many transactions exist. On unlock, everything is decrypted into memory. A household's ten years (around 30,000 rows) is well within what a browser holds comfortably. The PRD's "indexed queries" are in-memory filters instead.

**D-04 Key hierarchy with a recovery key.** A random 256-bit data key encrypts records. It is stored twice, each copy wrapped with a key derived by PBKDF2-SHA-256 (600,000 iterations, random 16-byte salt):

- once from the passphrase;
- once from a 120-bit recovery key shown once at setup (PRD risk "Lost passphrase").

Changing the passphrase rewraps the data key; it never re-encrypts the data. The data key is imported as non-extractable and lives only in memory. Locking drops it and the decrypted cache. A passphrase needs at least 10 characters.

**D-05 Settings record.** Household settings (budget start month, sweep target, auto-lock minutes, last backup date) are one encrypted record (`settings`), next to the twelve PRD stores.

**D-06 Every record has a random UUID `id`.** This includes budgetDefaults, budgetOverrides and allocations, whose PRD key fields are composite. A composite key such as `categoryId:2026-12` would leak months through the ids.

**D-07 Amount parsing.** In the amount box, `1.234,56`, `1 234,56`, `1234,56` and `1234.56` all mean 1,234.56. When both separators appear, the last one is the decimal separator. A separator that appears more than once is a thousands separator. A single dot followed by exactly 3 digits is a thousands separator (`1.234` = 1,234.00); any other single dot is a decimal point (`12.5` = 12.50). More than 2 decimals is rejected, never rounded.

**D-08 Assigned = override, else the latest default.** `budgetDefaults` rows carry `effectiveFrom` (YYYY-MM). The row in force for a month is the latest one at or before that month, so past months keep their amounts when a default changes. A month override wins for that month only. "Make it the default from this month on" writes a new default row and removes that month's override.

**D-09 Ready to assign is cumulative, YNAB style.** Ready to assign = opening balances of on-budget accounts + all income received up to the month + uncategorised activity + leftovers returned by reset/sweep categories − everything assigned up to the month. Income counts in the month it arrives. A household that is "one month ahead" sees this month's salary as money to assign, and next month's budget draws from it. The tested invariant: for every month, Ready to assign + Σ category available = on-budget cash at month end.

**D-10 Loans are off budget.** Current, savings, card and cash accounts are on budget. Card spending is categorised when it happens, and the monthly settlement is a transfer between two on-budget accounts, so it has no budget effect and is never counted twice (PRD F6). Loan accounts are tracked but off budget. A transfer to a loan therefore leaves the budget and reduces Ready to assign. The alternative is to categorise the repayment.

**D-11 Rollover rules.**

- **Roll** carries the leftover into next month, including a negative one (overspending stays visible in the category).
- **Reset** returns the leftover, positive or negative, to Ready to assign next month.
- **Sweep** moves a positive leftover to the savings category chosen in Settings and returns a negative one to Ready to assign. With no target set, sweep behaves like roll.
- Transactions dated before the budget start month count in the start month.

**D-12 Provisions and Events in M1 are category groups only.** Their real behaviour comes in M3: computed set-aside, draw-down, close disposition. Until then, a category in those groups works as a sinking fund with Roll over, as the demo's "Car insurance" and "Summer trip" show. The engine treats `provision`/`event` allocations as uncategorised so balances stay correct.

**D-13 Manual entries are `reconciled`, uncategorised ones `new`.** The dashboard's "To categorise" count is the number of `new` transactions. The M2 reconciliation inbox replaces this count.

**D-14 Editing a transfer** deletes both sides and recreates them (the edited side keeps its id). Saving a split transaction from the single-category form replaces the split, with a warning. Full split editing arrives with the M2 inbox.

**D-15 Backup format.** An encrypted backup is the full JSON export, sealed with AES-GCM under a key derived by PBKDF2 (600,000 iterations, fresh salt per file) from a backup passphrase. That passphrase can match the vault passphrase. Both formats carry a SHA-256 of canonical JSON (sorted keys, rows sorted by id). After restore, the app recomputes it from the stored data and shows "verified" only when it matches (PRD F12).

**D-16 Demo data moves with time.** `fixtures/demo-household.json` is generated deterministically (`npm run demo:generate`) around October 2026. When loaded, every date moves by whole months so the demo always ends in the current month.

**D-17 CSP is injected at build time only.** The Vite dev server needs inline styles for hot reload. Production gets `default-src 'self'; connect-src 'self' https://api.anthropic.com; object-src 'none'; form-action 'none'; …`. `img-src` is `'self'` only, and assets are never inlined as `data:` URIs.

**D-18 Locale.** The UI is English. Every string lives in `src/i18n/en.ts`. Amounts are shown as `1.234,56 €` and dates as dd/mm/yyyy, typed into a text field (native date inputs follow the browser locale). Weeks start on Monday (`startOfWeek`).

## Differences from the build prompt

- The build prompt lists OFX under import; the PRD makes OFX and PDF P1 and schedules them for M5. I followed the PRD.
- The build prompt asks for fixtures covering two CSV layouts, a CAMT.053 file and a card statement. Import is M2, so M1 ships the 6-month household fixture only. The bank-format fixtures come with the M2 importers they exercise.

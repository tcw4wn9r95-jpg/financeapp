# Decisions

Choices made where the PRD and build prompt leave room. Newest last. Each one says what was decided, why, and what would change it.

## M1, Foundations and budget (October 2026)

**D-01 One shared household budget.** One budget covers the whole household (answer to the PRD open question). Since M2, accounts carry an `owner` (joint, or a member from Settings → Household; see D-24); budgets stay shared.

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

**D-10 Loans are off budget.** Current, savings, card and cash accounts are on budget. Card spending is categorised when it happens, and the monthly settlement is a transfer between two on-budget accounts, so it has no budget effect and is never counted twice (PRD F6). Loan accounts are tracked but off budget. Since M2, repaying a loan is classified as a loan repayment (D-29). A plain transfer to a loan still leaves the budget and reduces Ready to assign.

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

## M2, Import and reconciliation (October 2026)

Built from real sample exports supplied by the household: one month each of a joint Spuerkeess current account (PDF), a Worldline Visa statement (PDF) and a Revolut account (CSV). Those files never enter the repository; the fixtures in `fixtures/import/` are synthetic copies of the layouts.

**D-19 PDF statements are in M2, not M5.** The PRD makes PDF import P1, but the household's main bank (Spuerkeess) and card issuer (Worldline) are read from PDFs, so the M2 gate ("a real month matches the bank closing balance") needs them now. Text is extracted with pdf.js (legacy build, eval disabled, loaded only when a PDF is imported) and parsed by layout rules. Nothing is rendered or executed. OFX stays in M5.

**D-20 Three stores beyond the PRD's twelve.**
- `statements`: one per account and period, with opening and closing balances, the card settlement, and the lock.
- `importBatches`: file name, format and the import report, so an import can be undone.
- `bankMappings`: saved CSV layouts (PRD F5).

Older backups still restore: their fingerprint is checked against the stores they contain.

**D-21 Deduplication.** The hash covers account, booking date, amount in cents, the normalised description, and an occurrence number. Two identical payments on one day stay two rows, and re-importing or overlapping files never duplicate. Import one format per account: a PDF and a CAMT export of the same account describe rows differently, so they would not match.

**D-22 Recognising your own accounts.** A row points at one of your accounts when:
- the statement shows that account's IBAN (only the last 4 characters are kept);
- it contains that card's masked number (`••4321`);
- or it contains one of that account's "Recognise in other statements" hints (for example "Compte flexible").

A transfer pairs automatically when there is an opposite amount in another own account within 4 days and one side reads like a transfer or points at the other.

**D-23 Counterparts for accounts without statements.** When a row points at an account whose statements are not imported, Kassa creates the other side there, marked "Created by Kassa" (`isMirror`). The Revolut Compte flexible is the case in point. When that account's statement is imported later, the real row replaces the counterpart and keeps the pairing. When the account does have statements, Kassa suggests the transfer instead of creating it.

**D-24 Household members.** Settings holds the members (names only, encrypted). Accounts can belong to a member or be joint. The budget remains shared (D-01).

**D-25 Card statements.** A Worldline statement records the amount and date of the coming debit and the paying account (by IBAN). That debit is paired as a transfer when it appears in the bank statement, within 5 days of the stated date. The card side is created, because Worldline statements do not list repayments. The card's spending counts once, on the card (PRD F6).

**D-26 Statement checks and period lock.** For each imported statement, Kassa compares its own balance on the closing date with the printed closing balance. A period locks only when the two match and nothing in it is waiting in the inbox. Locked rows cannot be edited or reclassified, and re-imports skip them.

**D-27 Revolut CSV.** The booking date is "Completed Date"; "Started Date" is kept as the value date. The fee is subtracted from the amount, which keeps the running balance exact. Each "Product" is a sub-account (Current, Deposit…) mapped to an account. Reverted, pending and non-EUR rows are skipped and listed in the report.

**D-28 Imported rows are not edited, only classified.** The bank data (date, amount, description) stays as imported. The transaction dialog for an imported row offers classification, splits and "send back to the inbox". Full-text manual edits remain for manual entries.

**D-29 Loan repayments.** A consumer loan (for example Buy Way) is a `loan` account, off budget. Its monthly direct debit is recognised by the account's hint ("BUY WAY") and suggested as a repayment. It is never paired automatically, because it also needs a budget category. Confirming it does two things:
- the debit counts as activity in the chosen category (suggested: "Loan repayments", in Fixed);
- Kassa adds the loan side, so the loan balance goes down by the same amount.

Enter the amount still owed as the loan's negative opening balance. Interest is not split from principal: the whole instalment reduces the tracked balance, so align it with the lender's statement now and then.

## Differences from the build prompt

- The build prompt lists OFX under import; the PRD makes OFX and PDF P1 and schedules them for M5. OFX stays in M5. PDF moved to M2 (D-19) because the household's bank and card statements are PDFs.
- Fixtures for two CSV layouts (Revolut, and a French debit/credit card export), a CAMT.053 file and card statements ship in M2 under `fixtures/import/`.

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

**D-23 Counterparts for accounts without statements.** When a row points at an account whose statements are not imported, the app creates the other side there, marked "Created automatically" (`isMirror`). The Revolut Compte flexible is the case in point. When that account's statement is imported later, the real row replaces the counterpart and keeps the pairing. When the account does have statements, the app suggests the transfer instead of creating it.

**D-24 Household members.** Settings holds the members (names only, encrypted). Accounts can belong to a member or be joint. The budget remains shared (D-01).

**D-25 Card statements.** A Worldline statement records the amount and date of the coming debit and the paying account (by IBAN). That debit is paired as a transfer when it appears in the bank statement, within 5 days of the stated date. The card side is created, because Worldline statements do not list repayments. The card's spending counts once, on the card (PRD F6).

**D-26 Statement checks and period lock.** For each imported statement, the app compares its own balance on the closing date with the printed closing balance. A period locks only when the two match and nothing in it is waiting in the inbox. Locked rows cannot be edited or reclassified, and re-imports skip them.

**D-27 Revolut CSV.** The booking date is "Completed Date"; "Started Date" is kept as the value date. The fee is subtracted from the amount, which keeps the running balance exact. Each "Product" is a sub-account (Current, Deposit…) mapped to an account. Reverted, pending and non-EUR rows are skipped and listed in the report.

**D-28 Imported rows are not edited, only classified.** The bank data (date, amount, description) stays as imported. The transaction dialog for an imported row offers classification, splits and "send back to the inbox". Full-text manual edits remain for manual entries.

**D-29 Loan repayments.** A consumer loan (for example Buy Way) is a `loan` account, off budget. Its monthly direct debit is recognised by the account's hint ("BUY WAY") and suggested as a repayment. It is never paired automatically, because it also needs a budget category. Confirming it does two things:
- the debit counts as activity in the chosen category (suggested: "Loan repayments", in Fixed);
- The app adds the loan side, so the loan balance goes down by the same amount.

Enter the amount still owed as the loan's negative opening balance. Interest is not split from principal: the whole instalment reduces the tracked balance, so align it with the lender's statement now and then.

## Differences from the build prompt

- The build prompt lists OFX under import; the PRD makes OFX and PDF P1 and schedules them for M5. OFX stays in M5. PDF moved to M2 (D-19) because the household's bank and card statements are PDFs.
- Fixtures for two CSV layouts (Revolut, and a French debit/credit card export), a CAMT.053 file and card statements ship in M2 under `fixtures/import/`.

## Naming and design (October 2026)

**D-30 Name.** The app is called **CasaresSan Finances** ("CasaresSan" where space is short). Internal identifiers keep the working name "kassa": the IndexedDB database and the backup and export format ids. Existing vaults and backups therefore keep working.

**D-31 Minimal, modern, phone-first UI.** The household uses the app on phones only.
- Every screen width gets the phone layout: a top bar, and a bottom tab bar with Dashboard, Budget, Inbox, Transactions and More. More holds Import, Accounts, Categories, Settings and Lock. On a large screen the layout simply stays a centred 600 px column.
- Lists replace tables. Budget rows show the category, "assigned · spent", what is available and a thin progress bar, and open a bottom sheet to change the amount. Transactions are grouped under date headers.
- Form fields use 16 px text, so iOS does not zoom on focus. There is no tap highlight flash, and installed to the home screen it runs full screen.
- Spending amounts in lists use plain text with their minus sign; only incoming money is tinted green. Red is kept for overspending and negative balances.
- Neutral greys, one ink colour for actions, hairline borders, and the self-hosted Inter variable font, so the CSP stays `font-src 'self'`. Light and dark themes follow the phone.

## M3, Provisions, events and forecast (October 2026)

**D-32 Retroactive budgeting.**
- A new vault starts its budget in January of the current year, and the first-run screen asks for the start month (any month since 2020).
- While you are still setting up, category amounts apply from the budget start.
- When an older statement is imported after a newer one, the account's opening balance moves back to the older statement's opening balance. This does not happen if the opening balance was typed by hand.

**D-33 A provision is a category plus a schedule.** Each provision owns a category in the Provisions group:
- The money set aside is that category's available balance.
- A bill classified to it draws from it, so Variable spending is untouched (PRD F3).
- The suggested monthly set-aside is (amount − money already there) ÷ months left until the next due date, current month included, rounded up to the cent.
- Recurrence is an RRULE subset: `FREQ=MONTHLY|YEARLY;INTERVAL=n`.

**D-34 A trip or event is a category plus a target.** It works the same way, in the Events group:
- Expenses tagged to it can name a sub-budget, stored on the allocation.
- Closing moves what is left, or covers an overspend, from another category. It does this with overrides on the current month, so the ledger is untouched.
- Monthly saving stops from next month, and the category is archived (hidden).

**D-35 Forecast engine.** The forecast is a day-by-day simulation from today's real on-budget balances:
- **Expected income:** each income category's expected amount (else the average of the last 3 months), on its usual day.
- **Fixed:** the budgeted amount on its usual day. **Variable:** the budgeted amount spread over the month.
- **Provisions:** the whole bill on each due date. **Trips:** what is left to spend, on the trip date.
- **Savings:** no outflow; the money stays in your accounts.
- **Current month:** only what has not happened yet.

The chart shows each month's lowest balance and flags the first month below the minimum buffer (Settings). The per-account view assumes:
- each category keeps being paid from the accounts it used over the last 6 months;
- transfers seen in each of the last 3 months keep happening.

The forecast is never stored.

**D-36 Charts are hand-made SVG, not Apache ECharts.** The PRD names ECharts. One line chart, built to the dataviz specs, avoids a ~1 MB dependency on a phone-only app. Specs:
- 2px lines with a light wash under the first series and hairline grid;
- a labelled reference line;
- touch and keyboard crosshair, and a table view.

The palette is validated for colour blindness and contrast: blue for your plan, orange for scenarios.

**D-37 Claude fallback is opt-in, direct and redacted.** The PRD allows a Claude call for transactions rules and history cannot place. Choices:
- Off by default. The user brings their own Anthropic API key; it lives in the encrypted settings record and never leaves the device except in the request header to `api.anthropic.com`.
- The browser calls the API directly (the SDK's `dangerouslyAllowBrowser`): there is no server to proxy through, and the key is the user's own.
- Nothing is sent automatically. "Ask Claude" shows the exact redacted batch first (max 50 rows).
- Redaction: IBANs, card numbers, digit runs of 6+ and household member names are removed; anything that reads like a transfer becomes "PERSONAL TRANSFER". Categories go under short keys (c1, c2…), transactions under row numbers, so no ids leave.
- Structured output (JSON schema) with low effort; the API's default server-side fallback is enabled so a declined request is retried on Anthropic's recommended fallback model. A refusal or unreadable answer changes nothing.
- Answers at or above the auto-apply threshold are filed (`decidedBy: ai`, shown in the log with undo); the rest become suggestions.

**D-38 History matching.** One training example per transaction (re-deciding replaces it), recorded only when the user classifies or accepts a suggestion; automatic decisions are never fed back. For a new row: past examples with the same normalised merchant and direction, preferring the same amount band, latest 20. Confidence is the share that agree; a single example caps at 80 % (so it only suggests); examples from another amount band only count at 90 %. Transfers are suggested, never filed automatically, because pairing needs the other side.

**D-39 Rule proposals.** When the latest three decisions for a merchant agree and no rule covers it, the inbox proposes a rule (`createdFrom: hardened`, pattern `^MERCHANT$`). "Not now" remembers the merchant so it is not asked again. Rules are tried in priority order (reorder with the arrows); a rule whose target was archived is skipped.

**D-40 Scenarios.** A scenario is a named list of changes (monthly cost from the 1st, monthly income on the 25th, or a one-off) drawn on the forecast chart against the baseline, with the 24-month difference and the first month below the buffer.

**D-41 Luxembourg tax projection.** Scope: salaried households in classes 1, 1a and 2. Choices:
- Parameters live in `/tax/lu/YYYY.json`. 2025 and 2026 were taken from the ACD's consolidated LIR texts in force on 1 January of each year. Social rates and ceilings come from CCSS notices; for 2025 and the mid-year ceilings, they come from secondary sheets (noted in `sources`).
- The yearly social ceiling is the month-weighted average over the year's index changes.
- Social contributions are estimated from gross salary: pension, health 2.8% + 0.25% and dependence 1.4% after the allowance.
- Net income is gross minus contributions, minus the 540 € professional lump sum per employee, minus commuting as entered (capped at 2,574 €).
- Special expenses are the larger of the 480 € lump sum per taxpayer and the insurance premiums entered (672 € per household member). Pension savings are capped per person. Other deductions and income are typed by the user.
- Taxable income is rounded down to 50 €, and tax down to the euro.
- **Classes:** class 2 is tax = 2 × tax(R/2). Class 1a follows art. 120bis: the scale applied to R − ¼ × (79,380 − R), with the marginal rate capped at 39% from 51,804 €.
- **Employment fund:** 7% of the tax, plus 2 points on the tax for income above 150,000 € (classes 1/1a) or 300,000 € (class 2). The "part above the threshold" reading comes from the law's wording and was not confirmed against an ACD computation. The rate can be overridden.
- **Credits:** CIS plus the CO2 credit (216 € in 2026, 192 € in 2025), and CIM (only when the 1a box is ticked; the reduction for the child's own allowances is not modelled). CISSM, CIP and the 2024-only CIB are not modelled.
- The refund or payment (withheld − liability) can be posted into the forecast on the 15th of a chosen month (default June of the next year).
- Not modelled: married couples taxed in class 1 by option (individualisation), non-residents, self-employment, capital gains, and the actual payroll withholding tables. The user types withholding from payslips.
- Bill 8676 (single tax class) is not voted as of October 2026 and would apply from 2028; it is not modelled.

**D-42 Backup sharing.** The PRD's optional GitHub sync would need a token and `api.github.com` in the CSP. Instead, the encrypted backup can be handed to the phone's share sheet (Web Share API with files): save it to Files or iCloud Drive, or AirDrop it to the other person's phone and restore it there. Because encryption takes a moment and browsers open the share sheet only straight after a tap, sharing takes two taps: prepare, then share.

**D-43 OFX/QFX.** Both forms are read: SGML (OFX 1.x, open tags) and XML (OFX 2.x).
- Each statement (bank or card) becomes a sub-account, keyed by the last 4 characters of ACCTID.
- LEDGERBAL is the closing balance at DTASOF.
- `<ORIGCURRENCY>` keeps the original amount (TRNAMT is already in EUR). `<CURRENCY>` converts TRNAMT with CURRATE.
- Statements whose CURDEF is not EUR are skipped with the reason "currency".

**D-44 Face ID unlock through a passkey (WebAuthn PRF).** A biometric check alone would only gate the screen. Instead, Face ID unlocks the key itself:
- Turning it on (Settings → Face ID, which asks for the passphrase once) creates a platform passkey with the WebAuthn `prf` extension.
- The authenticator returns a 32-byte secret for a random salt, and only after Face ID. HKDF turns it into a key that wraps the same data key as the passphrase and recovery slots.
- The keyring stores only the credential id, the PRF salt and the wrapped key. Changing the passphrase keeps Face ID working, because the data key does not change.
- No server: the challenge is random and no assertion is verified; a wrong secret simply fails to decrypt.
- Face ID is offered automatically when the app is opened. After a manual "Lock" it waits for a tap, otherwise it would unlock at once.
- Needs a browser with PRF for platform passkeys: iOS/iPadOS 18+, recent Chrome/Android. Elsewhere the setting explains that and the passphrase stays.
- The passkey may sync through iCloud Keychain, but each device's vault has its own slot.

**D-45 Starting the budget earlier and backfilling.** The budget can start in any month from January 2020.
- **Moving the start earlier** (Settings, or the first-run screen) moves each category's first monthly amount back to the new start, so the earlier months are budgeted. Later changes of amount keep their own dates.
- **Repair hint:** when a category's amounts still begin after the start (a vault set up before this rule, or an amount set "from this month"), the Budget page says so for the months affected. It offers to carry them back, or to keep them as they are.
- **Backfill checklist:** the Import page shows, for each account, which months since the start have a statement, only some imported rows, or nothing.
- **Opening balance:** the earliest statement sets it automatically unless it was typed by hand (D-32). If an older statement than anything imported opens with a different balance than the typed one, the import report shows both and offers to use the statement's.

**D-46 Negative amounts on phones.** The iPhone decimal keypad has no minus key.
- A loan asks for the **amount still owed**, as a positive number, and stores it as a negative balance.
- Other opening balances have a +/− button next to the field that flips the sign, for example for a credit card you owe.

**D-47 Start dates for accounts and budget amounts.**
- **Accounts:** an account can have an opening date (a loan taken out in March, an account opened or tracked from June). The opening balance applies from that day, and the account's balance is zero before it.
  - For an on-budget account, the opening balance joins Ready to assign in that month instead of the budget start.
  - Loans stay off budget.
  - Earlier transactions on the account are not hidden; the statements checklist starts at the opening month.
  - An older statement that sets the opening balance also moves the opening date back to its first day.
- **Categories:** a monthly amount can start in any month from the budget start to a year ahead, and can end ("Until"). The end is stored as a zero amount from the month after.
  - The category dialog lists the dated amounts.
  - The hint offering to carry amounts back to the budget start (D-45) now appears only for the old set-up pattern: several categories all starting in the same later month, and none from the start. "Keep as is" is remembered.

**D-48 Loan payment in the budget.** A loan can carry its monthly payment and last payment month. The app then keeps a linked category in the Fixed group, named after the loan and set to reset:
- It is budgeted at the instalment from the loan start (or the budget start) through the last payment, and gets nothing after it.
- A changed instalment applies from the current month; earlier months keep the old amount.
- Renaming the loan renames the category. The category cannot be deleted while the loan points to it.
- Repayments recognised for that loan are suggested with the category already set, so "Accept" (and "Accept all") files them in one tap. The payment counts as spending in the category and lowers the loan.
- Loans without a payment still ask for a category, as in D-29.

**D-49 Provisions run on a schedule.** A provision has a target amount, a target date, a start date and a recurrence. Saving it rewrites its category's monthly amounts:
- from the start month to the first target month: the target spread evenly, rounded up to the cent;
- then, for a recurring bill, the target spread over one full cycle (a yearly bill: a twelfth);
- for a one-off, nothing after the target month;
- nothing before the start.

Single months can still be changed on the Budget page. The provisions list shows "Starts in …" until the start month. The catch-up suggestion appears only when it differs from the budgeted amount by at least 1 €. Provisions saved before this keep their amounts until edited; the start date then defaults to the month their amounts began.

**D-50 Dates use the system date picker.** Date fields are `<input type="date">`, which opens the iPhone's wheel and shows dates in the phone's regional format. Typed dd/mm/yyyy fields did not work on phones: the number keypad has no "/" key. Optional dates (an account's "counts from") can be left empty or cleared in the picker.

**D-51 Splits across categories and accounts.** A split line can be a category (provisions and trips are categories), income, or a transfer to one of your own accounts. A transfer part is paired with a matching open row in that account (same amount, within 7 days), or the app creates that side. The category parts count in the budget; the transfer parts move money between your accounts without touching the budget. "Put the rest on the empty line" fills the remainder.

**D-52 Updates reach the phone.** The service worker now loads the page from the network first: the cached copy is used when offline, or after 3 seconds. Built files are content-hashed and stay cache-first. The app also checks for a new version whenever it comes back to the foreground. Settings → Data shows the build time.

**D-53 Provision form.** The fields read Start date → End date → Target amount. The monthly amount is shown large before saving. New provisions are one-off by default, and a yearly bill can still be set to repeat.

**D-54 Trips budget themselves by dated parts.** A trip has a start date, a trip date, a total, and optional parts (flights, lodging…), each with its own "needed by" date. The budget engine turns these into a plan:
- every part, plus the rest of the total, assigns each month what is still missing divided by the months left to its date;
- a part stops when the spending tagged to it reaches its amount (tickets bought early), when it is marked paid, or after its date;
- months before the start get nothing; a closed trip's parts end in the month it closed, so its history stays;
- plans replace the monthly defaults for trip categories, and a manual change of one month on the Budget page still wins.

**D-55 The monthly move to the provisions account.** In Plan → Provisions you choose the savings account where provision and trip money is kept. The card (and a Dashboard line) shows what to move this month: everything provisions and trips are budgeted this month, minus transfers already made into that account from other on-budget accounts this month. When a transfer of that amount (±1 €) appears in a statement, it is suggested as a transfer to that account, so accepting it is one tap.

**D-56 Provisions and trips are buckets of real money.** The budget's plan says how much each provision and trip should get each month, but a bucket only fills with money actually moved into the provisions account (D-55), and it empties when the bill or trip spending is paid.
- **Sharing moves:** money moved into the account in a month first covers what each bucket is short of its plan in its current cycle, in proportion to the shortfall. Anything beyond that goes ahead by this month's plan. A move in a month with nothing planned waits for the next plan.
- **Cycles:** a recurring provision's cycle starts after each due date, so a shortfall from a past cycle (a bill already paid from elsewhere) is not owed again.
- **What the screens show:** each bucket shows its level (moved in minus paid), its percentage of the target, and "Not moved yet" (planned in earlier months of the cycle but not moved). The monthly move adds that catch-up to this month's amount.
- **No provisions account chosen:** the plan stands in for the money and the screen says so.

This fixes provisions that started in the past showing as complete although nothing was moved.

**D-57 Investments.** A new category group, Investments, sits between Savings and Provisions.
- **The category:** an "Investments" category (rollover set to reset) is created once in every existing vault after unlock, and is part of the suggested set for new vaults. If you delete it, it is not created again.
- **Filing a purchase:** money sent to an ETF or broker is filed under it like any other budget spending, so its monthly amount is planned and the forecast treats it as a fixed monthly outflow.
- **Totals:** the Budget page (on the Investments group) and the Dashboard show what has been put in, in total, this year and this month. Sales filed back under the category count back.
- **Not tracked:** the market value of the investments.

**D-58 Reading PDFs on phones.**
- pdf.js runs in a Web Worker. If that fails (some mobile browsers refuse the worker), the file is read again on the main thread, using the worker module imported directly. It is slower, but text extraction of a statement is small work.
- PDFs are recognised by their content (`%PDF-`), not only by the file name, because files shared from other apps can arrive without an extension.
- When a file still cannot be read, the import shows the technical reason, so a bug report can say what failed.

**D-59 Update banner.** Every build publishes `version.json` with a unique id. The service worker never caches it.
- **When it checks:** the app compares that file with the build it is running when it opens, whenever it comes back to the foreground, and every 10 minutes. When they differ, a banner offers **Refresh**.
- **What Refresh does:** it updates the service worker, clears the cached files and reloads. The encrypted data in IndexedDB is untouched; the vault only needs unlocking again.
- **Settings → Data** shows the running build time and has a manual "Reload the app now".

**D-60 PDFs on iPhone Safari.** pdf.js 6 loops over ReadableStreams with `for await` when it reads a page's text, and when it inflates compressed data in its worker. Safari on iOS 18 and earlier does not support that ("undefined is not a function"), so every PDF failed there.
- The app adds stream iteration where it is missing.
- Because a worker cannot receive that fix, browsers lacking it read PDFs on the main thread; other browsers keep the worker.
- Reproduced by removing `ReadableStream.prototype[Symbol.asyncIterator]` in Chromium.

**D-61 Flexible savings (money-market fund) export.** The CSV has `Date, Description, "Value, EUR", Price per share, Quantity of shares`, US dates ("Oct 12, 2026, 2:06:56 AM"), thousands commas and up to 4 decimals, and no balances. It is read as follows:
- **BUY / SELL:** money in from and out to the current account, so they pair with it as transfers.
- **Return WITHDRAWN:** money out, a transfer.
- **Return PAID and Service Fee** (daily): one row per month, interest net of fees, with gross and fees in the details.
- **Return Reinvested (−x) plus the BUY of x within a week:** returns turned into shares. They cancel out and are skipped.
- **Incomplete months:** a month at either end of the file without its first or last days is held back, so a later export that covers it fully is not counted twice. The report shows what it holds so far.

Because there are no balances, the import report asks for today's balance from the bank app. The opening balance is then today's balance, minus everything the app has for the account up to today, minus the interest held back. The file is offered to an account whose name or hints share a word with "Flexible savings". The fixture is synthetic; the household's own export is never added to the repository.

**D-62 Delete all transactions.** Settings → Data can delete every transaction with its splits and transfer links, statements and import history, while accounts, categories, budget amounts (defaults and month overrides), provisions, trips, rules, scenarios, tax profiles, bank mappings and settings stay. It is for starting the imports again from scratch. Opening balances that came from a statement go back to 0 so the next import sets them again; typed ones stay. What the app learned from past choices stays unless the user ticks "forget" (rules always stay). Confirmation is a typed word, as for deleting everything.

**D-63 Inbox order and filter.** The inbox lists the most repeated merchants first: items with the same merchant and direction (as "Also the similar ones" groups them) stay together, newest first, and each shows how many like it are open, so one decision clears the most rows. Groups of the same size keep the newest on top; "Newest" restores plain date order. Chips filter to "To verify" (a rule, history or Claude already suggested something) or "New" (nothing suggested). "Accept all" applies only to the suggestions shown. The choices live in the URL, so they survive going back.

**D-64 Seeing and correcting what feeds a provision.** Tapping a provision (or "Transactions" on a trip) shows its current round of saving month by month: the moves into the provisions account with this bucket's share of each month, what was paid from it, and money that arrived in the provisions account without counting as a move (not a transfer from a budget account). Every row opens the transaction to reclassify it. A move can be pinned to one provision or trip (`Transaction.earmarkCategoryId` on the provisions-account side); pinned money counts for that bucket only and is taken off its need before the rest is shared. Mirrors keep the pin when the real statement replaces them.

**D-65 Moves into the provisions account are allocated by hand.** Sharing every move automatically by plan (D-56, D-64) overstated provisions: money moved to the savings account as plain savings filled buckets too. Now a move fills nothing until the user allocates it: one move can be split between several provisions and trips (`Transaction.earmarks`, on the provisions-account side), and what is left out stays plain savings. "Fill by plan" proposes the old split (first what each bucket is short of its plan in its cycle, then the rest by this month's plan) for the user to adjust. A saved allocation is decided even when part (or all) of the move stays savings; moves from the budget start never allocated are listed on Plan → Provisions, in each bucket's detail and on the Dashboard. "Moved this month" for the set-aside figure counts only allocated money. The D-64 single pin is read as the whole move for that bucket.

**D-66 Buckets with several provisions; cleaner set-aside.** Two bugs showed up with more than one provision. (1) Money allocated before a provision's current cycle (e.g. allocated in March to a provision starting in July) vanished: a bucket now carries what was allocated earlier and not spent into its cycle (never below 0, so a bill paid with other money does not make the next cycle negative). (2) "Move now" added up this month's plan and moves across all buckets, so one bucket allocated ahead hid what another still needed: it is now the sum, per bucket, of what is planned up to this month and not yet allocated (`toMove`). "Fill by plan" proposes exactly those needs and no more; anything beyond stays savings. The allocation screen keeps "Left to split" in view, shows what each provision or trip needs, and has "+ rest" per line. The set-aside card shows one figure, the per-bucket amounts and the moves to allocate; the account choice is folded away. A bucket's detail is one list of what went in (allocated parts, tap to change) and out (bills). Interest and other income into the provisions account never fill a bucket, and money taken out of it is a plain transfer: a bucket empties only where the bill or trip spending is filed. Only unclassified money coming in is listed for attention.

**D-67 One category per loan repayment.** Filing a payment to a loan showed a second "repayment category" dropdown even when the loan has its own budget line (D-48), which looked like choosing two categories. The extra dropdown now appears only for a loan without its own budget category (older loans); a loan with one just says where the payment counts.

**D-68 No invented rows in accounts whose own statements cover the date.** A transfer used to get a "mirror" row on the other account when no matching row was found there, replaced later only by a row with exactly the same amount. Savings pockets report top-ups differently (several transfers out of the current account, one purchase in the savings export), so mirrors stayed next to the real rows and the savings balance was counted twice; misfiled top-ups did the same to the current account. Now, when the other account's own imported data covers the date (a current or savings account; card statements do not list repayments and loans have no statements, so they keep mirrors), a transfer without an exact counterpart points at the account itself (`Allocation.targetId` = the account id; the budget treats it as a transfer between own accounts). Mirrors already in covered periods are removed after every import, on unlock and after a restore: the matching open real row takes the mirror's place, or the transfer points at the account.

**D-69 Provisions and trips are filled from the savings balance.** Allocating each move by hand (D-65) did not fit irregular top-ups in many chunks. A bucket now *should hold* what the budget planned for it in its current cycle (never more than the cycle's target) less what was paid from it (refunds filed to it do not raise it). The provisions account's real balance covers the buckets in order of due date, the soonest bill (or trip part) first; the rest is free savings, shown under the savings sweep category (e.g. Emergency fund). "Move now" is what all buckets should hold minus the balance. Moving money in any amounts, taking it out as a transfer and earning interest only change the balance; a bill empties its bucket where it is filed. One-off provisions whose date has passed and that need nothing more are listed as finished. Earmarks from D-64/D-65 are kept in the data but no longer used.

**D-70 Recurring provisions whose amount changes.** A recurring provision (e.g. quarterly tax advances) can change amount from a given bill on (`Provision.amountChanges`). Each bill is spread over its own cycle at its own amount; editing the amount asks from which upcoming bill it applies, and later changes are replaced by it.

**D-71 Transfers between own accounts are filed without asking.** The two sides of a transfer are matched by amount (opposite signs), a transfer-like text on either side, and dates within 4 days, or 7 when either text names the other account or carries the date the money left ("DEBIT REVOLUT**3501* 29.01" booked on 2 Feb). After every import, on unlock, after a restore and when rules are re-run: open rows are paired with each other, or with a row already filed as a transfer to their account without its other side (D-68); then suggestions the app is sure of (≥ 0.9: a rule, the account named in the text, the monthly provisions move) are filed as transfers, a loan payment only when the loan has its own budget line.

**D-72 "Identical" means same merchant and same amount.** Grouping in the inbox (most repeated first, "Also the identical ones") used the merchant and direction only, so different purchases at one shop were filed together. Now only rows with exactly the same amount group.

**D-73 One-tap filing.** Each inbox row shows up to five likely choices: its suggestion, what this merchant was filed under before, then the most used choices for money going the same way. A tap files it (with its identical rows) and the message offers Undo, which sends them back to the inbox. "More…" opens every category, income and own account in one searchable list. A loan without its own budget line or a trip with parts still asks the one extra question before applying.

**D-74 Salary paid at the end of the month for the next one.** An income category can be marked "paid at the end of the month for the next one": what arrives from the 20th on counts in the next month's budget (a late payment, early in the next month, counts there anyway). Until then it is shown as "held for next month" and is in neither Ready to assign nor any category, so the invariant becomes Ready to assign + Σ available + held = on-budget cash.

**D-75 Free savings fill the Emergency fund.** When provisions are kept in a savings account and a savings category collects leftovers (the sweep target, e.g. Emergency fund), that category's available is set each month to what the account holds beyond what provisions and trips should hold (D-69). The budget engine gets it as an available target (`BudgetInput.availableTargets`): the category is assigned whatever makes its available equal the target; an amount typed for a month still wins. Ready to assign then shows only money free to spend. It can be switched off on Plan → Provisions.

**D-76 Budget order and finished provisions.** The budget lists income first (each income line with what is expected this month and what came in, then held-for-next-month, assigned and uncategorised), then Fixed, Variable, Provisions, Trips, Savings and Investments. A one-off provision whose bill date has passed, or a provision that has not started yet, is not shown in a month where it has nothing (no amount, no spending, less than 1 € in it).

**D-77 Optional month-by-month plan for every budget line.** By default a line has the same amount every month. "Plan month by month…" (and a tap on an income line) opens the twelve months of a year: change only the months that differ, and only those get their own amount (an override); a month set back to the usual amount loses its own. Setting every month to the same amount makes it the usual amount from that month on. Provisions, trips and the automatic Emergency fund follow their own schedules and are not planned this way. For income, the plan is what the forecast expects; Ready to assign counts what actually arrives.

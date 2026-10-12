# Finances

A private, local-first household finance app for a household. It runs entirely in the browser and is hosted as a static site on GitHub Pages. There is no server, account or tracking. Data is stored in IndexedDB, encrypted with AES-GCM under a key derived from your passphrase. It also works offline as an installable PWA.

**Status: milestones M1 to M5 done.**

- **M1, Foundations and budget:** encrypted storage, backup and restore; accounts, categories and manual entry; a monthly budget with defaults, month overrides and rollover; dashboard v0.
- **M2, Import and reconciliation:**
  - statement import from bank and credit-card PDF statements, a neobank CSV export, CAMT.053, OFX/QFX and any CSV through a saved column mapping;
  - deduplication and an import report;
  - automatic pairing of transfers between your accounts;
  - card statements linked to their settlement debit;
  - a reconciliation inbox with splits and "apply to similar";
  - statement balance checks and period locks;
  - undo of an import.

- **M3, Plan:** provisions for irregular bills with suggested monthly set-asides; trips and events with sub-budgets and closing; a 24-month forecast with a minimum-buffer warning and a per-account view.
- **M4, Learning:**
  - rules (merchant text or regular expression, amount, account) applied on import;
  - every classification you make is remembered; past decisions for the same merchant file new rows automatically above a threshold you choose (default 92 %), otherwise they are suggested;
  - after three consistent confirmations the inbox offers to turn them into a rule;
  - an "Ask Claude" fallback for unknown merchants: off by default, uses your own API key, and shows exactly what will be sent first;
  - a log of everything filed automatically, with undo;
  - "What if" scenarios drawn against the forecast.

- **M5, Tax and sharing:**
  - an income-tax projection for tax classes 1, 1a and 2 (2025 and 2026 parameters, with sources), showing the expected refund or payment against payroll withholding, optionally posted into the forecast; every parameter can be overridden;
  - OFX/QFX import;
  - sharing the encrypted backup through the phone's share sheet (Files, iCloud Drive, AirDrop to the other phone).

The tax projection is not tax advice. Its test vectors were computed by hand from the law text; they have not been compared with the ACD's own simulator.

## Automatic categorising and Claude

Rules run first, then your history. Neither sends anything anywhere.

Claude is optional. Turn it on in Settings → Automatic categorising and paste an Anthropic API key (stored encrypted in the vault like everything else). The inbox then shows **Ask Claude**, which first lists exactly what will leave the phone:

- the merchant text with IBANs, card numbers, long references and your household's names removed;
- transfers replaced by "PERSONAL TRANSFER";
- amount, date and country;
- your category names under short keys.

No account names, balances or ids are sent. Answers at or above your threshold are filed (and appear in the log with undo); the rest wait in the inbox as suggestions. The request goes directly from your browser to `api.anthropic.com`, the only outside host the Content-Security-Policy allows.

## Run locally

Requires Node 22.

```sh
npm install
npm run dev        # http://localhost:5173 (no CSP, no service worker)
npm test           # domain and storage unit tests (Vitest)
npm run build      # typecheck + production build in dist/
npm run preview    # serve dist/ at http://localhost:4173 with CSP and offline support
```

The built `dist/` folder is plain static files. You can serve it from any folder with any static server (for example `npx serve dist`). If GitHub disappears, the app still runs.

To try every screen without your own data: on first run, create a passphrase and choose **Explore with the demo household**. Later, use **Settings → Data → Load demo household**.

## Deploy to GitHub Pages

1. In the repository on GitHub, open **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Push to `main`. The workflow `.github/workflows/deploy.yml` runs the tests, builds, and publishes `dist/`.
3. The site appears at `https://<user>.github.io/<repo>/`. All paths are relative and routes use the hash (`#/budget/2026-10`), so no Pages configuration is needed.

Pull requests run the tests and build but do not deploy.

## Security model

- A random 256-bit data key encrypts every record (AES-GCM, fresh IV per write). The key is stored only in wrapped form, under:
  - PBKDF2-SHA-256 with 600,000 iterations of your passphrase;
  - the same derivation from a recovery key shown once at setup.
- IndexedDB contains only `{id, iv, ciphertext}` rows. Store names, dates and amounts are all inside the ciphertext.
- The decrypted data and key live in memory only. The app locks after 15 minutes without activity (configurable from 1 to 60 minutes in Settings) and when you press **Lock**.
- Content-Security-Policy (meta tag): scripts, styles, images and connections from the site itself only, plus `https://api.anthropic.com` for the optional Claude fallback (off unless you turn it on). There are no third-party scripts and no analytics.
- Statement files are read inside the browser. Only the last 4 characters of IBANs and card numbers are stored.
- If you lose both the passphrase and the recovery key, the data cannot be recovered. Keep backups.

### Face ID

Settings → Face ID → enter the passphrase once → **Turn on Face ID**. From then on the app asks for Face ID when it opens. Face ID unlocks the encryption key itself through a passkey (WebAuthn PRF). The passphrase and the recovery key keep working, and **Turn off** removes the slot. Needs iOS 18 or later on iPhone. Set it up on each phone.

## Backup and restore

- **Make a backup:** open **Settings → Backup**, choose a backup passphrase (reusing the vault passphrase is fine), then **Download encrypted backup**. The file `finances-backup-YYYY-MM-DD.json` is useless without that passphrase. The dashboard reminds you when the last backup is more than 7 days old.
- **Full JSON export:** **Settings → Backup → Download JSON export**. This file is unencrypted and human-readable; keep it safe.
- **Restore:** open **Settings → Restore**, choose a backup or export file, and enter its passphrase if it is encrypted. Check the preview of record counts, then **Replace all data**. The app recomputes the SHA-256 fingerprint of the restored data and confirms that it matches the file.
- **New browser or cleared storage:** create a new vault (any passphrase), choose **Restore from a backup file**, and follow the restore steps.
- **Forgot your passphrase:** on the lock screen, choose **Use your recovery key**, then set a new passphrase.

## Starting in January and backfilling

1. Settings → Budget starts in → choose the first month (for example January 2026). Monthly amounts you already set move back with it.
2. Import the statements from that month on, in any order. Duplicates are ignored. The oldest statement sets each account's opening balance; if you typed one by hand, the report asks before replacing it.
3. The Import page's "Statements since …" card shows which months are still missing for each account.
4. Go through the past months on the Budget page (‹ ›) and adjust what was assigned in each, then clear the inbox.

## Importing statements

1. **Set up once.**
   - In **Settings → Household**, add the people, for example the two of you.
   - In **Accounts**, create each account with its owner and the **last 4 characters of its IBAN** or card number. The app uses them to route files and recognise transfers.
   - For an account whose statements you never import, add a **"Recognise in other statements"** hint. For example a savings pocket at another bank: add the words its transfers show as a hint. Transfers that mention them then land there automatically.
   - Give each credit card its **Paid from** account.
   - Create each loan (for example a consumer loan) as a **Loan** account. Enter the amount still owed, and add the lender's name as a hint. Its monthly debit is suggested as a repayment: choose the budget category it counts in (for example "Loan repayments"), and the loan balance goes down too.
2. **Import.** Open **Import** and choose one or more files:

   | File | Format |
   | --- | --- |
   | Bank account statement | PDF |
   | Credit-card statement | PDF |
   | Neobank export | CSV |
   | Bank statement | CAMT.053 XML |
   | Bank or card export | OFX / QFX |
   | Flexible savings (fund) export | CSV (no balances: the report asks for today's balance once) |
   | Any other export | CSV |

   The app detects the format and proposes the account for each part of the file, by IBAN or card number. A file can hold several products (current account, savings pocket); choose the account for each, or "Do not import". Then press **Import** and read the report: new rows, duplicates ignored, rows skipped and why, transfers paired, card statements linked.
3. **Review.** **Inbox → To review** lists everything not yet classified. Choose a category, an income or a transfer, or split a row. "Also the N similar ones" applies the same choice to rows from the same merchant (handy for round-up spare change). Suggestions, such as a card settlement whose card already has statements, can be accepted one by one or all at once.
4. **Reconcile.** **Inbox → Statements** compares the app's balance with each statement's closing balance. When they match and nothing is left to review, **Lock this period**. **Inbox → Import history** can undo an import.

Importing the same file twice, or overlapping files, creates no duplicates.

## Adding a bank mapping

When a CSV's layout is unknown, the import page asks you to map its columns once:

- booking date, description, and either a signed amount or debit and credit columns (required);
- optionally value date, fee, balance, currency, counterparty, status, and a sub-account column.

The app guesses common English, French and German headers and previews the result. The layout is saved under a name (**Import → Saved bank layouts**). Every later import checks the header row: if the bank changes its export, the app stops and asks you to map it again. It never guesses.

To add a built-in layout for everyone, add a `MappingSpec` to `BUILT_IN_MAPPINGS` in `src/domain/import/csv.ts` (see the existing built-in mappings). Then add a sample file to `fixtures/import/` and a test to `src/import-fixtures.test.ts`.

The import fixtures are synthetic, for a fictional household. They copy the real layouts and are regenerated with `npm run fixtures:import` (needs Playwright for the PDFs).

## Updating a tax year file

The tax projection reads one JSON file per tax year, `/tax/lu/YYYY.json`, holding:

- the art. 118 bracket table (lower bound in euros, marginal rate) and the class 1a rule;
- the employment-fund surcharge rates and thresholds;
- employee social-security rates and the yearly contribution ceiling;
- deduction lump sums and ceilings, and the credit formulas (CIS including the CO2 credit, CIM);
- a `sources` array with the official URL behind the values and the date they were checked.

To add a year: copy the latest file, change the values from the consolidated LIR text published by the Administration des contributions directes (impotsdirects.public.lu → Législation → LIR) and the CCSS notices, update `sources`, add test vectors in `src/domain/tax/lu.test.ts`, and run `npm test`. Rates are never hard-coded. If bill 8676 (single tax class) is voted, it applies from tax year 2028 and needs its own tariff types (U/T).

## Project layout

```
src/domain/    pure TypeScript: money, dates, ledger, budget engine, reconcile, plan, forecast, learn, tax (no React, no Dexie; a test enforces this)
src/domain/import/  parsers (bank and card PDF layouts, CSV mappings, CAMT.053, OFX) and the import engine
src/infra/     pdf.js text extraction; the optional Claude client
src/storage/   WebCrypto, encrypted Dexie vault, backup and export format
src/ui/        React pages and components
src/i18n/en.ts every UI string (copy it to fr.ts / es.ts to translate)
fixtures/      anonymised demo household (scripts/generate-demo.ts)
fixtures/import/  synthetic statements in real bank layouts (scripts/generate-import-fixtures.ts)
DECISIONS.md   choices made where the PRD leaves room
```

## Money and dates

- Amounts are integer cents in EUR. Foreign transactions also keep the original currency and amount.
- The amount box accepts `1.234,56`, `1234,56` or `1234.56`.
- Dates are typed and shown as dd/mm/yyyy and stored as `YYYY-MM-DD`. Weeks start on Monday.

# Kassa

A private, local-first household finance app for a Luxembourg household. It runs entirely in the browser and is hosted as a static site on GitHub Pages. There is no server, account or tracking. Data is stored in IndexedDB, encrypted with AES-GCM under a key derived from your passphrase. It also works offline as an installable PWA.

**Status: milestones M1 and M2 done.**

- **M1, Foundations and budget:** encrypted storage, backup and restore; accounts, categories and manual entry; a monthly budget with defaults, month overrides and rollover; dashboard v0.
- **M2, Import and reconciliation:**
  - statement import from Spuerkeess PDFs, Worldline credit-card PDFs, Revolut CSV, CAMT.053 and any CSV through a saved column mapping;
  - deduplication and an import report;
  - automatic pairing of transfers between your accounts;
  - card statements linked to their settlement debit;
  - a reconciliation inbox with splits and "apply to similar";
  - statement balance checks and period locks;
  - undo of an import.

Provisions, the forecast, learning reconciliation and Luxembourg tax follow in M3 to M5 (see the PRD roadmap).

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
- The decrypted data and key live in memory only. Kassa locks after 15 minutes without activity (configurable from 1 to 60 minutes in Settings) and when you press **Lock**.
- Content-Security-Policy (meta tag): scripts, styles, images and connections from the site itself only, plus `https://api.anthropic.com` for the optional AI classification planned in M4. There are no third-party scripts and no analytics.
- Statement files are read inside the browser. Only the last 4 characters of IBANs and card numbers are stored.
- If you lose both the passphrase and the recovery key, the data cannot be recovered. Keep backups.

## Backup and restore

- **Make a backup:** open **Settings → Backup**, choose a backup passphrase (reusing the vault passphrase is fine), then **Download encrypted backup**. The file `kassa-backup-YYYY-MM-DD.kassa.json` is useless without that passphrase. The dashboard reminds you when the last backup is more than 7 days old.
- **Full JSON export:** **Settings → Backup → Download JSON export**. This file is unencrypted and human-readable; keep it safe.
- **Restore:** open **Settings → Restore**, choose a backup or export file, and enter its passphrase if it is encrypted. Check the preview of record counts, then **Replace all data**. Kassa recomputes the SHA-256 fingerprint of the restored data and confirms that it matches the file.
- **New browser or cleared storage:** create a new vault (any passphrase), choose **Restore from a backup file**, and follow the restore steps.
- **Forgot your passphrase:** on the lock screen, choose **Use your recovery key**, then set a new passphrase.

## Importing statements

1. **Set up once.**
   - In **Settings → Household**, add the people, for example the two of you.
   - In **Accounts**, create each account with its owner and the **last 4 characters of its IBAN** or card number. Kassa uses them to route files and recognise transfers.
   - For an account whose statements you never import, add a **"Recognise in other statements"** hint. The Revolut Compte flexible is the example: add the hint "Compte flexible". Transfers that mention it then land there automatically.
   - Give each credit card its **Paid from** account.
   - Create each loan (for example Buy Way) as a **Loan** account. Enter the amount still owed as a negative opening balance, and add the hint "BUY WAY". Its monthly debit is suggested as a repayment: choose the budget category it counts in (for example "Loan repayments"), and the loan balance goes down too.
2. **Import.** Open **Import** and choose one or more files:

   | File | Format |
   | --- | --- |
   | Spuerkeess statement | PDF |
   | Visa statement from Worldline | PDF |
   | Revolut | CSV |
   | Bank statement | CAMT.053 XML |
   | Any other export | CSV |

   Kassa detects the format and proposes the account for each part of the file, by IBAN or card number. A Revolut file has one part per product (Current, Deposit); choose the account for each, or "Do not import". Then press **Import** and read the report: new rows, duplicates ignored, rows skipped and why, transfers paired, card statements linked.
3. **Review.** **Inbox → To review** lists everything not yet classified. Choose a category, an income or a transfer, or split a row. "Also the N similar ones" applies the same choice to rows from the same merchant (handy for Revolut spare change). Suggestions, such as a card settlement whose card already has statements, can be accepted one by one or all at once.
4. **Reconcile.** **Inbox → Statements** compares Kassa's balance with each statement's closing balance. When they match and nothing is left to review, **Lock this period**. **Inbox → Import history** can undo an import.

Importing the same file twice, or overlapping files, creates no duplicates.

## Adding a bank mapping

When a CSV's layout is unknown, the import page asks you to map its columns once:

- booking date, description, and either a signed amount or debit and credit columns (required);
- optionally value date, fee, balance, currency, counterparty, status, and a sub-account column.

Kassa guesses common English, French and German headers and previews the result. The layout is saved under a name (**Import → Saved bank layouts**). Every later import checks the header row: if the bank changes its export, Kassa stops and asks you to map it again. It never guesses.

To add a built-in layout for everyone, add a `MappingSpec` to `BUILT_IN_MAPPINGS` in `src/domain/import/csv.ts` (see `REVOLUT_MAPPING`). Then add a sample file to `fixtures/import/` and a test to `src/import-fixtures.test.ts`.

The import fixtures are synthetic, for a fictional couple Jane and John Doe. They copy the real layouts and are regenerated with `npm run fixtures:import` (needs Playwright for the PDFs).

## Updating a tax year file

The Luxembourg tax engine arrives in M5. It will read one JSON file per tax year, `/tax/lu/YYYY.json`, holding:

- bracket thresholds and rates;
- surcharge thresholds;
- deduction ceilings and credit amounts;
- a `sources` array of official URLs and the date each value was verified.

To update a year, copy the latest file, change the values from the official Administration des contributions directes publication, update `sources` and the verification date, and run the tax test vectors (`npm test`). Rates are never hard-coded.

## Project layout

```
src/domain/    pure TypeScript: money, dates, ledger, budget engine, reconcile (no React, no Dexie; a test enforces this)
src/domain/import/  parsers (Spuerkeess PDF, Worldline PDF, CSV mappings, CAMT.053) and the import engine
src/infra/     pdf.js text extraction
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

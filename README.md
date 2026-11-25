# Vanagopal Kanakku

Maintenance accounts web app for Vanagopal Enclave. It is modelled on the
association's Excel sheet (`Income_Expense`, `Apartment_Info`, `Summary`).

## What it does

| Area | Admin | Owner (read-only) |
|---|---|---|
| Dashboard: fund balances, this month's collection and spend | ✅ | ✅ |
| Ledger: every income/expense entry with running balances for the Maintenance and Corpus funds (same as columns L/M in the sheet) | add / edit / delete | view, filter, print |
| Dues: which flats have paid for a month, and how much is pending | record payment | view |
| Summary: month-wise income by flat and expense by category (same as the Summary pivot) | ✅ | ✅ |
| Download Excel in the original sheet layout | ✅ | ✅ |
| Import from Excel (the existing workbook) | ✅ | – |
| Flats, owners, expense categories, monthly due amounts | ✅ | – |
| User accounts, activity log | ✅ | – |

Each ledger entry has two dates. **Date** is when the money moved. **For month** is the
period the payment belongs to, so advance and late payments land in the right month's dues.

## Run locally

Requires Node.js 22+. Without `DATABASE_URL`, the app uses an embedded Postgres (PGlite)
stored in `data/pglite/`, so you don't need to install a database.

```bash
npm install
npm run create-admin -- admin 'a-strong-password' "Your Name"
npm run import-xlsx -- Vanagopal_Enclave_Accounts.xlsx   # optional: seed from the existing sheet
npm start                                                  # http://localhost:3000
```

Then sign in as admin, go to **Users** and create one owner login per flat.
Owners sign in with a temporary password and must change it first.

### Configuration (environment variables)

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | unset | Postgres connection string (Neon on Vercel). If unset, the embedded DB is used. **Required on Vercel.** |
| `SETUP_TOKEN` | unset | Enables the one-time "create first admin" screen. It stops working once an admin exists. |
| `PORT` | `3000` | Local server only. |
| `SECURE_COOKIES` | auto on Vercel | Set to `1` when self-hosting over HTTPS. |
| `TRUST_PROXY` | auto on Vercel | Set to `1` behind a reverse proxy. |

## Deploying on Vercel

1. Import this GitHub repo as a Vercel project. `vercel.json` already serves `public/` statically
   and routes `/api/*` to one serverless function.
2. In the project's **Storage** tab, create a **Neon** Postgres database (free tier) in the
   **Singapore (aws-ap-southeast-1)** region and connect it. Functions run in Singapore (`sin1`, see `vercel.json`) to stay close to the DB and to India.
   This sets `DATABASE_URL` automatically. Tables are created on first request.
3. Add a `SETUP_TOKEN` environment variable with a long random value, then redeploy.
4. Open the site. It shows **Create the first admin**. Enter the setup code and your details.
   After that the setup screen is permanently disabled. You can delete `SETUP_TOKEN`.
5. As admin, go to **Flats & Settings → Import from Excel** to load the existing workbook, then create owner logins.

Backups: Neon keeps point-in-time history, and **Download Excel** gives a full copy of every entry.

### Self-hosting (alternative)

```bash
docker build -t kanakku .
docker run -d -p 3000:3000 -v kanakku-data:/app/data -e SECURE_COOKIES=1 kanakku
```

## Tests

```bash
npm test
SAMPLE_XLSX=path/to/Vanagopal_Enclave_Accounts.xlsx npm test   # also checks importing the real workbook
```

## Layout

```
src/db.js       Postgres schema (amounts in paise), pg / PGlite connection, audit log
src/ledger.js   running balances, month summary, dues
src/excel.js    import/export in the original workbook format
src/auth.js     password hashing, sessions, role checks
src/app.js      REST API (/api/...)
public/         single-page UI (plain JS, no build step)
api/index.js    Vercel serverless entry
scripts/        create-admin, import-xlsx
```

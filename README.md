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

Requires Node.js 22.13 or newer. The app uses Node's built-in SQLite, so there is no native build.

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
| `PORT` | `3000` | |
| `DB_FILE` | `data/kanakku.db` | SQLite file. **Back this up.** It is the whole database. |
| `SECURE_COOKIES` | unset | Set to `1` when served over HTTPS. |
| `TRUST_PROXY` | unset | Set to `1` behind a reverse proxy, so login rate-limiting sees real client IPs. |

## Deploying

The data lives in a single SQLite file, so the host needs a **persistent disk**.
Serverless platforms (Vercel, Netlify functions) will lose data. Suitable options:
a small VPS, Railway or Render with a volume, Fly.io with a volume, or a Raspberry Pi at home.

```bash
docker build -t kanakku .
docker run -d -p 3000:3000 -v kanakku-data:/app/data -e SECURE_COOKIES=1 kanakku
docker exec -it <container> node scripts/create-admin.js admin 'a-strong-password'
```

Back up by copying `data/kanakku.db`, or use **Download Excel**, which includes every entry.

## Tests

```bash
npm test
SAMPLE_XLSX=path/to/Vanagopal_Enclave_Accounts.xlsx npm test   # also checks importing the real workbook
```

## Layout

```
src/db.js       schema (amounts stored in paise), settings, audit log
src/ledger.js   running balances, month summary, dues
src/excel.js    import/export in the original workbook format
src/auth.js     password hashing, sessions, role checks
src/app.js      REST API (/api/...)
public/         single-page UI (plain JS, no build step)
scripts/        create-admin, import-xlsx
```

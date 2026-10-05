# Yellow cockpit (Phase A)

Follow + journal for Yellow (XAUUSD). No auto-trade. No MT5 passwords.

## Migrate Turso

```bash
turso db shell <your-db> < db/migrations/001_yellow_reports.sql
```

Optional (prefer Yellow rows in journal):

```sql
ALTER TABLE trades ADD COLUMN source TEXT DEFAULT 'legacy';
```

Ignore "duplicate column" if it already exists. The report API also `CREATE TABLE IF NOT EXISTS yellow_reports` on first POST.

## Env (Vercel)

Set on the Hermes Mission Control v2 project:

- `YELLOW_INGEST_TOKEN` — long random secret Yellow uses to POST reports
- `YELLOW_MT5_LOGIN=10013006443` (public id only)
- `YELLOW_MT5_SERVER=MetaQuotes-Demo`
- `YELLOW_MT5_MODE=DEMO`
- `YELLOW_MT5_LEVERAGE=1:500`
- `YELLOW_MT5_MAX_LOT=0.01`
- `YELLOW_MT5_BALANCE_HINT=15`
- `YELLOW_MT5_URL=https://web.metatrader.app/terminal`

Never store MT5 master/investor passwords in env or git.

## Yellow → POST report

`POST /api/trading/report`

Auth (one of):

- `Authorization: Bearer <YELLOW_INGEST_TOKEN>`
- `X-Yellow-Token: <YELLOW_INGEST_TOKEN>`
- Valid Hermes session cookie (dashboard user)

Body example:

```json
{
  "bias": "bullish sweep above 4140",
  "levels": { "eqh": 4145.2, "eql": 4132.8, "liquidity": [4140, 4135] },
  "decision": "take",
  "direction": "BUY",
  "entry": 4138.5,
  "sl": 4132.0,
  "tp": 4148.0,
  "lot": 0.01,
  "hold_seconds": 180,
  "margin": 2.4,
  "pnl": null,
  "balance": 15,
  "equity": 15,
  "session_window": "06:00-08:00",
  "notes": "Asia eqh sweep, waiting confirmation"
}
```

`decision` must be `skip` or `take`. Symbol must be `XAUUSD` (default).

Take with `entry` also mirrors a row into `trades` (source=`yellow`) when the column exists.

## GET cockpit payload

`GET /api/trading` (session cookie required) returns `account`, `session`, `day`, `lastReport`, `trades`, `strategy`, `rules`.

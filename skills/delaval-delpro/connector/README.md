# DelPro connector payload

Reads the farm's on-premises DelPro SQL Server database, normally `DDM`.
Use a dedicated read-only login with the `db_datareader` role.
Every query is SELECT-only; this connector never modifies DelPro.

Required config: `host`, `user`.
Optional connection config: `port` (1433), `database` (`DDM`).
The SQL password comes from Orion's OS keychain as `ctx.secret`.
Set `timezone` to the database's IANA wall-clock zone; the default is `UTC`.
Optional sync config: `dailyDays` (120), `milkingBatch` (1000), `maxBatches` (200).

Imports animal identity, sex, birth date, group, and active/sold status.
Imports incremental VMS milking yield in kg, conductivity, SCC, timing, and flags.
Imports completed-day weight and rectal temperature from live/archive daily rows.
Returned OID and day cursors prevent reimport on subsequent runs.
Timestamps are UTC; DST overlaps choose the earlier instant and gaps raise an error.
Lactation, reproduction, breed inference, and national registry rules are excluded.
Run `bun test` here; tests and mapping do not require the SQL driver installed.

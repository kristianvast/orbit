---

name: delaval-delpro
description: Import animals, milkings and daily weights from a DeLaval DelPro herd management server (SQL Server on the farm network). Use when the farmer has DeLaval milking equipment or DelPro and wants its data in Orbit.
---

# DeLaval DelPro

DelPro keeps its data in a Microsoft SQL Server database (usually named `DDM`) on a PC on the farm
network. This skill's connector reads it with a read-only login and never writes to DelPro.

## Set up

1. Ask the farmer where DelPro's database runs: the PC name or IP address, and the SQL Server port
   (1433 unless the dealer set another). They also need a read-only SQL login on the `DDM` database
   (`db_datareader`); their DeLaval dealer or IT person can create one. Ask for the farm's time
   zone if it is not saved yet (an IANA name such as `America/Chicago`); DelPro stores local times.
2. `connector_scaffold` with `{ "name": "delpro", "fromSkill": "delaval-delpro" }`. It copies
   the connector into `connectors/delpro/`, installs its SQL Server driver and registers it switched
   off.
3. `connector_configure` with the connector id and
   `{ "host": "...", "port": 1433, "database": "DDM", "user": "...", "timezone": "..." }`.
   Never put the password in config or files.
4. Ask the farmer to open Sensors & Robots > Connections, enter the SQL password with Password on the
   DelPro card, and switch the connector on.
5. `connector_run` once and report what was imported. The first run brings in the herd, the
   milking history and 120 days of daily weights and temperatures; later runs only fetch what is new.

## What it imports

- Animals: herd number (as ear tag number), official registration number, name, sex, birth date,
  group, and whether the animal has left the herd.
- Milkings: yield in kg per session, with conductivity, cell count, duration, the milking unit and
  incomplete or kick-off flags in the details.
- Daily records: weight (kg) and rectal temperature (C) per animal per finished day.

## When it fails

- "Failed to connect" or ESOCKET: wrong host or port, the PC is off, or the firewall blocks it. SQL
  Server must have TCP/IP switched on; a named instance needs its fixed port.
- "Login failed": wrong user name or password, or the login has no access to the database.
- Times look shifted: set `timezone` with `connector_configure` to the farm's time zone.
- Settings live in `connectors/delpro/` (README.md explains the code). Reinstall the skill with
  `skill_install` to get a newer version, then scaffold a new connector from it.

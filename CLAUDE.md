# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Setup & Running

**Local:**
```bash
cp .env.example .env        # fill in DB credentials
npm install
npm start                   # starts on http://localhost:3000
```

**Docker:**
```bash
docker build -t repstatus .
docker run -p 3000:3000 \
  -e MYSQL_HOST=<slave-host> \
  -e MYSQL_PORT=3306 \
  -e MONITOR_USER=monitor \
  -e MONITOR_USER_PASSWORD=secret \
  -e ADMIN_USER=admin \
  -e ADMIN_PASSWORD=changeme \
  repstatus
```

The target host must be the **slave/replica**, not the master. `ADMIN_PASSWORD` is required — the server exits on startup if unset. Optional: `POLL_INTERVAL_MS` (default 10000), `PORT` (default 3000), `SESSION_SECRET` (auto-generated if omitted, sessions invalidated on restart).

## Architecture

```
server.js          Node.js/Express backend
  └─ polls MySQL slave via SHOW SLAVE STATUS every POLL_INTERVAL_MS
  └─ keeps a rolling in-memory array (history[]) for the past 3 hours
  └─ exposes GET /api/status   → current replication state + last poll error
  └─ exposes GET /api/history  → timestamped array of {secondsBehindMaster, ioRunning, sqlRunning}
  └─ serves public/ as static files

public/index.html  Single-file dashboard (HTML + CSS + JS)
  └─ fetches /api/status and /api/history on load and every pollIntervalMs
  └─ renders 4 status cards, a details grid, and a Chart.js time-series chart
  └─ no build step — edit and refresh
```

## Key Details

- **MySQL compatibility**: `server.js` first tries `SHOW SLAVE STATUS`, falls back to `SHOW REPLICA STATUS` (MySQL 8.0.22+/MariaDB 10.5+).
- **History buffer**: pruned on every poll; entries older than 3 hours are shifted off the front of the array. No persistence — restarts clear history.
- **Frontend auto-refresh**: driven by `pollIntervalMs` returned from `/api/status`, so changing `POLL_INTERVAL_MS` in `.env` affects both backend polling and frontend refresh rate.
- **Chart**: uses Chart.js 4 + chartjs-adapter-date-fns (both loaded from CDN), time-series on x-axis.

## MySQL User Permissions

The DB user needs only:
```sql
GRANT REPLICATION CLIENT ON *.* TO 'monitor'@'%' IDENTIFIED BY 'secret';
```

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const mysql = require('mysql2/promise');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 10000;
const HISTORY_DURATION_MS = 3 * 60 * 60 * 1000; // 3 hours

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  console.error('ERROR: ADMIN_PASSWORD env var is required.');
  process.exit(1);
}

// ---- Session ----
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 }, // 8h
}));

// ---- Auth middleware ----
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

// ---- Login routes (public) ----
app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    req.session.username = username;
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---- Protected routes ----
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (_req, res) => {
  res.json({ current: currentStatus, lastPollError, lastUpdated, pollIntervalMs: POLL_INTERVAL_MS });
});

app.get('/api/history', (_req, res) => {
  res.json(history);
});

app.get('/api/slow-queries', async (_req, res) => {
  let connection;
  try {
    connection = await mysql.createConnection({
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: parseInt(process.env.MYSQL_PORT) || 3306,
      user: process.env.MONITOR_USER || 'root',
      password: process.env.MONITOR_USER_PASSWORD || '',
      connectTimeout: 5000,
    });

    // Check whether slow query table logging is active
    const [[logOutputRow], [slowLogRow]] = await Promise.all([
      connection.query("SHOW VARIABLES LIKE 'log_output'"),
      connection.query("SHOW VARIABLES LIKE 'slow_query_log'"),
    ]);
    const logOutput = (logOutputRow[0] && logOutputRow[0].Value || '').toUpperCase();
    const slowLogOn = (slowLogRow[0] && slowLogRow[0].Value || '').toUpperCase() === 'ON';
    const tableLogging = slowLogOn && logOutput.includes('TABLE');

    if (tableLogging) {
      const [rows] = await connection.query(
        `SELECT start_time, query_time, sql_text, rows_examined, rows_sent
         FROM mysql.slow_log
         WHERE start_time >= NOW() - INTERVAL 3 HOUR
         ORDER BY start_time DESC
         LIMIT 200`
      );
      return res.json({ queries: rows, source: 'slow_log', error: null });
    }

    // Fallback: performance_schema — works regardless of log_output setting.
    // TIMER_WAIT is in picoseconds; filter by long_query_time.
    // Approximate start_time from timer offset against current time.
    const [rows] = await connection.query(
      `SELECT
         DATE_SUB(NOW(), INTERVAL ROUND((TIMER_END - TIMER_WAIT) / 1e12, 0) SECOND) AS start_time,
         ROUND(TIMER_WAIT / 1e12, 4)  AS query_time,
         SQL_TEXT                     AS sql_text,
         ROWS_EXAMINED                AS rows_examined,
         ROWS_SENT                    AS rows_sent
       FROM performance_schema.events_statements_history_long
       WHERE TIMER_WAIT / 1e12 >= @@long_query_time
         AND SQL_TEXT IS NOT NULL
         AND (TIMER_END - TIMER_WAIT) / 1e12 <= @@global.uptime
       ORDER BY TIMER_WAIT DESC
       LIMIT 200`
    );
    res.json({ queries: rows, source: 'performance_schema', error: null });
  } catch (err) {
    res.json({ queries: [], source: null, error: err.message });
  } finally {
    if (connection) { try { await connection.end(); } catch (_) {} }
  }
});

// ---- Replication polling ----
const history = [];
let currentStatus = null;
let lastPollError = null;
let lastUpdated = null;

function pruneHistory() {
  const cutoff = Date.now() - HISTORY_DURATION_MS;
  while (history.length > 0 && history[0].timestamp < cutoff) history.shift();
}

function appendHistory(row) {
  history.push({
    timestamp: Date.now(),
    secondsBehindMaster: row.Seconds_Behind_Master,
    ioRunning: row.Slave_IO_Running,
    sqlRunning: row.Slave_SQL_Running,
    readMasterLogPos: row.Read_Master_Log_Pos,
    execMasterLogPos: row.Exec_Master_Log_Pos,
  });
  pruneHistory();
}

function normalizeRow(row) {
  return {
    slaveIoRunning: row.Slave_IO_Running,
    slaveSqlRunning: row.Slave_SQL_Running,
    secondsBehindMaster: row.Seconds_Behind_Master,
    readMasterLogPos: row.Read_Master_Log_Pos,
    execMasterLogPos: row.Exec_Master_Log_Pos,
    lastIoError: row.Last_IO_Error || null,
    lastSqlError: row.Last_SQL_Error || null,
    lastError: row.Last_Error || null,
    slaveIoState: row.Slave_IO_State,
    slaveSqlRunningState: row.Slave_SQL_Running_State,
  };
}

async function poll() {
  let connection;
  try {
    connection = await mysql.createConnection({
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: parseInt(process.env.MYSQL_PORT) || 3306,
      user: process.env.MONITOR_USER || 'root',
      password: process.env.MONITOR_USER_PASSWORD || '',
      connectTimeout: 5000,
    });

    let rows;
    try {
      [rows] = await connection.query('SHOW SLAVE STATUS');
    } catch (e) {
      if (e.code === 'ER_PARSE_ERROR') {
        [rows] = await connection.query('SHOW REPLICA STATUS');
      } else {
        throw e;
      }
    }

    if (!rows || rows.length === 0) {
      currentStatus = null;
      lastPollError = 'No replication configured on this server, or not a replica.';
    } else {
      currentStatus = normalizeRow(rows[0]);
      appendHistory(rows[0]);
      lastPollError = null;
    }
    lastUpdated = Date.now();
  } catch (err) {
    lastPollError = err.message;
    console.error('[poll error]', err.message);
  } finally {
    if (connection) { try { await connection.end(); } catch (_) {} }
  }
}

poll();
setInterval(poll, POLL_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`Replication dashboard → http://localhost:${PORT}`);
  console.log(`Polling every ${POLL_INTERVAL_MS / 1000}s`);
});

// js/db.js — shared helpers

// ---- Global constants ----
const FYT_TO_USD = 0.1545;
const API_BASE = '/api/table-data';

// ---- Current user (reactive) ----
function getCurrentUserId() {
  const v = localStorage.getItem('flytech_current_user_id');
  return v ? Number(v) : 1;
}
Object.defineProperty(window, 'CURRENT_USER_ID', {
  get() { return getCurrentUserId(); },
  configurable: true,
});

// ─────────────────────────────────────────────────────────────
// isDateColumn — ONLY these columns get run through cleanDate
// ─────────────────────────────────────────────────────────────
function isDateColumn(colName) {
  const c = String(colName || '').toLowerCase();
  return (
    c === 'created_at'      ||
    c === 'updated_at'      ||
    c === 'expires_at'      ||
    c === 'recorded_date'   ||
    c === 'trade_timestamp' ||
    c === 'timestamp'       ||
    c.endsWith('_at')       ||
    c.endsWith('_date')     ||
    c.endsWith('_time')     ||
    c.includes('date')      ||
    c.includes('time')
  );
}

// ─────────────────────────────────────────────────────────────
// cleanDate — "14 September 2026, 15:00"
// ─────────────────────────────────────────────────────────────
function cleanDate(s) {
  if (s === null || s === undefined || s === '') return '—';

  const d = (s instanceof Date) ? s : new Date(String(s));
  if (isNaN(d.getTime())) return String(s).trim();

  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  const dayNum = d.getDate();
  const month  = months[d.getMonth()];
  const year   = d.getFullYear();
  const hh     = String(d.getHours()).padStart(2, '0');
  const min    = String(d.getMinutes()).padStart(2, '0');

  const raw = String(s);
  const hasTime = /\d{1,2}:\d{2}/.test(raw);
  if (!hasTime) {
    return dayNum + ' ' + month + ' ' + year;
  }

  return dayNum + ' ' + month + ' ' + year + ', ' + hh + ':' + min;
}

// ---- Load table data into a <table> ----
async function loadTableInto(tableName, headersId, bodyId, opts = {}) {
  const headersTr = document.getElementById(headersId);
  const tbody = document.getElementById(bodyId);
  if (!headersTr || !tbody) return;

  if (!tableName) {
    headersTr.innerHTML = '';
    tbody.innerHTML = '<tr><td colspan="99" class="loading small">No table selected</td></tr>';
    return null;
  }

  headersTr.innerHTML = '';
  tbody.innerHTML = '<tr><td colspan="99" class="loading small">Loading…</td></tr>';

  try {
    const res = await fetch(`${API_BASE}/${tableName}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();

    headersTr.innerHTML = '';
    result.columns.forEach(col => {
      const th = document.createElement('th');
      th.innerText = col.replace(/_/g, ' ').toUpperCase();
      headersTr.appendChild(th);
    });

    tbody.innerHTML = '';
    if (!result.rows.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="${result.columns.length}" class="loading small">No records</td>`;
      tbody.appendChild(tr);
      return result;
    }

    result.rows.forEach(row => {
      const tr = document.createElement('tr');
      row.forEach((val, colIdx) => {
        const td = document.createElement('td');
        const colName = result.columns[colIdx];

        if (val === null || val === undefined) {
          td.innerText = '—';
        } else if (typeof val === 'number' && opts.formatNumbers !== false) {
          // real numbers — format directly
          td.innerText = Number.isInteger(val) ? val : val.toFixed(2);
        } else if (colName === 'trigger_definition') {
          const s = String(val);
          td.innerText = s.length > 120 ? s.slice(0, 120) + '…' : s;
          td.title = s;
          td.style.maxWidth = '480px';
          td.style.overflow = 'hidden';
          td.style.textOverflow = 'ellipsis';
        } else if (isDateColumn(colName)) {
          // ONLY date/time columns get formatted
          td.innerText = cleanDate(val);
        } else {
          // everything else — print raw string, no date parsing
          td.innerText = String(val);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    return result;
  } catch (err) {
    console.error(`Failed to load ${tableName}:`, err);
    tbody.innerHTML = `<tr><td colspan="99" class="loading small">Backend offline</td></tr>`;
    return null;
  }
}

// ---- Explorer loader (called on dropdown change) ----
async function loadDatabaseData() {
  const select = document.getElementById('tableSelect');
  const tableEl = document.getElementById('dbTable');
  const loadingDiv = document.getElementById('loading');
  if (!select || !tableEl || !loadingDiv) return;

  const tableName = select.value;
  if (!tableName) {
    loadingDiv.style.display = 'block';
    loadingDiv.innerText = 'Waiting for table list…';
    tableEl.style.display = 'none';
    return;
  }

  loadingDiv.style.display = 'block';
  loadingDiv.innerText = 'Loading data...';
  tableEl.style.display = 'none';

  const result = await loadTableInto(tableName, 'tableHeaders', 'tableBody');
  if (result) {
    loadingDiv.style.display = 'none';
    tableEl.style.display = 'table';
  } else {
    loadingDiv.innerText = 'Could not connect to backend.';
  }
}

// ---- Fetch a table as JSON ----
async function fetchTable(tableName) {
  const res = await fetch(`${API_BASE}/${tableName}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---- Format helpers ----
function fmtMoney(n) { return Number(n).toFixed(2); }
function fmtKwh(n)   { return Number(n).toFixed(2); }
function fmtDate(s) {
  if (!s) return '—';
  return cleanDate(s);
}

// ---- Buy energy (DB triggers handle wallet + listing status + audit) ----
async function buyEnergy(listingId, kwh, pricePerKwh) {
  const payload = {
    listing_id:      listingId,
    consumer_id:     getCurrentUserId(),
    kwh_transferred: Number(kwh),
    total_cost:      Number((kwh * pricePerKwh).toFixed(2)),
    trade_timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
  };

  const res = await fetch(`${API_BASE}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Purchase failed');

  return data;
}
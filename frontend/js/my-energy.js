// js/my-energy.js
window.addEventListener('DOMContentLoaded', async () => {

  const norm = s => String(s).toLowerCase().replace(/[\s_]+/g, '');
  const findCol = (cols, ...names) => {
    for (const name of names) {
      const i = cols.findIndex(c => norm(c) === norm(name));
      if (i !== -1) return i;
    }
    return -1;
  };

  const MY_ID = Number(CURRENT_USER_ID);

  // ── Generation summary ──
  try {
    const g = await fetchTable('generation_logs');
    const i = {
      user_id: findCol(g.columns, 'user_id', 'User ID'),
      solar:   findCol(g.columns, 'solar_generated_kwh', 'Solar Generated kWh'),
      batt:    findCol(g.columns, 'battery_storage_level_pct', 'battery_stored_kwh'),
    };
    if (i.user_id === -1 || i.solar === -1) throw new Error('Missing columns');

    const mine = g.rows.filter(r => Number(r[i.user_id]) === MY_ID);
    const total = mine.reduce((s, r) => s + Number(r[i.solar] || 0), 0);
    const batt = mine.length
      ? mine.reduce((s, r) => s + Number(r[i.batt] || 0), 0) / mine.length
      : 0;

    document.getElementById('totalGenerated').innerHTML =
      fmtKwh(total) + ' <small>kWh</small>';
    document.getElementById('batteryStored').innerHTML =
      fmtKwh(batt) + ' <small>%</small>';
  } catch (e) { console.error('[my-energy] Generation summary failed:', e); }

  // ── Sold this month + revenue ──
  try {
    const [listings, transactions] = await Promise.all([
      fetchTable('energy_listings'),
      fetchTable('transactions'),
    ]);

    const lIdx = {
      id:      findCol(listings.columns, 'listing_id', 'id'),
      user_id: findCol(listings.columns, 'prosumer_id', 'user_id'),
    };
    const tIdx = {
      listing_id: findCol(transactions.columns, 'listing_id'),
      kwh:        findCol(transactions.columns, 'kwh_transferred'),
      total:      findCol(transactions.columns, 'total_cost', 'total_price'),
      ts:         findCol(transactions.columns, 'trade_timestamp', 'timestamp'),
    };

    const myListingIds = new Set(
      listings.rows
        .filter(r => Number(r[lIdx.user_id]) === MY_ID)
        .map(r => Number(r[lIdx.id]))
    );

    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear  = now.getFullYear();

    const isThisMonth = (s) => {
      if (!s) return false;
      const d = new Date(s);
      if (isNaN(d.getTime())) return false;
      return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
    };

    const mineThisMonth = transactions.rows.filter(r => {
      if (!myListingIds.has(Number(r[tIdx.listing_id]))) return false;
      return isThisMonth(r[tIdx.ts]);
    });

    const sold = mineThisMonth.reduce((s, r) => s + Number(r[tIdx.kwh]   || 0), 0);
    const rev  = mineThisMonth.reduce((s, r) => s + Number(r[tIdx.total] || 0), 0);

    document.getElementById('soldMonth').innerHTML =
      fmtKwh(sold) + ' <small>kWh</small>';
        document.getElementById('revenueMonth').innerHTML =
      '&pound;' + fmtMoney(rev);
  } catch (e) { console.error('[my-energy] Monthly stats failed:', e); }

  // ── Generation logs table — USER ONLY ──
  try {
    const g = await fetchTable('generation_logs');
    const iU = findCol(g.columns, 'user_id', 'User ID');
    const filtered = {
      columns: g.columns,
      rows: g.rows.filter(r => Number(r[iU]) === MY_ID),
    };
    renderTable(filtered, 'genHeaders', 'genBody');
  } catch (e) { console.error('[my-energy] Generation logs table failed:', e); }

  // ── My listings table ──
  try {
    const data = await fetchTable('energy_listings');
    const iU = findCol(data.columns, 'prosumer_id', 'user_id', 'Prosumer ID', 'User ID');
    const filtered = {
      columns: data.columns,
      rows: data.rows.filter(r => Number(r[iU]) === MY_ID),
    };
    renderTable(filtered, 'listingHeaders', 'listingBody');
  } catch (e) { console.error('[my-energy] Listings table failed:', e); }
});

window.addEventListener('userChanged', () => {
  location.reload();
});


function renderTable(result, headersId, bodyId) {
  const headersTr = document.getElementById(headersId);
  const tbody = document.getElementById(bodyId);
  if (!headersTr || !tbody) return;

  headersTr.innerHTML = '';
  tbody.innerHTML = '';

  result.columns.forEach(col => {
    const th = document.createElement('th');
    th.innerText = col.replace(/_/g, ' ').toUpperCase();
    headersTr.appendChild(th);
  });

  if (!result.rows.length) {
    tbody.innerHTML = '<tr><td colspan="' + result.columns.length +
      '" class="loading small">No records for this user</td></tr>';
    return;
  }

  result.rows.forEach(row => {
    const tr = document.createElement('tr');
    row.forEach((v, colIdx) => {
      const td = document.createElement('td');
      const colName = result.columns[colIdx];

      if (v === null || v === undefined) {
        td.innerText = '—';
      } else if (typeof v === 'number') {
        td.innerText = Number.isInteger(v) ? v : v.toFixed(2);
      } else if (isDateColumn(colName)) {
        td.innerText = cleanDate(v);
      } else {
        td.innerText = String(v);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}
// js/community.js
window.addEventListener('DOMContentLoaded', async () => {

  const norm = s => String(s).toLowerCase().replace(/[\s_]+/g, '');
  const findCol = (cols, ...names) => {
    for (const name of names) {
      const i = cols.findIndex(c => norm(c) === norm(name));
      if (i !== -1) return i;
    }
    return -1;
  };

  // ── Members table ──
  try {
    const users = await fetchTable('users');
    const i = {
      id:     findCol(users.columns, 'user_id', 'id'),
      name:   findCol(users.columns, 'full_name', 'username', 'name'),
      email:  findCol(users.columns, 'email'),
      role:   findCol(users.columns, 'role_type', 'role'),
      active: findCol(users.columns, 'is_active'),
      joined: findCol(users.columns, 'created_at'),
    };

    document.getElementById('memberCount').innerText = users.rows.length + ' members';
    renderMembersTable(users, i);
  } catch (e) { console.error('[community] Members table failed:', e); }

  // ── Activity log ──
  try {
    const logs = await fetchTable('audit_logs');
    const i = {
      id:      findCol(logs.columns, 'audit_id', 'id'),
      user_id: findCol(logs.columns, 'user_id', 'User ID'),
      event:   findCol(logs.columns, 'event_type'),
      details: findCol(logs.columns, 'log_details', 'details'),
      ts:      findCol(logs.columns, 'recorded_at', 'timestamp'),
    };
    renderActivityTable(logs, i);
  } catch (e) { console.error('[community] Activity table failed:', e); }

  // ── Leaderboard ──
  try {
    const [transactions, users, listings] = await Promise.all([
      fetchTable('transactions'),
      fetchTable('users'),
      fetchTable('energy_listings'),
    ]);

    const tIdx = {
      listing_id: findCol(transactions.columns, 'listing_id'),
      kwh:        findCol(transactions.columns, 'kwh_transferred'),
    };
    const uIdx = {
      id:   findCol(users.columns, 'user_id', 'id'),
      name: findCol(users.columns, 'full_name', 'username', 'name'),
    };
    const lIdx = {
      id:      findCol(listings.columns, 'listing_id', 'id'),
      user_id: findCol(listings.columns, 'prosumer_id', 'user_id'),
    };

    const listingToSeller = {};
    listings.rows.forEach(r => {
      listingToSeller[Number(r[lIdx.id])] = Number(r[lIdx.user_id]);
    });

    const totals = {};
    transactions.rows.forEach(r => {
      const sellerId = listingToSeller[Number(r[tIdx.listing_id])];
      if (!sellerId) return;
      totals[sellerId] = (totals[sellerId] || 0) + Number(r[tIdx.kwh] || 0);
    });

    const sorted = Object.entries(totals)
      .map(([uid, kwh]) => ({ uid: Number(uid), kwh }))
      .sort((a, b) => b.kwh - a.kwh)
      .slice(0, 5);

    const container = document.getElementById('leaderboard');
    container.innerHTML = '';

    if (!sorted.length) {
      container.innerHTML = '<div class="loading small">No sales yet</div>';
      return;
    }

    sorted.forEach((entry, idx) => {
      const userRow = users.rows.find(r => Number(r[uIdx.id]) === entry.uid);
      const name = userRow ? userRow[uIdx.name] : 'User #' + entry.uid;
      const rankClass = idx === 0 ? 'gold' : idx === 1 ? 'silver' : idx === 2 ? 'bronze' : '';

      const item = document.createElement('div');
      item.className = 'leader-item';
      item.innerHTML = ''
        + '<div class="leader-rank ' + rankClass + '">#' + (idx + 1) + '</div>'
        + '<div class="leader-info">'
        +   '<div class="leader-name">' + name + '</div>'
        +   '<div class="leader-sub">' + entry.kwh.toFixed(1) + ' kWh sold</div>'
        + '</div>'
        + '<div class="leader-value">' + entry.kwh.toFixed(1) + ' kWh</div>';
      container.appendChild(item);
    });
  } catch (e) {
    console.error('[community] Leaderboard failed:', e);
    document.getElementById('leaderboard').innerHTML =
      '<div class="loading small">Leaderboard unavailable</div>';
  }
});

// ─── Auto-reload when user switcher changes ───
window.addEventListener('userChanged', () => {
  location.reload();
});

// ─────────────────────────────────────────────────────────────
// Members table renderer
// ─────────────────────────────────────────────────────────────
function renderMembersTable(users, i) {
  const headersTr = document.getElementById('membersHeaders');
  const tbody     = document.getElementById('membersBody');
  headersTr.innerHTML = '';
  tbody.innerHTML = '';

  const columns = [
    { label: 'ID',     idx: i.id,     key: 'id' },
    { label: 'NAME',   idx: i.name,   key: 'name' },
    { label: 'EMAIL',  idx: i.email,  key: 'email' },
    { label: 'ROLE',   idx: i.role,   key: 'role' },
    { label: 'ACTIVE', idx: i.active, key: 'active' },
    { label: 'JOINED', idx: i.joined, key: 'joined' },
  ];

  columns.forEach(c => {
    if (c.idx === -1) return;
    const th = document.createElement('th');
    th.innerText = c.label;
    headersTr.appendChild(th);
  });

  if (!users.rows.length) {
    tbody.innerHTML = '<tr><td colspan="' + columns.length +
      '" class="loading small">No users</td></tr>';
    return;
  }

  users.rows.forEach(row => {
    const tr = document.createElement('tr');
    columns.forEach(c => {
      if (c.idx === -1) return;
      const td = document.createElement('td');
      const v = row[c.idx];

      if (v === null || v === undefined) {
        td.innerText = '—';
      } else if (typeof v === 'boolean') {
        td.innerText = v ? 'Yes' : 'No';
      } else if (c.key === 'joined') {
        td.innerText = cleanDate(v);
      } else {
        td.innerText = String(v);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

// ─────────────────────────────────────────────────────────────
// Activity table renderer
// ─────────────────────────────────────────────────────────────
function renderActivityTable(logs, i) {
  const headersTr = document.getElementById('activityHeaders');
  const tbody     = document.getElementById('activityBody');
  headersTr.innerHTML = '';
  tbody.innerHTML = '';

  const columns = [
    { label: 'ID',       idx: i.id },
    { label: 'USER',     idx: i.user_id },
    { label: 'EVENT',    idx: i.event },
    { label: 'DETAILS',  idx: i.details },
    { label: 'RECORDED', idx: i.ts },
  ];

  columns.forEach(c => {
    if (c.idx === -1) return;
    const th = document.createElement('th');
    th.innerText = c.label;
    headersTr.appendChild(th);
  });

  if (!logs.rows.length) {
    tbody.innerHTML = '<tr><td colspan="' + columns.length +
      '" class="loading small">No activity</td></tr>';
    return;
  }

  // Sort by timestamp descending — most recent first
  const sorted = [...logs.rows].sort((a, b) => {
    const ta = new Date(a[i.ts] || 0).getTime();
    const tb = new Date(b[i.ts] || 0).getTime();
    return tb - ta;
  });

  sorted.slice(0, 50).forEach(row => {
    const tr = document.createElement('tr');
    columns.forEach((c, colIdx) => {
      if (c.idx === -1) return;
      const td = document.createElement('td');
      const v = row[c.idx];

      if (v === null || v === undefined) {
        td.innerText = '—';
      } else if (c.label === 'RECORDED') {
        td.innerText = cleanDate(v);
      } else if (c.label === 'USER') {
        td.innerText = '#' + v;
      } else {
        td.innerText = String(v);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}
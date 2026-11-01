// js/marketplace.js
window.addEventListener('DOMContentLoaded', async () => {

  // ───────────────────────────────────────────────────────────
  // 1. Populate schema dropdown from /api/tables (async)
  // 2. THEN load the default table — so fetch always has a name
  // ───────────────────────────────────────────────────────────
  const sel = document.getElementById('tableSelect');
  if (sel) {
    await populateTableSelector(sel);
    if (typeof loadDatabaseData === 'function') {
      await loadDatabaseData();
    }
  }

  const norm = s => String(s).toLowerCase().replace(/[\s_]+/g, '');
  const findCol = (cols, ...names) => {
    for (const name of names) {
      const i = cols.findIndex(c => norm(c) === norm(name));
      if (i !== -1) return i;
    }
    return -1;
  };

  const initials = (name) => {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  };

  const cheapestEl = document.getElementById('cheapestCardsContainer');
  const bulkEl     = document.getElementById('bulkCardsContainer');

  if (cheapestEl || bulkEl) {
    try {
      const [data, usersData] = await Promise.all([
        fetchTable('energy_listings'),
        fetchTable('users'),
      ]);

      const idx = {
        id:      findCol(data.columns, 'listing_id', 'id', 'Listing ID'),
        user_id: findCol(data.columns, 'prosumer_id', 'user_id', 'Prosumer ID', 'User ID'),
        kwh:     findCol(data.columns, 'energy_amount_kwh', 'Energy Amount kWh'),
        price:   findCol(data.columns, 'price_per_kwh', 'Price per kWh'),
        status:  findCol(data.columns, 'status', 'Status'),
        expires: findCol(data.columns, 'expires_at', 'Expires At'),
      };

      if (idx.id === -1 || idx.kwh === -1 || idx.price === -1 || idx.status === -1) {
        throw new Error('Column mapping failed');
      }

      const uIdx = {
        id:   findCol(usersData.columns, 'user_id', 'id'),
        name: findCol(usersData.columns, 'full_name', 'username', 'name'),
      };
      const userMap = {};
      usersData.rows.forEach(r => {
        userMap[r[uIdx.id]] = r[uIdx.name];
      });

      // DB uses 'Available' — compare lowercase
      const active = data.rows.filter(
        r => String(r[idx.status]).toLowerCase() === 'available'
      );

      const cheapest = [...active]
        .sort((a, b) => Number(a[idx.price]) - Number(b[idx.price]))
        .slice(0, 12);

      const bulk = [...active]
        .sort((a, b) => Number(b[idx.kwh]) - Number(a[idx.kwh]))
        .slice(0, 12);

      renderCards(cheapest, 'cheapestCardsContainer', idx, userMap, initials);
      renderCards(bulk,     'bulkCardsContainer',     idx, userMap, initials);

      const cCount = document.getElementById('cheapestCount');
      const bCount = document.getElementById('bulkCount');
      if (cCount) cCount.innerText = cheapest.length + ' of ' + active.length + ' offers';
      if (bCount) bCount.innerText = bulk.length + ' of ' + active.length + ' offers';

    } catch (e) {
      console.error('Listing cards failed:', e);
      if (cheapestEl) cheapestEl.innerHTML = '<div class="loading">Could not load listings</div>';
      if (bulkEl)     bulkEl.innerHTML     = '<div class="loading">Could not load listings</div>';
    }
  }

  // ── Wallet ──
  const walletBalanceEl = document.getElementById('walletBalance');
  if (walletBalanceEl) {
    try {
      const w = await fetchTable('user_wallets');
      const i = {
        user_id: findCol(w.columns, 'user_id', 'User ID'),
        bal:     findCol(w.columns, 'balance_amount', 'balance_tokens'),
        upd:     findCol(w.columns, 'updated_at', 'last_updated'),
      };
      const row = w.rows.find(r => Number(r[i.user_id]) === CURRENT_USER_ID) || w.rows[0];
      if (row) {
        walletBalanceEl.innerHTML = '&pound;' + fmtMoney(row[i.bal]);
        const usdEl = document.getElementById('walletUsd');
        const updEl = document.getElementById('walletUpdated');
        if (usdEl) usdEl.innerText = '≈ $' + (row[i.bal] * FYT_TO_USD).toFixed(2) + ' USD';
        if (updEl) updEl.innerText = fmtDate(row[i.upd]);
      }
    } catch (e) { console.error('Wallet snippet failed:', e); }
  }

  // ── Generation ──
  const genTodayEl = document.getElementById('genToday');
  if (genTodayEl) {
    try {
      const g = await fetchTable('generation_logs');
      const i = {
        user_id: findCol(g.columns, 'user_id', 'User ID'),
        solar:   findCol(g.columns, 'solar_generated_kwh', 'Solar Generated kWh'),
        batt:    findCol(g.columns, 'battery_storage_level_pct', 'battery_stored_kwh'),
      };
      const mine = g.rows.filter(r => Number(r[i.user_id]) === CURRENT_USER_ID);
      const solar = mine.reduce((s, r) => s + Number(r[i.solar] || 0), 0);
      const batt  = mine.length
        ? mine.reduce((s, r) => s + Number(r[i.batt] || 0), 0) / mine.length
        : 0;

      genTodayEl.innerText = '+' + fmtKwh(solar) + ' kWh';
      const solarEl = document.getElementById('genSolar');
      const battEl  = document.getElementById('genBattery');
      if (solarEl) solarEl.innerText = fmtKwh(solar) + ' kWh';
      if (battEl)  battEl.innerText  = fmtKwh(batt) + '%';
    } catch (e) { console.error('Generation snippet failed:', e); }
  }

  // ── Sidebar listing count ──
  const genListingsEl = document.getElementById('genListings');
  if (genListingsEl) {
    try {
      const l = await fetchTable('energy_listings');
      const iU = findCol(l.columns, 'prosumer_id', 'user_id');
      const iS = findCol(l.columns, 'status');
      const mine = l.rows.filter(r =>
        Number(r[iU]) === CURRENT_USER_ID &&
        String(r[iS]).toLowerCase() === 'available'
      );
      genListingsEl.innerText = mine.length;
    } catch (e) { console.error('Sidebar listing count failed:', e); }
  }
});


// ─────────────────────────────────────────────────────────────
// Populate <select id="tableSelect"> from /api/tables
// ─────────────────────────────────────────────────────────────
async function populateTableSelector(selectEl) {
  const countEl = document.getElementById('schemaCount');

  try {
    const res = await fetch('/api/tables');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const tables = await res.json();

    selectEl.innerHTML = '';

    const groups = {
      table: { label: 'Tables',          items: [] },
      view:  { label: 'Views',           items: [] },
      meta:  { label: 'Schema metadata', items: [] },
    };

    tables.forEach(t => {
      const kind = t.kind || 'table';
      if (!groups[kind]) groups[kind] = { label: kind, items: [] };
      groups[kind].items.push(t);
    });

    Object.values(groups).forEach(g => {
      if (!g.items.length) return;
      const og = document.createElement('optgroup');
      og.label = g.label;

      g.items.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.name;

        const friendly = {
          energy_listings:         'Energy Listings',
          users:                   'Users',
          transactions:            'Transactions',
          user_wallets:            'User Wallets',
          generation_logs:         'Generation Logs (parent)',
          generation_logs_2026_10: 'Generation Logs (Oct 2026)',
          audit_logs:              'Audit Logs',
          foreign_keys:            'Foreign Keys (FK)',
          triggers:                'Database Triggers',
        };
        let label = friendly[t.name] || t.name;

        if (typeof t.row_count === 'number') {
          label += ' (' + t.row_count + ')';
        }

        opt.textContent = label;
        og.appendChild(opt);
      });

      selectEl.appendChild(og);
    });

    // Preselect energy_listings, fall back to first real option
    const preferred =
      Array.from(selectEl.options).find(o => o.value === 'energy_listings') ||
      Array.from(selectEl.options).find(o => o.value);
    if (preferred) selectEl.value = preferred.value;

    // Enable after options exist
    selectEl.disabled = false;

    if (countEl) {
      const totalTables = Object.values(groups).reduce((s, g) => s + g.items.length, 0);
      countEl.innerText = totalTables + ' objects';
    }

  } catch (e) {
    console.error('[schema] Could not load /api/tables:', e);
    selectEl.innerHTML = '<option value="">Could not load tables</option>';
    selectEl.disabled = false;
    if (countEl) {
      countEl.innerText = 'Backend offline';
      countEl.style.color = '#e74c3c';
    }
  }
}


// Reload page when user switcher changes active user
window.addEventListener('userChanged', () => {
  location.reload();
});


// ─────────────────────────────────────────────────────────────
// Render seller cards
// ─────────────────────────────────────────────────────────────
function renderCards(rows, containerId, idx, userMap, initials) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (!rows.length) {
    container.innerHTML = '<div class="loading small">No active offers available</div>';
    return;
  }

  const getInitials = initials || (name => {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  });

  rows.forEach(row => {
    const isActive   = String(row[idx.status]).toLowerCase() === 'available';
    const sellerId   = row[idx.user_id];
    const sellerName = (userMap && userMap[sellerId]) || ('User #' + sellerId);
    const sellerInit = getInitials(sellerName);

    const card = document.createElement('div');
    card.className = 'energy-card';

    const html = ''
      + '<div class="card-top">'
      +   '<div class="seller" title="' + sellerName + '">'
      +     '<span class="seller-avatar">' + sellerInit + '</span>'
      +     '<span class="seller-name">' + sellerName + '</span>'
      +   '</div>'
      +   '<div class="price-tag">&pound;' + fmtMoney(row[idx.price]) + '/kWh</div>'
      + '</div>'
      + '<div class="energy-amount">' + fmtKwh(row[idx.kwh]) + ' <small>kWh</small></div>'
      + '<div class="expiry">'
      +   '<span>Expires: ' + fmtDate(row[idx.expires]) + '</span>'
      +   '<span>' + row[idx.status] + '</span>'
      + '</div>'
      + '<button class="buy-btn"' + (isActive ? '' : ' disabled') + '>'
      +   (isActive ? 'Buy energy' : 'sold out')
      + '</button>';

    card.innerHTML = html;

    if (isActive) {
      const btn = card.querySelector('.buy-btn');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.innerText = 'Processing...';
        try {
          await buyEnergy(row[idx.id], row[idx.kwh], row[idx.price]);
          btn.innerText = 'Purchased';
        } catch (err) {
          alert('Purchase failed: ' + err.message);
          btn.disabled = false;
          btn.innerText = 'Buy energy';
        }
      });
    }

    container.appendChild(card);
  });
}
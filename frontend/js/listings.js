// js/listings.js

let allListingsCache = null;
let userMapCache = {};

window.addEventListener('DOMContentLoaded', async () => {
  await refreshListings();
});

// Reload on user switch
window.addEventListener('userChanged', () => {
  location.reload();
});

// --- Fetch listings + user names, then render ---
async function refreshListings() {
  const norm = s => String(s).toLowerCase().replace(/[\s_]+/g, '');
  const findCol = (cols, ...names) => {
    for (const name of names) {
      const i = cols.findIndex(c => norm(c) === norm(name));
      if (i !== -1) return i;
    }
    return -1;
  };

  try {
    const [listings, users] = await Promise.all([
      fetchTable('energy_listings'),
      fetchTable('users'),
    ]);

    // Build user_id ? name lookup
    const uIdx = {
      id:   findCol(users.columns, 'user_id', 'id'),
      name: findCol(users.columns, 'full_name', 'username', 'name'),
    };
    userMapCache = {};
    users.rows.forEach(r => {
      userMapCache[Number(r[uIdx.id])] = r[uIdx.name];
    });

    allListingsCache = {
      listings,
      uIdx,
    };

    renderMyListings(listings);
    renderAllListings(listings);
  } catch (e) {
    console.error('[listings] Load failed:', e);
  }
}

// --- My listings panel ---
function renderMyListings(data) {
  const norm = s => String(s).toLowerCase().replace(/[\s_]+/g, '');
  const findCol = (cols, ...names) => {
    for (const name of names) {
      const i = cols.findIndex(c => norm(c) === norm(name));
      if (i !== -1) return i;
    }
    return -1;
  };

  const i = {
    id:      findCol(data.columns, 'listing_id', 'id'),
    user_id: findCol(data.columns, 'prosumer_id', 'user_id'),
    kwh:     findCol(data.columns, 'energy_amount_kwh'),
    price:   findCol(data.columns, 'price_per_kwh'),
    status:  findCol(data.columns, 'status'),
    expires: findCol(data.columns, 'expires_at'),
  };

  const MY_ID = Number(CURRENT_USER_ID);
  const mine = data.rows.filter(r => Number(r[i.user_id]) === MY_ID);

  const container = document.getElementById('myListings');
  container.innerHTML = '';

  const activeCount = mine.filter(r =>
    String(r[i.status]).toLowerCase() === 'available'
  ).length;
  document.getElementById('activeCount').innerText = activeCount + ' active';

  if (!mine.length) {
    container.innerHTML = '<div class="loading small">No listings yet — create one</div>';
    return;
  }

  mine.forEach(row => {
    const item = document.createElement('div');
    item.className = 'my-listing-item';
    item.innerHTML = ''
      + '<div class="my-listing-info">'
      +   '<div class="name">' + fmtKwh(row[i.kwh]) + ' kWh @ &pound;' +
             fmtMoney(row[i.price]) + '/kWh</div>'
      +   '<div class="sub">ID #' + row[i.id] + ' &middot; ' + row[i.status] +
    ' &middot; expires ' + cleanDate(row[i.expires]) + '</div>'
      + '</div>'
      + '<div class="my-listing-actions">'
      +   '<button class="btn-icon danger" title="Delete" data-id="' + row[i.id] + '">&times;</button>'
      + '</div>';

    const delBtn = item.querySelector('.btn-icon.danger');
    if (delBtn) {
      delBtn.addEventListener('click', () => deleteListing(row[i.id]));
    }

    container.appendChild(item);
  });
}

// --- All listings table ---
function renderAllListings(data) {
  const norm = s => String(s).toLowerCase().replace(/[\s_]+/g, '');
  const findCol = (cols, ...names) => {
    for (const name of names) {
      const i = cols.findIndex(c => norm(c) === norm(name));
      if (i !== -1) return i;
    }
    return -1;
  };

  const iS = findCol(data.columns, 'status');

  const filter = document.getElementById('statusFilter')?.value || 'all';
  let rows = data.rows;
  if (filter !== 'all') {
    rows = rows.filter(r =>
      String(r[iS]).toLowerCase() === filter.toLowerCase()
    );
  }

  const headersTr = document.getElementById('allListingsHeaders');
  const tbody     = document.getElementById('allListingsBody');
  headersTr.innerHTML = '';
  tbody.innerHTML = '';

  data.columns.forEach(col => {
    const th = document.createElement('th');
    th.innerText = col.replace(/_/g, ' ').toUpperCase();
    headersTr.appendChild(th);
  });

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="' + data.columns.length +
      '" class="loading small">No listings match filter</td></tr>';
    return;
  }

  rows.forEach(row => {
    const tr = document.createElement('tr');
    row.forEach((v, colIdx) => {
      const td = document.createElement('td');
      const colName = data.columns[colIdx];

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

function filterListings() {
  if (allListingsCache) {
    renderAllListings(allListingsCache.listings);
  }
}

// --- Create new listing ---
async function createListing(e) {
  e.preventDefault();

  const amount     = parseFloat(document.getElementById('amount').value);
  const price      = parseFloat(document.getElementById('price').value);
  const expiresRaw = document.getElementById('expires').value;
  const msg        = document.getElementById('formMessage');

  if (!amount || !price || !expiresRaw) {
    msg.innerText = 'All fields are required';
    msg.style.color = '#e74c3c';
    return;
  }

  // Convert "2026-10-22T18:00" to ISO that Postgres accepts
  const expires = new Date(expiresRaw).toISOString();

  try {
    const res = await fetch(`${API_BASE}/energy_listings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prosumer_id:      Number(CURRENT_USER_ID),
        energy_amount_kwh: amount,
        price_per_kwh:     price,
        status:           'Available',
        expires_at:       expires,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Insert failed');

    msg.innerText = 'Listing published successfully';
    msg.style.color = '#2ec4b6';
    document.getElementById('createListingForm').reset();
    await refreshListings();
  } catch (err) {
    console.error('[listings] Create failed:', err);
    msg.innerText = err.message;
    msg.style.color = '#e74c3c';
  }
}

// --- Delete listing ---
async function deleteListing(id) {
  if (!confirm('Delete listing #' + id + '?')) return;
  try {
    const res = await fetch(`${API_BASE}/energy_listings/${id}`, {
      method: 'DELETE',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    await refreshListings();
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}
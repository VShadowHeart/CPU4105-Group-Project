// js/wallet.js
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

  // ── Wallet card ──
  try {
    const w = await fetchTable('user_wallets');
    const i = {
      id:      findCol(w.columns, 'wallet_id', 'id'),
      user_id: findCol(w.columns, 'user_id', 'User ID'),
      bal:     findCol(w.columns, 'balance_amount', 'balance_tokens', 'Balance'),
      upd:     findCol(w.columns, 'updated_at', 'last_updated'),
    };

    const row = w.rows.find(r => Number(r[i.user_id]) === MY_ID);
    if (row) {
      renderWalletCard({
        id:  row[i.id],
        bal: Number(row[i.bal]),
        upd: row[i.upd],
      });
    } else {
      renderWalletEmpty();
    }
  } catch (e) { console.error('[wallet] Balance card failed:', e); }

  // ── Wire up Top up / Withdraw buttons ──
  const btnTopUp    = document.getElementById('btnTopUp');
  const btnWithdraw = document.getElementById('btnWithdraw');

  if (btnTopUp)    btnTopUp.addEventListener('click', handleTopUp);
  if (btnWithdraw) btnWithdraw.addEventListener('click', handleWithdraw);

  // Load transactions
  loadTransactions();
});

// ─── Auto-reload when user switcher changes ───
window.addEventListener('userChanged', () => {
  location.reload();
});

// ─────────────────────────────────────────────────────────────
// Wallet card rendering
// ─────────────────────────────────────────────────────────────
function renderWalletCard(wallet) {
    document.getElementById('walletBalanceBig').innerHTML =
    '&pound;' + fmtMoney(wallet.bal);;
  const usdEl = document.getElementById('walletUsdBig');
  if (usdEl) usdEl.innerText = '≈ ' + fmtMoney(wallet.bal) + ' FYT';
  document.getElementById('walletId').innerText = '#' + wallet.id;
  document.getElementById('walletUpdatedBig').innerText = cleanDate(wallet.upd);
}

function renderWalletEmpty() {
  document.getElementById('walletBalanceBig').innerHTML = '£0.00';
  const usdEl = document.getElementById('walletUsdBig');
  if (usdEl) usdEl.innerText = 'No wallet on file';
  document.getElementById('walletId').innerText = '—';
  document.getElementById('walletUpdatedBig').innerText = '—';
}

// ─────────────────────────────────────────────────────────────
// Top up handler
// ─────────────────────────────────────────────────────────────
async function handleTopUp() {
  const input = prompt('How much would you like to top up? (FYT)', '50');
  if (input === null) return;
  const amount = Number(input);
  if (!isFinite(amount) || amount <= 0) {
    alert('Please enter a valid positive amount.');
    return;
  }
  await walletAction('topup', amount, 'Top up');
}

// ─────────────────────────────────────────────────────────────
// Withdraw handler
// ─────────────────────────────────────────────────────────────
async function handleWithdraw() {
  const input = prompt('How much would you like to withdraw? (FYT)', '50');
  if (input === null) return;
  const amount = Number(input);
  if (!isFinite(amount) || amount <= 0) {
    alert('Please enter a valid positive amount.');
    return;
  }
  await walletAction('withdraw', amount, 'Withdrawal');
}

// ─────────────────────────────────────────────────────────────
// Shared: call the wallet API, refresh card
// ─────────────────────────────────────────────────────────────
async function walletAction(action, amount, label) {
  const btnTopUp    = document.getElementById('btnTopUp');
  const btnWithdraw = document.getElementById('btnWithdraw');
  if (btnTopUp)    btnTopUp.disabled    = true;
  if (btnWithdraw) btnWithdraw.disabled = true;

  try {
    const res = await fetch('/api/wallet/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: Number(CURRENT_USER_ID),
        amount:  Number(amount),
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Wallet update failed');

    // Update the card without a page reload
    renderWalletCard({
      id:  data.wallet_id,
      bal: Number(data.balance_amount),
      upd: data.updated_at,
    });

    alert(label + ' successful. New balance: ' +
      Number(data.balance_amount).toFixed(2) + ' FYT');
  } catch (e) {
    console.error('[wallet] ' + label + ' failed:', e);
    alert(e.message);
  } finally {
    if (btnTopUp)    btnTopUp.disabled    = false;
    if (btnWithdraw) btnWithdraw.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────
// Transactions table
// ─────────────────────────────────────────────────────────────
async function loadTransactions() {
  const filter   = document.getElementById('txFilter')?.value || 'all';
  const loading  = document.getElementById('txLoading');
  const table    = document.getElementById('txTable');
  if (!loading || !table) return;

  loading.style.display = 'block';
  loading.innerText = 'Loading transactions…';
  table.style.display = 'none';

  const norm = s => String(s).toLowerCase().replace(/[\s_]+/g, '');
  const findCol = (cols, ...names) => {
    for (const name of names) {
      const i = cols.findIndex(c => norm(c) === norm(name));
      if (i !== -1) return i;
    }
    return -1;
  };

  const MY_ID = Number(CURRENT_USER_ID);

  try {
    const [t, listings] = await Promise.all([
      fetchTable('transactions'),
      fetchTable('energy_listings'),
    ]);

    const lIdx = {
      id:      findCol(listings.columns, 'listing_id', 'id'),
      user_id: findCol(listings.columns, 'prosumer_id', 'user_id'),
    };
    const tIdx = {
      listing_id:  findCol(t.columns, 'listing_id'),
      consumer_id: findCol(t.columns, 'consumer_id', 'buyer_id'),
      kwh:         findCol(t.columns, 'kwh_transferred'),
      total:       findCol(t.columns, 'total_cost', 'total_price'),
      ts:          findCol(t.columns, 'trade_timestamp', 'timestamp'),
    };

    const myListingIds = new Set(
      listings.rows
        .filter(r => Number(r[lIdx.user_id]) === MY_ID)
        .map(r => Number(r[lIdx.id]))
    );

    let rows = t.rows;
    if (filter === 'bought') rows = rows.filter(r => Number(r[tIdx.consumer_id]) === MY_ID);
    if (filter === 'sold')   rows = rows.filter(r => myListingIds.has(Number(r[tIdx.listing_id])));

    const headersTr = document.getElementById('txHeaders');
    const tbody     = document.getElementById('txBody');
    headersTr.innerHTML = '';
    tbody.innerHTML = '';

    t.columns.forEach(col => {
      const th = document.createElement('th');
      th.innerText = col.replace(/_/g, ' ').toUpperCase();
      headersTr.appendChild(th);
    });

    if (!rows.length) {
      const emptyMsg =
        filter === 'bought' ? 'No purchases yet' :
        filter === 'sold'   ? 'No sales yet'     :
                              'No transactions';
      tbody.innerHTML = '<tr><td colspan="' + t.columns.length +
        '" class="loading small">' + emptyMsg + '</td></tr>';
    } else {
      rows.forEach(row => {
        const tr = document.createElement('tr');
        row.forEach((v, colIdx) => {
          const td = document.createElement('td');
          const colName = t.columns[colIdx];

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

    loading.style.display = 'none';
    table.style.display = 'table';
  } catch (e) {
    console.error('[wallet] Transactions failed:', e);
    loading.innerText = 'Could not load transactions.';
  }
}
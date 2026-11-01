// js/profile.js
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

  try {
    const u = await fetchTable('users');
    const i = {
      id:       findCol(u.columns, 'user_id', 'id'),
      username: findCol(u.columns, 'full_name', 'username', 'name'),
      email:    findCol(u.columns, 'email'),
      role:     findCol(u.columns, 'role_type', 'role'),
      created:  findCol(u.columns, 'created_at'),
    };

    const me = u.rows.find(r => Number(r[i.id]) === MY_ID);
    if (me) {
      const name = me[i.username] || 'Unknown';
      const init = (name.trim().split(/\s+/).map(p => p[0]).join('').slice(0, 2)).toUpperCase();

      document.getElementById('profAvatar').innerText = init;
      document.getElementById('profUsername').innerText = name;
      document.getElementById('profEmail').innerText    = me[i.email] || '—';
      document.getElementById('profRole').innerText     = me[i.role] || '—';
      document.getElementById('profCreated').innerText  = cleanDate(me[i.created]);
      document.getElementById('profId').innerText       = '#' + me[i.id];

      document.getElementById('setUsername').value = name;
      document.getElementById('setEmail').value    = me[i.email] || '';
      document.getElementById('setRole').value     = (me[i.role] || 'Prosumer');
    }

    // Count listings
    const l = await fetchTable('energy_listings');
    const iL = findCol(l.columns, 'prosumer_id', 'user_id');
    const mine = l.rows.filter(r => Number(r[iL]) === MY_ID);
    document.getElementById('profListings').innerText = mine.length;

    // Wallet balance
    const w = await fetchTable('user_wallets');
    const iW = {
      user_id: findCol(w.columns, 'user_id'),
      bal:     findCol(w.columns, 'balance_amount', 'balance_tokens'),
    };
    const wallet = w.rows.find(r => Number(r[iW.user_id]) === MY_ID);
    if (wallet) {
            document.getElementById('profBalance').innerText =
        '\u00A3' + fmtMoney(wallet[iW.bal]);
    } else {
      document.getElementById('profBalance').innerText = 'No wallet';
    }
  } catch (e) {
    console.error('[profile] Load failed:', e);
  }
});

// Auto-reload on user change
window.addEventListener('userChanged', () => {
  location.reload();
});

async function saveSettings(e) {
  e.preventDefault();
  const msg = document.getElementById('settingsMessage');

  const payload = {
    full_name: document.getElementById('setUsername').value,
    email:     document.getElementById('setEmail').value,
    role_type: document.getElementById('setRole').value,
  };

  try {
    const res = await fetch(`${API_BASE}/users/${Number(CURRENT_USER_ID)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Update failed');

    msg.innerText = 'Settings saved';
    msg.style.color = '#2ec4b6';
  } catch (err) {
    msg.innerText = err.message;
    msg.style.color = '#e74c3c';
  }
}
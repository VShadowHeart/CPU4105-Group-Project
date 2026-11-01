// js/user-switcher.js — user dropdown for the navbar
(function () {
  const STORAGE_KEY = 'flytech_current_user_id';

  function getStoredUserId() {
    const v = localStorage.getItem(STORAGE_KEY);
    return v ? Number(v) : null;
  }

  function setStoredUserId(id) {
    localStorage.setItem(STORAGE_KEY, String(id));
    window.dispatchEvent(new CustomEvent('userChanged', { detail: { userId: id } }));
  }

  function initials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const switcher  = document.getElementById('userSwitcher');
    const badgeBtn  = document.getElementById('userBadgeBtn');
    const menu      = document.getElementById('userMenu');
    const avatarEl  = document.getElementById('userAvatar');
    const nameEl    = document.getElementById('userName');
    const avatarMob = document.getElementById('userAvatarMobile');
    const nameMob   = document.getElementById('userNameMobile');

    if (!switcher || !badgeBtn || !menu) return;

    // Open / close
    badgeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = switcher.classList.toggle('open');
      badgeBtn.setAttribute('aria-expanded', String(open));
    });

    document.addEventListener('click', (e) => {
      if (!switcher.contains(e.target)) {
        switcher.classList.remove('open');
        badgeBtn.setAttribute('aria-expanded', 'false');
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        switcher.classList.remove('open');
        badgeBtn.setAttribute('aria-expanded', 'false');
      }
    });

    // Fetch users
    let users = [];
    try {
      const res = await fetch('/api/table-data/users');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();

      const norm = s => String(s).toLowerCase().replace(/[\s_]+/g, '');
      const findCol = (cols, ...names) => {
        for (const n of names) {
          const i = cols.findIndex(c => norm(c) === norm(n));
          if (i !== -1) return i;
        }
        return -1;
      };

      const idx = {
        id:    findCol(data.columns, 'user_id', 'id'),
        name:  findCol(data.columns, 'full_name', 'username', 'name'),
        email: findCol(data.columns, 'email'),
        role:  findCol(data.columns, 'role_type', 'role'),
      };

      users = data.rows.map(r => ({
        id:    r[idx.id],
        name:  r[idx.name],
        email: r[idx.email],
        role:  r[idx.role],
      }));
    } catch (e) {
      console.error('Failed to load users:', e);
      menu.innerHTML = '<div class="user-menu-loading">Could not load users</div>';
      return;
    }

    // Choose current user
    let currentId = getStoredUserId();
    if (!currentId || !users.find(u => u.id === currentId)) {
      currentId = users[0].id;
      setStoredUserId(currentId);
    }

    function renderMenu() {
      menu.innerHTML = '';
      users.forEach(u => {
        const row = document.createElement('div');
        row.className = 'user-menu-item' + (u.id === currentId ? ' selected' : '');
        row.setAttribute('role', 'option');
        row.innerHTML =
          '<div class="avatar">' + initials(u.name) + '</div>' +
          '<div class="info">' +
            '<div class="name">' + u.name + '</div>' +
            '<div class="role">' + (u.role || '') + ' · #' + u.id + '</div>' +
          '</div>' +
          '<div class="check">✓</div>';

        row.addEventListener('click', () => {
          currentId = u.id;
          setStoredUserId(currentId);
          updateBadge();
          renderMenu();
          switcher.classList.remove('open');
          badgeBtn.setAttribute('aria-expanded', 'false');
        });

        menu.appendChild(row);
      });
    }

    function updateBadge() {
      const u = users.find(x => x.id === currentId);
      if (!u) return;
      const init = initials(u.name);
      if (avatarEl)  avatarEl.textContent  = init;
      if (nameEl)    nameEl.textContent    = u.name;
      if (avatarMob) avatarMob.textContent = init;
      if (nameMob)   nameMob.textContent   = u.name;
    }

    renderMenu();
    updateBadge();

    window.addEventListener('userChanged', updateBadge);
  });
})();
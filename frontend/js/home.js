// js/home.js — Home page KPIs (live from backend)
window.addEventListener('DOMContentLoaded', async () => {

  // ── Fetch generation logs once, reuse for solar + carbon ──
  let totalKwh = 0;
  try {
    const g = await fetchTable('generation_logs');
    const iSolar = g.columns.indexOf('solar_generated_kwh');
    totalKwh = g.rows.reduce((s, r) => s + Number(r[iSolar] || 0), 0);

    const el = document.getElementById('homeTotalSolar');
    if (el) {
      el.innerHTML = `${totalKwh.toLocaleString(undefined, { maximumFractionDigits: 1 })} <small>kWh</small>`;
    }
  } catch (e) { console.error('home: solar failed', e); }

  // ── Active listings count (DB uses 'Available') ──
  try {
    const l = await fetchTable('energy_listings');
    const iStatus = l.columns.indexOf('status');
    const active = l.rows.filter(
      r => String(r[iStatus]).toLowerCase() === 'available'
    ).length;

    const el = document.getElementById('homeActiveListings');
    if (el) el.textContent = active;
  } catch (e) { console.error('home: listings failed', e); }

  // ── Carbon offset ──
  // Estimate: 0.000233 tons CO₂ avoided per kWh of solar (UK grid avg ~233 g/kWh)
  try {
    const tons = totalKwh * 0.000233;
    const el = document.getElementById('homeCarbonOffset');
    if (el) {
      el.innerHTML = `${tons.toLocaleString(undefined, { maximumFractionDigits: 2 })} <small>tons CO₂</small>`;
    }
  } catch (e) { console.error('home: carbon failed', e); }
});
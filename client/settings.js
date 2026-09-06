import { renderNav, api, me, setToken, toast } from './common.js';

renderNav('settings');
const msg = (t) => { document.querySelector('#s-msg').textContent = t; };

function readVol(key) { try { const v = localStorage.getItem(key); const n = v == null ? 100 : Number(v); return Number.isFinite(n) ? n : 100; } catch { return 100; } }

async function main() {
  const m = await me();
  if (!m.user) { msg('Log in to save settings to your account (local volume still works as a guest).'); }
  else {
    const prefs = await api('/api/me/prefs').then((r) => r.prefs).catch(() => ({}));
    if ('soundVolume' in prefs) localStorage.setItem('ps_vol_master', String(prefs.soundVolume));
    if ('sfxVolume' in prefs) localStorage.setItem('ps_vol_sfx', String(prefs.sfxVolume));
  }
  document.querySelector('#s-master').value = readVol('ps_vol_master');
  document.querySelector('#s-sfx').value = readVol('ps_vol_sfx');
}
main();

document.querySelector('#s-save').addEventListener('click', async () => {
  const master = Number(document.querySelector('#s-master').value);
  const sfxv = Number(document.querySelector('#s-sfx').value);
  localStorage.setItem('ps_vol_master', String(master));
  localStorage.setItem('ps_vol_sfx', String(sfxv));
  const m = await me();
  if (m.user) {
    try { await api('/api/me/prefs', { method: 'PUT', body: { soundVolume: master, sfxVolume: sfxv } }); msg('Saved.'); }
    catch (e) { msg(e.message); }
  } else msg('Saved locally.');
});

document.querySelector('#p-save').addEventListener('click', async () => {
  try {
    await api('/api/me/password', { method: 'POST', body: { current: document.querySelector('#p-cur').value, next: document.querySelector('#p-new').value } });
    msg('Password updated.');
  } catch (e) { msg(e.message); }
});

document.querySelector('#s-export').addEventListener('click', async () => {
  try {
    const data = await api('/api/me/export');
    toast('Export ready', 'Check the browser console for your data.');
    console.log('Pacific Skies data export', data);
  } catch (e) { msg(e.message); }
});

document.querySelector('#s-delete').addEventListener('click', async () => {
  const password = prompt('Type your password to permanently delete your account:');
  if (!password) return;
  try { await api('/api/me', { method: 'DELETE', body: { password } }); setToken(null); location.href = '/'; }
  catch (e) { msg(e.message); }
});

import { renderNav, api, esc } from './common.js';

renderNav('admin');

async function main() {
  try {
    const ov = await api('/api/admin/overview');
    document.querySelector('#overview').innerHTML = `<p>Users: ${ov.users} &nbsp; Runs: ${ov.runs} &nbsp; Live rooms: ${ov.rooms.length}</p>`;
    document.querySelector('#rooms tbody').innerHTML = ov.rooms.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.state}</td><td>${r.playerCount}/${r.maxPlayers}</td></tr>`).join('');
    const err = await api('/api/admin/errors');
    document.querySelector('#errors tbody').innerHTML = err.errors.slice(0, 30).map((e) => `<tr><td>${e.source}</td><td>${esc(e.message)}</td></tr>`).join('');
  } catch (e) {
    document.querySelector('#overview').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
}
main();

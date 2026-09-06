import { renderNav, api, me, esc, fmtTime, ago } from './common.js';

renderNav('dashboard');

const STAT_LABELS = {
  kills: 'Total kills', red_formations: 'Red formations broken', bosses: 'Bosses destroyed',
  untouched_stages: 'Stages cleared untouched', coop_stage_clears: 'Co-op stage clears',
  continues: 'Continues used', deepest_stage_reached: 'Deepest stage reached (stages cleared)',
  stages_cleared_run_max: 'Best single-run stage streak', loop_dodges: 'Bullets dodged looping',
};

async function main() {
  const m = await me();
  if (!m.user) {
    document.querySelector('#guest-msg').textContent = 'Log in to track your stats and achievements across runs.';
  } else {
    const statsRows = Object.entries(m.stats || {}).map(([k, v]) => `<tr><td>${STAT_LABELS[k] || k}</td><td>${v}</td></tr>`).join('');
    document.querySelector('#stats-table').innerHTML = statsRows || '<tr><td class="muted">No runs yet.</td></tr>';

    document.querySelector('#ach-list').innerHTML = (m.achievements || []).map((a) => `
      <div class="ach ${a.unlocked ? '' : 'locked'}">
        <div>
          <div class="name">${esc(a.name)}</div>
          <div class="desc">${esc(a.desc)} (${a.progress}/${a.threshold})</div>
        </div>
      </div>`).join('');

    document.querySelector('#runs-table tbody').innerHTML = (m.runs || []).map((r) => `
      <tr><td>${r.score.toLocaleString()}</td><td>${r.stage_reached}</td><td>${r.kills}</td><td>${fmtTime(r.seconds)}</td><td>${r.mode}</td></tr>
    `).join('') || '<tr><td class="muted">No runs yet.</td></tr>';
  }

  const lb = await api('/api/leaderboard').catch(() => ({ scores: [] }));
  document.querySelector('#lb-table tbody').innerHTML = (lb.scores || []).map((r, i) => `
    <tr><td>${i + 1}</td><td>${esc(r.username)}</td><td>${r.score.toLocaleString()}</td><td>${r.stage_reached} <span class="muted">(${ago(r.ended_at)})</span></td></tr>
  `).join('') || '<tr><td class="muted">No scores yet.</td></tr>';
}
main();

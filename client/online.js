// Stormglass online: the room socket and the room-lobby card. The server owns the match; this file
// sends a join and Actions, and hands every server message to `on[msg.t]` for main.js to show.
import { token } from './common.js';

const RESUME_KEY = 'stormglass.resume';
const NAME_KEY = 'stormglass.callsign';

export const TYPE_ABOUT = {
  coop: 'Two kites, one score. Fly it alone if nobody joins.',
  race: 'Two kites, two scores: the higher one wins. Needs two players.',
  wingman: 'You and an AI kite, one score.',
  rival: 'You against an AI kite on the same stages.',
  watch: 'Two AI kites fly while you watch.',
};

const $ = (s) => document.querySelector(s);

function readResume() { try { return JSON.parse(sessionStorage.getItem(RESUME_KEY)) || null; } catch { return null; } }
function writeResume(v) { try { v ? sessionStorage.setItem(RESUME_KEY, JSON.stringify(v)) : sessionStorage.removeItem(RESUME_KEY); } catch { /* not remembered */ } }
export function callsign() { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } }
export function setCallsign(v) { try { localStorage.setItem(NAME_KEY, v); } catch { /* not remembered */ } }

/** One connection to the room server. `on` maps a message type to a handler. */
export function createOnline(on) {
  let ws = null;
  let me = null;      // this player's pid in the room
  let room = null;    // the latest room info
  let leaving = false;
  let retried = false;

  function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

  function open(join) {
    leaving = false;
    if (ws) { ws.onclose = null; ws.close(); }
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => send({ ...join, t: 'join', token: token() });
    ws.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      if (m.t === 'joined') {
        me = m.pid;
        retried = false;
        writeResume({ roomId: m.room.id, pid: m.pid, token: m.resumeToken });
      }
      if (m.room) room = m.room;
      on[m.t]?.(m);
    };
    ws.onclose = () => {
      if (leaving || !room) return;
      const saved = readResume();
      if (!retried && saved?.roomId === room.id) { // one quiet retry onto the same seat
        retried = true;
        setTimeout(() => open({ roomId: saved.roomId, resumePid: saved.pid, resume: saved.token }), 800);
        return;
      }
      room = null;
      on.lost?.();
    };
  }

  return {
    get me() { return me; },
    get room() { return room; },
    get isHost() { return !!room && room.players[0]?.pid === me; },
    quick: (name) => open({ name }),
    create: (name) => open({ name, create: true }),
    /** Join a room by code, resuming this tab's seat in it if it held one. */
    join(name, roomId) {
      const saved = readResume();
      open(saved?.roomId === roomId ? { name, roomId, resumePid: saved.pid, resume: saved.token } : { name, roomId });
    },
    send,
    leave() {
      leaving = true;
      send({ t: 'leave' });
      writeResume(null);
      room = null;
      ws?.close();
    },
  };
}

/** Paint the room card from the latest room info. */
export function paintRoom(net) {
  const r = net.room;
  if (!r) return;
  const host = net.isHost;
  $('#rs-name').textContent = r.name;
  $('#rs-id').textContent = r.id;
  $('#rs-link').href = `${location.origin}/?room=${r.id}`;
  const list = $('#rs-roster');
  list.replaceChildren(...r.players.map((p) => {
    const li = document.createElement('li');
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = p.name + (p.pid === net.me ? ' (you)' : '');
    const tag = document.createElement('span');
    tag.className = `tag ${p.ready ? 'ready' : ''}`;
    tag.textContent = [p.host && 'host', p.away ? 'away' : p.ready ? 'ready' : 'not ready'].filter(Boolean).join(' · ');
    li.append(who, tag);
    if (host && p.pid !== net.me) {
      const kick = document.createElement('button');
      kick.type = 'button';
      kick.textContent = 'Kick';
      kick.addEventListener('click', () => net.send({ t: 'kick', pid: p.pid }));
      li.append(kick);
    }
    return li;
  }));
  $('#rs-type').value = r.type;
  $('#rs-level').value = r.level;
  $('#rs-type').disabled = $('#rs-level').disabled = !host;
  $('#rs-about').textContent = TYPE_ABOUT[r.type] + (host ? '' : ' The host picks the match.');
  $('#rs-start').hidden = !host;
  const mine = r.players.find((p) => p.pid === net.me);
  $('#rs-ready').textContent = mine?.ready ? 'Not ready' : 'Ready';
}

export function addChat(name, text) {
  const li = document.createElement('li');
  const b = document.createElement('b');
  b.textContent = `${name}: `;
  li.append(b, text);
  const log = $('#rs-chatlog');
  log.append(li);
  while (log.children.length > 30) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

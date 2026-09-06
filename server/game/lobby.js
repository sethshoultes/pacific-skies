// Room registry: create/find/list rooms, quick play (join an open public room or make one).
import crypto from 'node:crypto';
import { Room } from './room.js';

const ADJ = ['Crimson', 'Azure', 'Golden', 'Steel', 'Coral', 'Storm', 'Iron', 'Pacific'];
const NOUN = ['Squadron', 'Wing', 'Flight', 'Formation', 'Patrol', 'Sortie', 'Ace', 'Skies'];

export class Lobby {
  // onRoomStart(room, hostPid), if given, fires for every room the moment it actually starts --
  // both an explicit host start and the ready-countdown auto-start -- so callers (telemetry) can
  // observe every game start, not just the ones sent as an explicit WS 'start' message.
  constructor({ onRoomStart } = {}) {
    this.rooms = new Map();
    this.onRoomStart = onRoomStart || (() => {});
  }

  list() { return [...this.rooms.values()].filter((r) => r.isPublic && r.state !== 'over').map((r) => r.info()); }

  create({ name, isPublic = true } = {}) {
    const id = crypto.randomBytes(3).toString('hex');
    const roomName = String(name || `${ADJ[Math.floor(Math.random() * ADJ.length)]} ${NOUN[Math.floor(Math.random() * NOUN.length)]}`).slice(0, 24);
    const room = new Room({
      id, name: roomName, seed: id, isPublic,
      onEmpty: (r) => this.rooms.delete(r.id),
      onStart: (hostPid) => this.onRoomStart(room, hostPid),
    });
    this.rooms.set(id, room);
    return room;
  }

  get(id) { return this.rooms.get(id) || null; }

  /** Quick play: join the fullest public room still in its lobby (not yet started), or make one. */
  quick() {
    const candidates = [...this.rooms.values()].filter((r) => r.isPublic && !r.full && r.state === 'lobby');
    candidates.sort((a, b) => b.playerCount - a.playerCount);
    return candidates[0] || this.create({});
  }
}

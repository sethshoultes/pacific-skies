// Room registry: create/find/list rooms, quick play (join an open public room or make one).
import crypto from 'node:crypto';
import { Room } from './room.js';

const ADJ = ['Amber', 'Cobalt', 'Gilded', 'Silver', 'Coral', 'Storm', 'Copper', 'Violet'];
const NOUN = ['Kites', 'Couriers', 'Draft', 'Gale', 'Squall', 'Front', 'Spire', 'Updraft'];
// Public caps (arcade rule: a public endpoint that creates things needs a ceiling).
export const MAX_ROOMS = 100;
export const MAX_LISTED = 50;
export const EMPTY_ROOM_MS = 60_000;

export class Lobby {
  // onRoomStart(room, hostPid), if given, fires for every room the moment it actually starts --
  // both an explicit host start and the ready-countdown auto-start -- so callers (telemetry) can
  // observe every game start, not just the ones sent as an explicit WS 'start' message.
  // stageCount and tickMs pass through to every room (the defaults are the real game's).
  constructor({ onRoomStart, stageCount, tickMs } = {}) {
    this.rooms = new Map();
    this.onRoomStart = onRoomStart || (() => {});
    this.roomOptions = { stageCount, tickMs };
  }

  list() { return [...this.rooms.values()].filter((r) => r.isPublic && r.state !== 'over').slice(0, MAX_LISTED).map((r) => r.publicInfo()); }

  create({ name, isPublic = true } = {}) {
    if (this.rooms.size >= MAX_ROOMS) throw new Error('Every room is busy; try again in a minute');
    const id = crypto.randomBytes(3).toString('hex');
    const roomName = String(name || `${ADJ[Math.floor(Math.random() * ADJ.length)]} ${NOUN[Math.floor(Math.random() * NOUN.length)]}`).slice(0, 24);
    const room = new Room({
      id, name: roomName, seed: id, isPublic, ...this.roomOptions,
      onEmpty: (r) => this.rooms.delete(r.id),
      onStart: (hostPid) => this.onRoomStart(room, hostPid),
    });
    this.rooms.set(id, room);
    // A room nobody joins is closed, so held-open rooms cannot fill MAX_ROOMS.
    setTimeout(() => { if (room.clients.size === 0 && this.rooms.get(id) === room) room.close(); }, EMPTY_ROOM_MS).unref();
    return room;
  }

  get(id) { return this.rooms.get(id) || null; }

  /** Quick play: the fullest public room still in its lobby (not yet started), or null. */
  open() {
    const candidates = [...this.rooms.values()].filter((r) => r.isPublic && !r.full && r.state === 'lobby');
    candidates.sort((a, b) => b.playerCount - a.playerCount);
    return candidates[0] || null;
  }
}

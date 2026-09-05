// Room registry: create/find/list rooms, quick play (join an open public room or make one).
import crypto from 'node:crypto';
import { Room } from './room.js';

const ADJ = ['Crimson', 'Azure', 'Golden', 'Steel', 'Coral', 'Storm', 'Iron', 'Pacific'];
const NOUN = ['Squadron', 'Wing', 'Flight', 'Formation', 'Patrol', 'Sortie', 'Ace', 'Skies'];

export class Lobby {
  constructor() { this.rooms = new Map(); }

  list() { return [...this.rooms.values()].filter((r) => r.isPublic).map((r) => r.info()); }

  create({ name, isPublic = true } = {}) {
    const id = crypto.randomBytes(3).toString('hex');
    const roomName = String(name || `${ADJ[Math.floor(Math.random() * ADJ.length)]} ${NOUN[Math.floor(Math.random() * NOUN.length)]}`).slice(0, 24);
    const room = new Room({ id, name: roomName, seed: id, isPublic, onEmpty: (r) => this.rooms.delete(r.id) });
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

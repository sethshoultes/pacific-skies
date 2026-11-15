// Resolve the real client IP for rate limiting and per-caller scoping.
//
// In production the path is Cloudflare -> nginx (sets X-Real-IP to the address it saw) -> this app on
// 127.0.0.1, so req.socket.remoteAddress is the same for every visitor. The origin also answers
// directly, so a header is only believed when the hop that set it can be trusted:
//   - the TCP peer must be loopback (nginx), and TRUST_PROXY must be set;
//   - X-Real-IP is then the address nginx saw;
//   - CF-Connecting-IP is believed only when that address is a Cloudflare edge. A client that
//     reaches the origin directly is known by its own X-Real-IP, whatever CF-Connecting-IP it sends.
import net from 'node:net';

const TRUST_PROXY = ['1', 'true', 'yes'].includes(String(process.env.TRUST_PROXY || '').toLowerCase());

// https://www.cloudflare.com/ips-v4 and /ips-v6, fetched 2026-11-15.
const CLOUDFLARE = new net.BlockList();
for (const cidr of [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
]) { const [a, p] = cidr.split('/'); CLOUDFLARE.addSubnet(a, Number(p), 'ipv4'); }
for (const cidr of [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
]) { const [a, p] = cidr.split('/'); CLOUDFLARE.addSubnet(a, Number(p), 'ipv6'); }

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function ip(value) {
  const v = String(value || '').trim();
  return net.isIP(v) ? v : null;
}
function isCloudflare(addr) {
  return CLOUDFLARE.check(addr, net.isIPv6(addr) ? 'ipv6' : 'ipv4');
}

/** @param {import('node:http').IncomingMessage} req */
export function clientIp(req, { trustProxy = TRUST_PROXY } = {}) {
  const peer = req.socket?.remoteAddress || 'x';
  if (!trustProxy || !LOOPBACK.has(peer)) return peer;
  const h = req.headers || {};
  const seen = ip(h['x-real-ip']);
  if (!seen) return peer;
  if (isCloudflare(seen)) return ip(h['cf-connecting-ip']) || seen;
  return seen;
}

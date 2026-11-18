/**
 * Telling an address inside this PC or its networks from a public one.
 *
 * For anything that fetches an address somebody else chose: a calendar link a
 * person pasted, a page Suwayomi asks FlareSolverr for. Such a request must
 * never reach this PC, the home network, the tailnet or link-local, or a
 * pasted link becomes a way to read what only this machine can see.
 *
 * One copy, on purpose. The calendar and manga packages each had their own,
 * identical in the addresses and already different in the names: one refused
 * `.lan` and `.home.arpa`, the other did not.
 *
 * **Check the address a name resolves to, at the moment of connecting.** A
 * name checked before the request can answer one address to the check and
 * another to the fetch. Both callers look names up themselves and pass every
 * address through `isPrivateAddress`; `isPrivateHostName` only saves the
 * lookup for names that are private by their spelling.
 */
import { isIP } from 'node:net';

/** Whether an address is somewhere a request from here must never be sent. Anything that is not an IP address counts as private. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return (
      a === 0 || // "this network"
      a === 10 || // private
      a === 127 || // loopback
      (a === 169 && b === 254) || // link-local
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) || // private
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT, which is where Tailscale lives
      a >= 224 // multicast and reserved
    );
  }
  if (version === 6) {
    const s = address.toLowerCase();
    // An IPv4 address written as IPv6 is judged as the IPv4 address it is.
    if (s.startsWith('::ffff:')) return isPrivateAddress(s.slice(7));
    return (
      s === '::' ||
      s === '::1' || // loopback
      s.startsWith('fc') || // unique local
      s.startsWith('fd') ||
      s.startsWith('fe8') || // link-local, fe80::/10
      s.startsWith('fe9') ||
      s.startsWith('fea') ||
      s.startsWith('feb') ||
      s.startsWith('ff') // multicast
    );
  }
  return true;
}

/** Whether a host name is private by its spelling alone: localhost, and the endings home networks and the tailnet use. */
export function isPrivateHostName(host: string): boolean {
  return host.toLowerCase() === 'localhost' || /\.(localhost|local|internal|ts\.net|lan|home\.arpa)$/i.test(host);
}

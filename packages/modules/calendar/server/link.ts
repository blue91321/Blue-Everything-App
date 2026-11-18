/**
 * Fetching a calendar link: the secret iCal address Google, Outlook and
 * Apple give a calendar ("Secret address in iCal format"), read-only.
 *
 * A link is an address somebody pastes, fetched by the server on its own, so
 * the fetch is held to what a calendar link is:
 *
 * - **https only.** `webcal://` is the same address over https, so it is
 *   rewritten; plain http is refused, since the address is a secret and a
 *   password in a link is refused too.
 * - **Never inside.** The name is looked up as the connection is made (the
 *   `lookup` hook below, not a check before it, so a name cannot answer one
 *   address to the check and another to the fetch), and this PC, the home
 *   network, the tailnet and link-local are refused: a link must not become a
 *   way for a paste to make this server ask things of the machines around it.
 *   The rule is core's (`isPrivateAddress`), which the manga package's
 *   FlareSolverr door uses too.
 * - **Bounded.** Three redirects, each checked again; 20 seconds; 10MB; and
 *   the answer must be a calendar.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isPrivateAddress, isPrivateHostName } from '@everything/server/module-api';
import { looksLikeIcs } from './ics.js';

export const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

export class LinkRefused extends Error {}

/** A pasted link as the https address to fetch, or why it cannot be one. */
export function linkAddress(pasted: string): URL {
  let url: URL;
  try {
    url = new URL(pasted.trim().replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    throw new LinkRefused('That is not a web address.');
  }
  if (url.protocol === 'http:') throw new LinkRefused('Only https links: a calendar link is a secret, and http would send it in the clear.');
  if (url.protocol !== 'https:') throw new LinkRefused('Only https (or webcal) calendar links.');
  if (url.username || url.password) throw new LinkRefused('A link with a password in it is not accepted.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateHostName(host) || (isIP(host) && isPrivateAddress(host))) {
    throw new LinkRefused('That address is on this PC or your own network, not a calendar service.');
  }
  return url;
}

/** A link with its secret part hidden, for the screen: the host and enough of the path to tell two apart. */
export function maskLink(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 18 ? `${u.pathname.slice(0, 10)}…${u.pathname.slice(-6)}` : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return 'a link';
  }
}

/** The lookup every connection makes: refuses the moment a name answers with an address inside. */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '', 0);
    const list = addresses as unknown as LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || !list.length) return callback(new LinkRefused('That link points inside this network, not to a calendar service.'), '', 0);
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

function once(url: URL): Promise<{ status: number; location: string | null; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: { 'user-agent': 'BlueEverything-Calendar/1', accept: 'text/calendar, */*;q=0.5', 'accept-encoding': 'identity' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, location: res.headers.location ?? null, body: '' });
          return;
        }
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
          res.destroy();
          reject(new Error(`The calendar service answered compressed (${res.headers['content-encoding']}), which was not asked for.`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            res.destroy();
            reject(new Error('The calendar is over 10MB, which is more than a calendar link should ever be.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status, location: null, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('The calendar service took more than 20 seconds to answer.')));
    req.on('error', reject);
    req.end();
  });
}

/** Fetch a link's calendar text, following up to three redirects, each held to the same rules. */
export async function fetchLink(pasted: string): Promise<string> {
  let url = linkAddress(pasted);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const answer = await once(url);
    if (answer.status >= 300 && answer.status < 400) {
      if (!answer.location) throw new Error(`The calendar service answered ${answer.status} with nowhere to go.`);
      url = linkAddress(new URL(answer.location, url).toString());
      continue;
    }
    if (answer.status === 401 || answer.status === 403) throw new Error(`The calendar service refused the link (${answer.status}). It may have been reset; copy it again.`);
    if (answer.status === 404) throw new Error('The calendar service has no calendar at that link (404). It may have been reset; copy it again.');
    if (answer.status !== 200) throw new Error(`The calendar service answered ${answer.status}.`);
    if (!looksLikeIcs(answer.body)) throw new Error('That link answered with a web page, not a calendar. Use the "secret address in iCal format".');
    return answer.body;
  }
  throw new Error('The link redirected more than three times.');
}

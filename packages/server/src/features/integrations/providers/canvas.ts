/**
 * Canvas: coursework with a deadline, turned into tasks.
 *
 * The only provider here whose output lands in *core* rather than on a screen
 * this feature owns. That is the entire point: the nudge engine is the app, and
 * a deadline it cannot see is a deadline it cannot hold until you are between
 * things. Everything else in this module is a list you go and look at.
 *
 * **Read from the planner, not from each course's assignment list.** Both
 * exist. `/api/v1/courses` then `/api/v1/courses/:id/assignments` is the
 * obvious route and is worse in three ways: it is one request per course rather
 * than one for everything, it returns assignments from courses you finished last
 * year unless every one of them is filtered by term, and it says nothing about
 * whether you handed anything in. `/api/v1/planner/items` is what the Canvas
 * dashboard itself draws, which means it has already answered "which of these
 * are current" the way the student expects — and it carries the submission
 * state, which is what lets handing something in tick it off here.
 */
import { canvasHostInput, type ProviderId } from '@everything/shared/integrations';
import { getAccount, syncTasksFromService, type IncomingTask, type TaskSyncResult } from '../store.js';

const PROVIDER: ProviderId = 'canvas';

/**
 * How far back and forward to look.
 *
 * Backwards at all because something a fortnight overdue is still something you
 * have to do, and a window starting at "now" would silently drop exactly the
 * work most worth nudging about. Not further, because a term's worth of finished
 * assignments is a hundred rows that would each need a decision.
 *
 * Forwards far enough to cover a term, since a task with a date in six weeks is
 * not noise — the Dashboard buckets it under *Coming up* and the sweep leaves it
 * alone until the day.
 */
const LOOK_BACK_MS = 14 * 24 * 60 * 60_000;
const LOOK_AHEAD_MS = 120 * 24 * 60 * 60_000;

/**
 * Which planner entries are coursework.
 *
 * `planner_note` is deliberately absent even though it is the closest thing
 * Canvas has to a to-do: it is a note *you* wrote in Canvas, and importing those
 * would make two apps quietly compete over the same list. `calendar_event` is
 * absent for the same kind of reason — a lecture at 9am is a fact about your
 * timetable, not something with an outcome, and the nudge engine has nothing
 * useful to do with one.
 */
const COURSEWORK = new Set(['assignment', 'quiz', 'discussion_topic', 'sub_assignment']);

/** A page's worth of `/planner/items`, with only the fields actually read. */
export interface PlannerItem {
  plannable_id?: number | string;
  plannable_type?: string;
  plannable_date?: string;
  context_name?: string;
  html_url?: string;
  plannable?: { title?: string; due_at?: string | null; todo_date?: string | null };
  planner_override?: { marked_complete?: boolean; dismissed?: boolean } | null;
  /**
   * `false` when there is nothing to hand in — an ungraded discussion, say —
   * rather than an object with everything unset. Both mean "not submitted", and
   * the falsy check below covers them together.
   */
  submissions?: false | { submitted?: boolean; excused?: boolean; graded?: boolean };
}

/** Host and token, or a sentence saying which half is missing. */
async function connection(): Promise<{ base: string; token: string }> {
  const account = await getAccount(PROVIDER);
  if (!account?.baseUrl || !account.apiKey) {
    throw new Error('Canvas is not connected — its address and access token are set on the Services tab');
  }
  return { base: account.baseUrl, token: account.apiKey };
}

/**
 * One request, with the errors that are worth naming named.
 *
 * A 401 here has exactly one cause worth checking and it is not obvious from
 * the word "Unauthorized": tokens are revoked when you change your Canvas
 * password, and by whoever administers your school's Canvas. Passing the bare
 * status through sends you looking at the address instead.
 */
async function canvasFetch(url: string, base: string, token: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      // A school Canvas behind a VPN answers by hanging rather than refusing,
      // and a sync that never returns holds the Services screen open forever.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    throw Object.assign(
      new Error(
        `Could not reach ${base} — check the address, and whether this Canvas needs you to be on the ` +
          `school network. (${cause instanceof Error ? cause.message : 'network error'})`
      ),
      { statusCode: 400 }
    );
  }

  if (response.status === 401 || response.status === 403) {
    // 400 rather than 500: a rejected token is something that was typed, not
    // something that went wrong here — and a 500 has Fastify log it at error
    // level, which fills the log with entries about an expired credential.
    throw Object.assign(
      new Error(
        'Canvas rejected the access token. They are revoked when you change your password, and they ' +
          'expire if an expiry date was set — make a new one under Account → Settings.'
      ),
      { statusCode: 400 }
    );
  }

  if (response.status === 404) {
    throw Object.assign(
      new Error(`${base} answered, but has no Canvas API at it. Check the address is your school's Canvas.`),
      { statusCode: 400 }
    );
  }

  if (!response.ok) throw new Error(`Canvas returned ${response.status} for ${new URL(url).pathname}`);
  return response;
}

/** The same request, addressed by API path rather than by a whole URL. */
function canvasGet(
  base: string,
  token: string,
  path: string,
  params: Record<string, string> = {}
): Promise<Response> {
  const query = new URLSearchParams(params);
  return canvasFetch(`${base}/api/v1${path}${query.toString() ? `?${query}` : ''}`, base, token);
}

/**
 * The next page, out of the `Link` header.
 *
 * Canvas paginates by header rather than by a cursor in the body, so there is
 * nothing in the JSON to follow. The header is a comma-separated list of
 * `<url>; rel="name"` and the names are stable — `current`, `next`, `first`,
 * `last` — so this only has to find one of them.
 */
export function nextPage(header: string | null, base: string): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (!match) continue;

    /*
     * Followed only if it stays on the same host.
     *
     * This is a URL taken out of a response header and then sent a bearer token
     * that is the *whole* Canvas account — there is no read-only kind to ask
     * for. Anything that could put a different origin in that header would be
     * handed the credential, so the one check worth having is that it is the
     * same Canvas we were already talking to.
     */
    try {
      if (new URL(match[1]).origin === new URL(base).origin) return match[1];
    } catch {
      // An unparseable link is the end of the list, not a reason to fail a sync
      // that has already collected everything up to here.
    }
    return null;
  }
  return null;
}

/** Who the token belongs to. Also proves the host and the token before storing either. */
export async function verify(host: string, token: string): Promise<{ id: string; name: string; base: string }> {
  const base = canvasHostInput(host);
  if (!base) {
    // Said separately, because "that is not an address" is unhelpful and
    // slightly insulting when the address is fine and the scheme is the problem.
    const message = /^http:\/\//i.test(host.trim())
      ? `${host.trim()} is http, and this will only talk to a Canvas over https. A Canvas token is ` +
        'your whole account, so it is not going over the wire in the clear — try https, or drop the ' +
        'scheme entirely and one will be added.'
      : `"${host}" does not look like a Canvas address. It is the host in your browser's address bar ` +
        '— something like canvas.yourschool.edu.';
    throw Object.assign(new Error(message), { statusCode: 400 });
  }

  const response = await canvasGet(base, token, '/users/self');
  const me = (await response.json()) as { id?: number | string; name?: string; short_name?: string };
  if (me.id === undefined) throw Object.assign(new Error('Canvas answered without an account'), { statusCode: 400 });

  return { id: String(me.id), name: me.name ?? me.short_name ?? 'Canvas account', base };
}

/**
 * One planner entry, as something with a deadline — or `null` if it is not one.
 *
 * Pure, and exported, because everything that can silently go wrong here goes
 * wrong *quietly*: a filter that drops the wrong kind, an id that collides, a
 * relative URL stored as-is. None of those throw, and all of them present as
 * "Canvas only imported some of it". `integrations-check` drives this with
 * planner entries written out by hand — which is not a mock of Canvas, it is
 * this app's own rules about a documented shape.
 */
export function toTask(item: PlannerItem, base: string): IncomingTask | null {
  const type = item.plannable_type ?? '';
  if (!COURSEWORK.has(type)) return null;
  if (item.plannable_id === undefined) return null;
  // Dismissed in Canvas means you have told *Canvas* to stop showing it, which is
  // the same request made of a different screen. Honouring it keeps the two
  // agreeing rather than making this app the one that will not let go.
  if (item.planner_override?.dismissed) return null;

  const when = item.plannable?.due_at ?? item.plannable?.todo_date ?? item.plannable_date;
  const dueAt = when ? Date.parse(when) : Number.NaN;
  // Undated coursework exists — "read chapter 4, sometime". It is real work and it
  // is not a deadline, and something with no date is not something the nudge
  // engine can hold for a good moment, which is the only reason it is here.
  if (!Number.isFinite(dueAt)) return null;

  const title = item.plannable?.title?.trim();
  if (!title) return null;

  const submission = item.submissions;
  const done =
    item.planner_override?.marked_complete === true ||
    (typeof submission === 'object' &&
      submission !== null &&
      (submission.submitted === true || submission.excused === true));

  return {
    // Prefixed with the type, because `plannable_id` is only unique within one:
    // assignment 91 and quiz 91 are different things and would otherwise be the
    // same row, with the second silently never becoming a task.
    externalId: `${type}:${item.plannable_id}`,
    title,
    context: item.context_name?.trim() || null,
    dueAt,
    // `html_url` is a path. Joining it against the stored host here rather than
    // keeping the path means the link is a link, and keeps working if the school
    // ever moves host.
    url: item.html_url ? new URL(item.html_url, base).toString() : null,
    done,
  };
}

/**
 * Everything with a deadline, as tasks.
 *
 * The mapping is deliberately thin — the interesting decisions (what happens to
 * a task you deleted, whose title wins, when a deadline is carried across) all
 * live in `syncTasksFromService`, so a second school platform gets them for free
 * rather than getting a second opinion about them.
 */
export async function syncAssignments(now = Date.now()): Promise<TaskSyncResult & { seen: number }> {
  const { base, token } = await connection();

  const items: PlannerItem[] = [];
  let url: string | null = null;
  // Bounded rather than "until there is no next page". A misread header would
  // otherwise loop against somebody's school server forever; twenty pages at
  // fifty each is two months of coursework and nobody has that.
  for (let page = 0; page < 20; page += 1) {
    const response: Response = url
      ? await canvasFetch(url, base, token)
      : await canvasGet(base, token, '/planner/items', {
          start_date: new Date(now - LOOK_BACK_MS).toISOString(),
          end_date: new Date(now + LOOK_AHEAD_MS).toISOString(),
          per_page: '50',
        });

    items.push(...((await response.json()) as PlannerItem[]));

    url = nextPage(response.headers.get('link'), base);
    if (!url) break;
  }

  const incoming = items.map((item) => toTask(item, base)).filter((t): t is IncomingTask => t !== null);

  const result = await syncTasksFromService(PROVIDER, incoming, now);
  return { ...result, seen: incoming.length };
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openDb, upsertMember, createTeam, hashToken, getOrCreateDefaultTeamId, makeTeamScope,
  type Db, type TeamScope,
} from './db.js';
import { createShare, getShare, markStale } from './shares.js';
import { getUnread, UNREAD_LIMIT } from './unread.js';

let db: Db;
let scope: TeamScope;
const T0 = '2026-08-01T00:00:00.000Z';
const NOW = '2026-08-29T00:00:00.000Z';

beforeEach(() => {
  db = openDb(':memory:');
  scope = makeTeamScope(db, getOrCreateDefaultTeamId(db));
  upsertMember(scope, 'adnan@team.com', 'Adnan', T0);
  upsertMember(scope, 'priya@team.com', 'Priya', T0);
  // Sam is a member here because the recipient tests below address him, and
  // a share can only be addressed to someone the roster knows (see
  // resolveRecipients in shares.ts: an unknown address is an error, never a
  // share quietly delivered to nobody). Nothing else in this file depends on
  // the team's size, and every assertion below is unchanged by his presence.
  upsertMember(scope, 'sam@team.com', 'Sam', T0);
});
afterEach(() => { db.close(); });

function ack(shareId: string, email: string, status: 'viewed' | 'dismissed') {
  db.prepare(
    `INSERT INTO receipts (team_id, share_id, member_email, status, at) VALUES (?, ?, ?, ?, ?)`,
  ).run(scope.teamId, shareId, email, status, NOW);
}

describe('getUnread', () => {
  it('shows a teammate share to the recipient', () => {
    createShare(scope, 'adnan@team.com', { what: 'hello', priority: 'fyi' }, NOW);
    const d = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(d.total).toBe(1);
    expect(d.shares[0].what).toBe('hello');
    expect(d.shares[0].sender_name).toBe('Adnan');
    expect(d.shares[0].sender_email).toBe('adnan@team.com');
  });

  it('never shows a member their own share', () => {
    createShare(scope, 'adnan@team.com', { what: 'mine', priority: 'fyi' }, NOW);
    expect(getUnread(scope, 'Adnan@Team.com', NOW, 14).total).toBe(0);
  });

  it('hides shares once viewed or dismissed', () => {
    const a = createShare(scope, 'adnan@team.com', { what: 'a', priority: 'fyi' }, NOW);
    const b = createShare(scope, 'adnan@team.com', { what: 'b', priority: 'fyi' }, NOW);
    ack(a.id, 'priya@team.com', 'viewed');
    ack(b.id, 'priya@team.com', 'dismissed');
    expect(getUnread(scope, 'priya@team.com', NOW, 14).total).toBe(0);
  });

  it('excludes shares older than the expiry window', () => {
    createShare(scope, 'adnan@team.com', { what: 'old', priority: 'blocking' }, '2026-08-01T00:00:00.000Z');
    createShare(scope, 'adnan@team.com', { what: 'fresh', priority: 'fyi' }, '2026-08-28T00:00:00.000Z');
    const d = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(d.shares.map(s => s.what)).toEqual(['fresh']);
  });

  it('orders blocking first, then newest', () => {
    createShare(scope, 'adnan@team.com', { what: 'older-fyi', priority: 'fyi' }, '2026-08-26T00:00:00.000Z');
    createShare(scope, 'adnan@team.com', { what: 'new-fyi', priority: 'fyi' }, '2026-08-27T00:00:00.000Z');
    createShare(scope, 'adnan@team.com', { what: 'blocker', priority: 'blocking' }, '2026-08-21T00:00:00.000Z');
    const d = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(d.shares.map((s) => s.what)).toEqual(['blocker', 'new-fyi', 'older-fyi']);
  });

  it('caps the list at UNREAD_LIMIT but reports the true total', () => {
    for (let i = 0; i < UNREAD_LIMIT + 5; i++) {
      createShare(scope, 'adnan@team.com', { what: `s${i}`, priority: 'fyi' }, '2026-08-27T00:00:00.000Z');
    }
    const d = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(d.total).toBe(UNREAD_LIMIT + 5);
    expect(d.shares).toHaveLength(UNREAD_LIMIT);
  });

  it('shows a share to a member who joined after it was created', () => {
    createShare(scope, 'adnan@team.com', { what: 'before-join', priority: 'fyi' }, '2026-08-27T00:00:00.000Z');
    upsertMember(scope, 'newbie@team.com', 'Newbie', NOW);
    expect(getUnread(scope, 'newbie@team.com', NOW, 14).total).toBe(1);
  });

  it('excludes a share marked stale, from both total and the list', () => {
    const a = createShare(scope, 'adnan@team.com', { what: 'still fresh', priority: 'fyi' }, NOW);
    const b = createShare(scope, 'adnan@team.com', { what: 'gone stale', priority: 'fyi' }, NOW);
    markStale(scope, b.id, 'adnan@team.com', NOW);
    const d = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(d.total).toBe(1);
    expect(d.shares.map((s) => s.id)).toEqual([a.id]);
  });
});

describe('cross-team isolation', () => {
  let teamA: TeamScope;
  let teamB: TeamScope;

  beforeEach(() => {
    // scope/db from the outer beforeEach already gives us one team (teamA);
    // add a second team in the SAME database, as real multi-tenant data
    // would be laid out.
    teamA = scope;
    const teamBId = createTeam(db, 'Team B', hashToken('ts_teamB'), T0);
    teamB = makeTeamScope(db, teamBId);

    // Both teams have a member at the SAME email address, with DIFFERENT
    // display names — a fixture a single-email test cannot catch: if the
    // members join in getUnread isn't scoped by team_id, it can fan out
    // (one row per matching email across teams) or resolve the wrong
    // team's display name for a shared address.
    upsertMember(teamA, 'shared@company.com', 'Alice (Team A)', T0);
    upsertMember(teamB, 'shared@company.com', 'Alice (Team B)', T0);
    upsertMember(teamB, 'reader@company.com', 'Reader B', T0);
    // reader@company.com is on BOTH teams, with a different display name in
    // each — which makes the addressing test below sharper than it was when
    // this address existed only in team B: team A addresses a real, local
    // member whose address team B also has, so nothing but team_id scoping on
    // share_recipients keeps team A's share out of team B's digest.
    upsertMember(teamA, 'reader@company.com', 'Reader A', T0);
  });

  it('shows only the calling team\'s shares, with that team\'s own display name for the shared email', () => {
    createShare(teamA, 'shared@company.com', { what: 'Team A secret plan', priority: 'blocking' }, NOW);
    createShare(teamB, 'shared@company.com', { what: 'Team B secret plan', priority: 'blocking' }, NOW);

    const digestA = getUnread(teamA, 'priya@team.com', NOW, 14);
    expect(digestA.total).toBe(1);
    expect(digestA.shares).toHaveLength(1); // no fan-out from the shared-email join
    expect(digestA.shares[0].what).toBe('Team A secret plan');
    expect(digestA.shares[0].sender_name).toBe('Alice (Team A)');

    const digestB = getUnread(teamB, 'reader@company.com', NOW, 14);
    expect(digestB.total).toBe(1);
    expect(digestB.shares).toHaveLength(1);
    expect(digestB.shares[0].what).toBe('Team B secret plan');
    expect(digestB.shares[0].sender_name).toBe('Alice (Team B)');
  });

  it('a receipt recorded in one team never suppresses the other team\'s otherwise-identical share', () => {
    const a = createShare(teamA, 'shared@company.com', { what: 'shared subject line', priority: 'fyi' }, NOW);
    const b = createShare(teamB, 'shared@company.com', { what: 'shared subject line', priority: 'fyi' }, NOW);
    // Acknowledge team A's copy only.
    db.prepare(
      `INSERT INTO receipts (team_id, share_id, member_email, status, at) VALUES (?, ?, ?, ?, ?)`,
    ).run(teamA.teamId, a.id, 'priya@team.com', 'viewed', NOW);

    expect(getUnread(teamA, 'priya@team.com', NOW, 14).total).toBe(0);
    expect(getUnread(teamB, 'reader@company.com', NOW, 14).total).toBe(1);
    expect(getUnread(teamB, 'reader@company.com', NOW, 14).shares[0].id).toBe(b.id);
  });

  it('addressing a recipient in one team never leaks a share into another team\'s digest for a shared email', () => {
    // shared@company.com and reader@company.com are members of BOTH teams
    // (see the outer beforeEach). Team A addresses a share to
    // reader@company.com's exact address — if the recipient check ever forgot
    // to scope share_recipients by team_id, this share_id/email pair could
    // wrongly surface in team B's digest for that email.
    createShare(
      teamA, 'shared@company.com',
      { what: 'Team A note misaddressed to a Team B email', priority: 'fyi', recipients: ['reader@company.com'] },
      NOW,
    );
    expect(getUnread(teamB, 'reader@company.com', NOW, 14).total).toBe(0);
  });
});


// ---------------------------------------------------------------------------
// Relevance: the digest exists to be read, so it stops pushing things nobody
// is going to act on — while never pretending they are not there.
// ---------------------------------------------------------------------------

describe('getUnread: relevance', () => {
  // Uses this file's shared beforeEach: a default-team scope with Adnan and
  // Priya already members.
  const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

  it('holds back an ordinary share past the window, and counts it instead', () => {
    createShare(scope, 'adnan@team.com', { what: 'fresh', priority: 'fyi' }, daysAgo(1));
    createShare(scope, 'adnan@team.com', { what: 'ancient', priority: 'fyi' }, daysAgo(10));

    const d = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(d.shares.map((s) => s.what)).toEqual(['fresh']);
    expect(d.total).toBe(1);
    // Not silently dropped: the caller can say "and 1 older".
    expect(d.older).toBe(1);
  });

  it('still surfaces an old blocking share, because that is what blocking means', () => {
    createShare(scope, 'adnan@team.com', { what: 'do not merge', priority: 'blocking' }, daysAgo(10));
    const d = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(d.shares.map((s) => s.what)).toEqual(['do not merge']);
    expect(d.older).toBe(0);
  });

  it('returns them all when the caller explicitly asks for the old ones', () => {
    createShare(scope, 'adnan@team.com', { what: 'fresh', priority: 'fyi' }, daysAgo(1));
    createShare(scope, 'adnan@team.com', { what: 'ancient', priority: 'fyi' }, daysAgo(10));

    const d = getUnread(scope, 'priya@team.com', NOW, 14, { includeOld: true });
    expect(d.shares.map((s) => s.what).sort()).toEqual(['ancient', 'fresh']);
    expect(d.total).toBe(2);
    expect(d.older).toBe(0);
  });

  it('carries a human age and a grade on every entry', () => {
    createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, daysAgo(2));
    const [entry] = getUnread(scope, 'priya@team.com', NOW, 14).shares;
    expect(entry.age).toBe('2 days ago');
    expect(entry.relevance).toBe('recent');
    // The exact instant is still there for anyone who wants it.
    expect(entry.created_at).toBe(daysAgo(2));
  });

  it('spends the row limit on shares it will actually show', () => {
    // The relevance filter lives in SQL for this reason: applied to fetched
    // rows instead, 25 old shares would consume the whole LIMIT and starve the
    // recent ones the digest exists to surface.
    for (let i = 0; i < 25; i++) {
      createShare(scope, 'adnan@team.com', { what: `old${i}`, priority: 'fyi' }, daysAgo(9));
    }
    createShare(scope, 'adnan@team.com', { what: 'today', priority: 'fyi' }, daysAgo(0));

    const d = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(d.shares.map((s) => s.what)).toEqual(['today']);
    expect(d.older).toBe(25);
  });

  it('counts only genuinely hidden shares as older — never stale or expired ones', () => {
    // Those are excluded from unread altogether, so counting them would
    // promise the reader something `includeOld` would not deliver.
    const stale = createShare(scope, 'adnan@team.com', { what: 'stale', priority: 'fyi' }, daysAgo(1));
    markStale(scope, stale.id, 'adnan@team.com', NOW);
    createShare(scope, 'adnan@team.com', { what: 'expired', priority: 'fyi' }, daysAgo(30));

    const d = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(d.total).toBe(0);
    expect(d.older).toBe(0);
    expect(getUnread(scope, 'priya@team.com', NOW, 14, { includeOld: true }).total).toBe(0);
  });

  it('respects a narrower window on both the list and the count', () => {
    createShare(scope, 'adnan@team.com', { what: 'two-days', priority: 'fyi' }, daysAgo(2));
    const d = getUnread(scope, 'priya@team.com', NOW, 14, { relevanceWindowDays: 1 });
    expect(d.shares).toHaveLength(0);
    expect(d.older).toBe(1);
  });
});


// ---------------------------------------------------------------------------
// Project scoping (Task 5): opt-in, never inferred. A share carries a
// project only when its author's assistant sets one; a reader narrows only
// when they themselves are in a repo.
// ---------------------------------------------------------------------------

describe('getUnread: project scoping', () => {
  const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

  it('shows a scoped share only to a reader in that repo, and unscoped ones to everyone', () => {
    createShare(scope, 'adnan@team.com', { what: 'api thing', priority: 'fyi', project: 'github.com/acme/api' }, NOW);
    createShare(scope, 'adnan@team.com', { what: 'out sick', priority: 'fyi' }, NOW);

    const inApi = getUnread(scope, 'priya@team.com', NOW, 14, { project: 'github.com/acme/api' });
    expect(inApi.shares.map((s) => s.what).sort()).toEqual(['api thing', 'out sick']);

    const inWeb = getUnread(scope, 'priya@team.com', NOW, 14, { project: 'github.com/acme/web' });
    expect(inWeb.shares.map((s) => s.what)).toEqual(['out sick']);

    // No project at all: the reader is not in a repo, so nothing is hidden.
    const anywhere = getUnread(scope, 'priya@team.com', NOW, 14);
    expect(anywhere.shares).toHaveLength(2);
  });

  // The controller-flagged case: two independent conditional clauses
  // (relevance and project) appended to one positional-`?` query is exactly
  // how a silent cross-wiring lands — a digest that filters on the wrong
  // column while every single-feature test above still passes. This test
  // exercises both together, so a mis-bound parameter shows up as a wrong
  // count or a wrongly-included/excluded share rather than staying hidden.
  it('composes relevance and project filtering together, not just each alone', () => {
    createShare(
      scope, 'adnan@team.com',
      { what: 'old api note', priority: 'fyi', project: 'github.com/acme/api' }, daysAgo(10),
    );
    createShare(
      scope, 'adnan@team.com',
      { what: 'fresh api note', priority: 'fyi', project: 'github.com/acme/api' }, daysAgo(1),
    );
    createShare(
      scope, 'adnan@team.com',
      { what: 'fresh web note', priority: 'fyi', project: 'github.com/acme/web' }, daysAgo(1),
    );

    const d = getUnread(scope, 'priya@team.com', NOW, 14, { project: 'github.com/acme/api' });
    // The web note is out of scope entirely — it must not appear, and must
    // not be counted as "older" either (it was never unread for this reader).
    expect(d.shares.map((s) => s.what)).toEqual(['fresh api note']);
    expect(d.total).toBe(1);
    // The old api note IS in scope but past the relevance window — held back
    // and counted, not silently dropped and not conflated with the web note.
    expect(d.older).toBe(1);

    // Sanity check from the other side: a reader in the web repo sees
    // neither api note, old or fresh.
    const web = getUnread(scope, 'priya@team.com', NOW, 14, { project: 'github.com/acme/web' });
    expect(web.shares.map((s) => s.what)).toEqual(['fresh web note']);
    expect(web.older).toBe(0);
  });

  // A reader has to be able to see WHY a colleague never got a share — "it
  // was scoped to a different repo" is a very different answer from silence.
  // That means the digest entry itself must carry the scope, not just use it
  // to filter server-side.
  it('carries each share\'s project (or null) on the digest entry itself', () => {
    createShare(scope, 'adnan@team.com', { what: 'api thing', priority: 'fyi', project: 'github.com/acme/api' }, NOW);
    createShare(scope, 'adnan@team.com', { what: 'team-wide note', priority: 'fyi' }, NOW);

    const digest = getUnread(scope, 'priya@team.com', NOW, 14);
    const byWhat = Object.fromEntries(digest.shares.map((s) => [s.what, s.project]));
    expect(byWhat['api thing']).toBe('github.com/acme/api');
    expect(byWhat['team-wide note']).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// Recipients (Task 7): a share can be addressed to specific people rather
// than the whole team. Verbatim from the task-7 brief's own Step 1 tests.
// ---------------------------------------------------------------------------

describe('getUnread: recipients', () => {
  it('reaches only the people it names, and never the sender', () => {
    createShare(scope, 'adnan@team.com', { what: 'for sam', priority: 'fyi', recipients: ['sam@team.com'] }, NOW);
    expect(getUnread(scope, 'sam@team.com', NOW, 14).total).toBe(1);
    expect(getUnread(scope, 'priya@team.com', NOW, 14).total).toBe(0);
    expect(getUnread(scope, 'adnan@team.com', NOW, 14).total).toBe(0);
  });

  it('normalises recipient addresses the way every other email is normalised', () => {
    createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi', recipients: ['SAM@Team.com '] }, NOW);
    expect(getUnread(scope, 'sam@team.com', NOW, 14).total).toBe(1);
  });

  it('counts only the addressed people as notified', () => {
    const { notified } = createShare(
      scope, 'adnan@team.com',
      { what: 'x', priority: 'fyi', recipients: ['sam@team.com', 'priya@team.com'] }, NOW,
    );
    expect(notified).toBe(2);
  });

  it('treats an empty recipient list as the whole team, not as nobody', () => {
    createShare(scope, 'adnan@team.com', { what: 'everyone', priority: 'fyi', recipients: [] }, NOW);
    expect(getUnread(scope, 'priya@team.com', NOW, 14).total).toBe(1);
  });

  // Task 8: DigestEntry.to_me is what every renderer uses to say "to you"
  // instead of printing the recipient list — the other names on an addressed
  // share are nobody else's business to see.
  it('marks an addressed share to_me for its recipient, and not for a team-wide one', () => {
    createShare(scope, 'adnan@team.com', { what: 'for sam', priority: 'fyi', recipients: ['sam@team.com'] }, NOW);
    createShare(scope, 'adnan@team.com', { what: 'for everyone', priority: 'fyi' }, NOW);

    const sam = getUnread(scope, 'sam@team.com', NOW, 14);
    expect(sam.shares.find((s) => s.what === 'for sam')?.to_me).toBe(true);
    expect(sam.shares.find((s) => s.what === 'for everyone')?.to_me).toBe(false);
  });

  // The controller-flagged case: THREE independent conditional clauses
  // (relevance, project, recipient) all landing in one query is exactly
  // where a silent cross-wiring shows up — a digest that filters on the
  // wrong column while every single- and double-feature test above still
  // passes. This exercises all three together, from both a named
  // recipient's side and a bystander's.
  it('composes relevance, project, and recipient filtering together, not just each alone', () => {
    const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

    createShare(
      scope, 'adnan@team.com',
      { what: 'old api note for sam', priority: 'fyi', project: 'github.com/acme/api', recipients: ['sam@team.com'] },
      daysAgo(10),
    );
    createShare(
      scope, 'adnan@team.com',
      { what: 'fresh api note for sam', priority: 'fyi', project: 'github.com/acme/api', recipients: ['sam@team.com'] },
      daysAgo(1),
    );
    createShare(
      scope, 'adnan@team.com',
      { what: 'fresh api note for priya', priority: 'fyi', project: 'github.com/acme/api', recipients: ['priya@team.com'] },
      daysAgo(1),
    );
    createShare(
      scope, 'adnan@team.com',
      { what: 'fresh web note for sam', priority: 'fyi', project: 'github.com/acme/web', recipients: ['sam@team.com'] },
      // Two days rather than one: still inside the relevance window, but
      // strictly older than the api note, so the digest's newest-first order
      // is decided by the timestamps and not by a random share id.
      daysAgo(2),
    );

    const sam = getUnread(scope, 'sam@team.com', NOW, 14, { project: 'github.com/acme/api' });
    // BEHAVIOUR CHANGE (controller ruling): the web note is here too, and
    // this assertion used to say it was not. Relevance and recipient still
    // filter as before — the old note is held back, priya's note is not
    // sam's to see — but the project scope no longer narrows away a share
    // whose author named sam personally. Repo scope is a relevance hint the
    // author drops on a note; addressing is a deliberate decision about whose
    // note it is, and the deliberate one wins. Ordered newest-first, so the
    // api note (1 day) precedes the web note (2 days).
    expect(sam.shares.map((s) => s.what)).toEqual(['fresh api note for sam', 'fresh web note for sam']);
    expect(sam.total).toBe(2);
    // The old api note IS addressed to sam and in scope, but past the
    // relevance window — held back and counted as "older", never conflated
    // with the note that was never addressed to sam at all, which must not
    // inflate this count.
    expect(sam.older).toBe(1);

    // From priya's side, in the same repo: only the note addressed to her.
    // The scoped-and-addressed notes are not hers at any scope.
    const priya = getUnread(scope, 'priya@team.com', NOW, 14, { project: 'github.com/acme/api' });
    expect(priya.shares.map((s) => s.what)).toEqual(['fresh api note for priya']);
    expect(priya.older).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Repo scope vs. an explicit recipient
  //
  // Controller ruling: an explicit recipient bypasses repo narrowing. The two
  // are not the same kind of thing. Scope is a relevance hint — "this note is
  // about the api repo" — and narrowing on it costs a reader nothing they
  // wanted. Addressing is access control: the author decided who this note
  // belongs to. Letting the hint override the decision meant a share
  // addressed to Sam and scoped to a repo he was not sitting in was invisible
  // everywhere at once — absent from his digest, absent from his `older`
  // count, no signal on any surface — while its author saw `notified: 1` and
  // `receipts` reported him unseen forever. README's "Addressing a share to
  // specific people" has documented the ruling from the start: once a share
  // names people it reaches them "regardless of where anyone is working".
  // -------------------------------------------------------------------------

  it('delivers a share addressed to me even when it is scoped to a repo I am not sitting in', () => {
    createShare(
      scope, 'adnan@team.com',
      { what: 'for sam, about api', priority: 'fyi', project: 'github.com/acme/api', recipients: ['sam@team.com'] },
      NOW,
    );

    const sam = getUnread(scope, 'sam@team.com', NOW, 14, { project: 'github.com/acme/web' });
    expect(sam.shares.map((s) => s.what)).toEqual(['for sam, about api']);
    expect(sam.total).toBe(1);
    // Still "to you" on the line, and still carrying the scope it was
    // published with, so the reader can see why it mentions another repo.
    expect(sam.shares[0].to_me).toBe(true);
    expect(sam.shares[0].project).toBe('github.com/acme/api');
  });

  it('still narrows an UNADDRESSED scoped share away from a reader in another repo', () => {
    // The other half of the ruling, and the one a careless fix breaks: it is
    // being named that outranks the scope, not merely being on the team.
    createShare(
      scope, 'adnan@team.com',
      { what: 'for the team, about api', priority: 'fyi', project: 'github.com/acme/api' },
      NOW,
    );
    const sam = getUnread(scope, 'sam@team.com', NOW, 14, { project: 'github.com/acme/web' });
    expect(sam.shares).toEqual([]);
    expect(sam.total).toBe(0);
    expect(sam.older).toBe(0);
  });

  it('counts an addressed out-of-repo share as older rather than as nothing at all', () => {
    const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
    createShare(
      scope, 'adnan@team.com',
      { what: 'old note for sam', priority: 'fyi', project: 'github.com/acme/api', recipients: ['sam@team.com'] },
      daysAgo(10),
    );
    const sam = getUnread(scope, 'sam@team.com', NOW, 14, { project: 'github.com/acme/web' });
    expect(sam.total).toBe(0);
    // Past the relevance window, so not pushed at him — but counted, which is
    // the difference between "held back" and "silently gone".
    expect(sam.older).toBe(1);
  });

  it('never gives a scoped share to someone it was addressed away from, whatever repo they are in', () => {
    createShare(
      scope, 'adnan@team.com',
      { what: 'for sam only', priority: 'fyi', project: 'github.com/acme/api', recipients: ['sam@team.com'] },
      NOW,
    );
    for (const project of ['github.com/acme/api', 'github.com/acme/web', undefined]) {
      const priya = getUnread(scope, 'priya@team.com', NOW, 14, { project });
      expect(priya.shares, String(project)).toEqual([]);
      expect(priya.total, String(project)).toBe(0);
      expect(priya.older, String(project)).toBe(0);
    }
  });

  // The digest and the accessors now ask ONE question — shares.ts's
  // visibleToClause — instead of each spelling out its own copy of "may this
  // person see this share at all". The two copies agreed only because
  // WHERE_UNREAD's `sender_email != ?` happened to cover the author arm the
  // digest's copy lacked; an accident is not a design. This pins the
  // consequence a reader can actually observe: anything the digest hands you
  // is something the accessor will hand you too, and anything it withholds
  // for someone else's sake stays withheld there as well.
  it('delivers exactly what the accessors agree this reader may read', () => {
    const mine = createShare(
      scope, 'adnan@team.com',
      { what: 'for sam, about api', priority: 'fyi', project: 'github.com/acme/api', recipients: ['sam@team.com'] },
      NOW,
    ).id;
    const hers = createShare(
      scope, 'adnan@team.com',
      { what: 'for priya', priority: 'fyi', recipients: ['priya@team.com'] },
      NOW,
    ).id;
    const everyones = createShare(scope, 'adnan@team.com', { what: 'for the team', priority: 'fyi' }, NOW).id;

    // Sam is sitting in a different repo than the one his note is scoped to.
    const sam = getUnread(scope, 'sam@team.com', NOW, 14, { project: 'github.com/acme/web' });
    expect(sam.shares.map((s) => s.id).sort()).toEqual([mine, everyones].sort());

    // Everything delivered is readable, and the one thing withheld is
    // withheld by the same gate rather than by a second copy of the rule.
    for (const s of sam.shares) expect(getShare(scope, s.id, 'sam@team.com'), s.id).toBeDefined();
    expect(getShare(scope, hers, 'sam@team.com')).toBeUndefined();
  });
});

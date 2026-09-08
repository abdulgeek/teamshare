import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openDb, upsertMember, createTeam, hashToken, getOrCreateDefaultTeamId, makeTeamScope,
  createMemberToken,
  type Db, type TeamScope,
} from './db.js';
import { validateShare, createShare, getShare, listShares, retractShare, markStale } from './shares.js';
import { getUnread } from './unread.js';

let db: Db;
let scope: TeamScope;
const NOW = '2026-08-29T10:00:00.000Z';

beforeEach(() => {
  db = openDb(':memory:');
  scope = makeTeamScope(db, getOrCreateDefaultTeamId(db));
  upsertMember(scope, 'adnan@team.com', 'Adnan', NOW);
  upsertMember(scope, 'priya@team.com', 'Priya', NOW);
  upsertMember(scope, 'sam@team.com', 'Sam', NOW);
});
afterEach(() => { db.close(); });

describe('validateShare', () => {
  it('accepts a minimal valid share', () => {
    const r = validateShare({ what: 'Auth refactor lands Friday.', priority: 'heads-up' });
    expect(r.ok).toBe(true);
  });

  it('rejects an empty what', () => {
    const r = validateShare({ what: '   ', priority: 'fyi' });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('what') });
  });

  it('rejects what over 200 chars and names the field and cap', () => {
    const r = validateShare({ what: 'x'.repeat(201), priority: 'fyi' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('what');
      expect(r.error).toContain('200');
    }
  });

  it('rejects why over 300 and action over 200', () => {
    expect(validateShare({ what: 'ok', priority: 'fyi', why: 'y'.repeat(301) }).ok).toBe(false);
    expect(validateShare({ what: 'ok', priority: 'fyi', action: 'a'.repeat(201) }).ok).toBe(false);
  });

  it('rejects more than 5 tags or a tag over 20 chars', () => {
    expect(validateShare({ what: 'ok', priority: 'fyi', tags: ['a','b','c','d','e','f'] }).ok).toBe(false);
    expect(validateShare({ what: 'ok', priority: 'fyi', tags: ['x'.repeat(21)] }).ok).toBe(false);
  });

  it('rejects an unknown priority', () => {
    // deliberately bypass the type to simulate a bad client
    const r = validateShare({ what: 'ok', priority: 'URGENT' as never });
    expect(r.ok).toBe(false);
  });

  it('lowercases tags rather than rejecting them, and trims text', () => {
    const r = validateShare({ what: '  spaced  ', priority: 'fyi', tags: ['AUTH', 'Refactor'] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tags).toEqual(['auth', 'refactor']);
      expect(r.value.what).toBe('spaced');
    }
  });

  it('treats omitted why/action as null', () => {
    const r = validateShare({ what: 'ok', priority: 'fyi' });
    if (r.ok) {
      expect(r.value.why).toBeNull();
      expect(r.value.action).toBeNull();
    }
  });

  // project trusts the caller to have already run the value through
  // normalizeProject (project.ts) — but that trust was harmless only while
  // nothing could set the field. Once a client (the `share` tool) can put
  // arbitrary text here, the shape has to be enforced, or a share could be
  // scoped to a string no reader's own normalizeProject output will ever
  // equal — silently unreachable rather than team-wide or correctly scoped.
  it('accepts a project that already looks like a normalized git remote', () => {
    const r = validateShare({ what: 'ok', priority: 'fyi', project: 'github.com/acme/api' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.project).toBe('github.com/acme/api');
  });

  it('rejects a project that is not normalizeProject-shaped, e.g. a raw URL or a path-traversal string', () => {
    for (const bad of ['https://github.com/acme/api.git', '../../etc', 'not a remote at all', 'github.com']) {
      const r = validateShare({ what: 'ok', priority: 'fyi', project: bad });
      expect(r, bad).toEqual({ ok: false, error: expect.stringContaining('project') });
    }
  });

  it('rejects an oversize project and names the field and cap', () => {
    const r = validateShare({ what: 'ok', priority: 'fyi', project: `github.com/${'a'.repeat(201)}` });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('project');
      expect(r.error).toContain('200');
    }
  });

  it('treats an omitted or blank project as null, same as why/action', () => {
    const omitted = validateShare({ what: 'ok', priority: 'fyi' });
    expect(omitted.ok).toBe(true);
    if (omitted.ok) expect(omitted.value.project).toBeNull();

    const blank = validateShare({ what: 'ok', priority: 'fyi', project: '   ' });
    expect(blank.ok).toBe(true);
    if (blank.ok) expect(blank.value.project).toBeNull();
  });
});

// Finding 4: recipients used to bypass validateShare entirely — no shape
// check, no cap, no length limit, '<script>' stored verbatim — while every
// other field was gated here. Unvalidated input is also what made the
// fail-open cases below reachable, so the gate comes first.
describe('validateShare: recipients', () => {
  it('treats an omitted or empty list as no recipients at all — the whole team', () => {
    const omitted = validateShare({ what: 'ok', priority: 'fyi' });
    expect(omitted.ok).toBe(true);
    if (omitted.ok) expect(omitted.value.recipients).toEqual([]);

    const empty = validateShare({ what: 'ok', priority: 'fyi', recipients: [] });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value.recipients).toEqual([]);
  });

  it('normalises and deduplicates the addresses it accepts, like every other email', () => {
    const r = validateShare({
      what: 'ok', priority: 'fyi',
      recipients: ['SAM@Team.com ', 'sam@team.com', 'Priya@team.com'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.recipients).toEqual(['sam@team.com', 'priya@team.com']);
  });

  it('rejects an address that is not one, and names the offending entry', () => {
    for (const bad of ['<script>', 'not an address', 'sam@team', '${TEAMMATE}', 'sam@team.com, priya@team.com']) {
      const r = validateShare({ what: 'ok', priority: 'fyi', recipients: ['sam@team.com', bad] });
      expect(r.ok, bad).toBe(false);
      // The message must say WHICH one is wrong, not that one of them is.
      if (!r.ok) expect(r.error, bad).toContain(bad);
    }
  });

  it('rejects a blank entry rather than filtering it away', () => {
    // Filtering is exactly what turned ['   '] into a team-wide broadcast.
    const r = validateShare({ what: 'ok', priority: 'fyi', recipients: ['   '] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('recipients');
  });

  it('rejects a non-string entry instead of throwing a TypeError on it', () => {
    const r = validateShare({ what: 'ok', priority: 'fyi', recipients: [null as unknown as string] });
    expect(r.ok).toBe(false);
  });

  it('caps how many people one share can be addressed to, naming the cap', () => {
    const many = Array.from({ length: 21 }, (_, i) => `p${i}@team.com`);
    const r = validateShare({ what: 'ok', priority: 'fyi', recipients: many });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('recipients');
      expect(r.error).toContain('20');
    }
  });

  it('caps the length of a single address', () => {
    const r = validateShare({ what: 'ok', priority: 'fyi', recipients: [`${'a'.repeat(300)}@team.com`] });
    expect(r.ok).toBe(false);
  });
});

describe('createShare', () => {
  it('stores the share and reports members notified, excluding the sender', () => {
    const { id, notified } = createShare(
      scope, 'Adnan@Team.com',
      { what: 'Auth refactor lands Friday.', priority: 'blocking', tags: ['Auth'] },
      NOW,
    );
    expect(notified).toBe(2); // priya + sam, not adnan
    const row = getShare(scope, id);
    expect(row?.sender_email).toBe('adnan@team.com');
    expect(row?.tags).toEqual(['auth']);
    expect(row?.priority).toBe('blocking');
    expect(row?.created_at).toBe(NOW);
  });

  it('throws on invalid input so callers must validate first', () => {
    expect(() => createShare(scope, 'adnan@team.com', { what: '', priority: 'fyi' }, NOW)).toThrow();
  });
});

describe('createShare: recipients (Task 7)', () => {
  it('defaults to an empty recipients list, meaning the whole team', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    expect(getShare(scope, id)?.recipients).toEqual([]);
  });

  it('stores normalized, deduplicated recipient addresses and reports them back sorted', () => {
    const { id } = createShare(
      scope, 'adnan@team.com',
      { what: 'x', priority: 'fyi', recipients: ['SAM@Team.com ', 'priya@team.com', 'priya@team.com'] },
      NOW,
    );
    expect(getShare(scope, id)?.recipients).toEqual(['priya@team.com', 'sam@team.com']);
  });

  it('never counts the sender as notified, even if they name themselves as a recipient', () => {
    const { notified } = createShare(
      scope, 'adnan@team.com',
      { what: 'x', priority: 'fyi', recipients: ['adnan@team.com', 'sam@team.com'] },
      NOW,
    );
    expect(notified).toBe(1);
  });

  it('writes share_recipients rows scoped to the calling team only', () => {
    const { id } = createShare(
      scope, 'adnan@team.com',
      { what: 'x', priority: 'fyi', recipients: ['sam@team.com'] },
      NOW,
    );
    const rows = db.prepare('SELECT team_id, email FROM share_recipients WHERE share_id = ?').all(id) as {
      team_id: string;
      email: string;
    }[];
    expect(rows).toEqual([{ team_id: scope.teamId, email: 'sam@team.com' }]);
  });
});

// The fail-open cluster from the Task 7 review: three ways a share the author
// addressed to one person could still reach the whole team. The shape of every
// test here is the same, because the bug was: assert the write did not happen,
// AND assert the bystander cannot see anything.
describe('createShare: an addressed share never fails open (fix round 1)', () => {
  const countShares = () =>
    (db.prepare('SELECT COUNT(*) AS n FROM shares').get() as { n: number }).n;
  const countRecipientRows = () =>
    (db.prepare('SELECT COUNT(*) AS n FROM share_recipients').get() as { n: number }).n;
  /** The bystander's view: Priya was never addressed, so she must see nothing. */
  const priyaSees = () => getUnread(scope, 'priya@team.com', NOW, 14).total;

  // Finding 1: the share row used to commit BEFORE the recipient rows were
  // written, so anything that threw in between left a committed share with
  // zero recipient rows — which AND_RECIPIENT (unread.ts) reads as team-wide.
  it('leaves no share behind when writing the recipient rows fails part-way', () => {
    // A deterministic mid-write failure: the share INSERT succeeds, the first
    // share_recipients INSERT aborts. Nothing about this is specific to how
    // the recipient rows are built — it is the general "something failed
    // between the two writes" case.
    db.exec(`CREATE TRIGGER fail_recipient_write BEFORE INSERT ON share_recipients
             BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);

    expect(() =>
      createShare(
        scope, 'adnan@team.com',
        { what: 'for sam only', priority: 'fyi', recipients: ['sam@team.com'] },
        NOW,
      ),
    ).toThrow();

    // Not "the share exists but is addressed to nobody" — the share does not
    // exist at all.
    expect(countShares()).toBe(0);
    expect(countRecipientRows()).toBe(0);
    expect(priyaSees()).toBe(0);
  });

  // Finding 1, the reviewer's own probe: recipients: [null] threw a TypeError
  // out of normalisation, after the share had already committed.
  it('leaves no share behind when a recipient entry cannot be normalised at all', () => {
    expect(() =>
      createShare(
        scope, 'adnan@team.com',
        { what: 'for sam only', priority: 'fyi', recipients: [null as unknown as string] },
        NOW,
      ),
    ).toThrow();

    expect(countShares()).toBe(0);
    expect(priyaSees()).toBe(0);
  });

  // Finding 2: a list the author actually wrote that normalises away to
  // nothing must be an error. "Empty means the whole team" is about a list
  // that was omitted or [], never about one that collapsed.
  it('rejects a list of nothing but blanks rather than broadcasting it', () => {
    expect(() =>
      createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi', recipients: ['   '] }, NOW),
    ).toThrow(/recipients/);

    expect(countShares()).toBe(0);
    expect(priyaSees()).toBe(0);
  });

  it('rejects a list that names only the sender rather than broadcasting it', () => {
    // Mixed case on purpose: the sender is excluded after normalisation, so
    // this is the same collapse as ['adnan@team.com'].
    expect(() =>
      createShare(
        scope, 'adnan@team.com',
        { what: 'x', priority: 'fyi', recipients: ['Adnan@Team.com '] },
        NOW,
      ),
    ).toThrow(/only you/);

    expect(countShares()).toBe(0);
    expect(priyaSees()).toBe(0);
  });

  // The other half of Finding 2: the fix must not have made the genuine
  // team-wide cases stricter. Omitted and [] still mean everyone.
  it('still treats an omitted list and an empty list as the whole team', () => {
    createShare(scope, 'adnan@team.com', { what: 'omitted', priority: 'fyi' }, NOW);
    createShare(scope, 'adnan@team.com', { what: 'empty', priority: 'fyi', recipients: [] }, NOW);

    expect(countRecipientRows()).toBe(0);
    expect(priyaSees()).toBe(2);
  });

  // Finding 3: an address nobody on the team holds used to be counted as
  // notified while reaching, and being expected to read, nobody. It is now an
  // error that names the address — a typo is recoverable, a share published
  // into the void is not.
  it('rejects an address nobody on this team holds, and says which one', () => {
    expect(() =>
      createShare(
        scope, 'adnan@team.com',
        { what: 'x', priority: 'fyi', recipients: ['sma@team.com'] },
        NOW,
      ),
    ).toThrow(/sma@team\.com/);

    expect(countShares()).toBe(0);
  });

  // Task 8, controller ruling: "not a members row" used to lump together two
  // different situations with two different remedies. These two tests pin
  // each branch down on its own.
  it('tells a never-invited address to check itself or invite the person (never-invited branch)', () => {
    expect(() =>
      createShare(
        scope, 'adnan@team.com',
        { what: 'x', priority: 'fyi', recipients: ['stranger@elsewhere.com'] },
        NOW,
      ),
    ).toThrow(/not on this team: stranger@elsewhere\.com.*invite them/s);
    expect(countShares()).toBe(0);
  });

  it('tells an invited-but-unconnected address to connect once, not that it is unknown (invited branch)', () => {
    // Invited (a member_tokens row exists, from createMemberToken) but never
    // authenticated — upsertMember, which is what actually creates a
    // `members` row, is deliberately NOT called for this address.
    createMemberToken(scope, 'newhire@team.com', 'New Hire', NOW);

    expect(() =>
      createShare(
        scope, 'adnan@team.com',
        { what: 'x', priority: 'fyi', recipients: ['newhire@team.com'] },
        NOW,
      ),
    ).toThrow(/invited but not yet connected: newhire@team\.com.*connect once/s);
    // And the never-invited wording must NOT appear for this address.
    try {
      createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi', recipients: ['newhire@team.com'] }, NOW);
    } catch (e) {
      expect((e as Error).message).not.toContain('not on this team');
    }
    expect(countShares()).toBe(0);
  });

  it('rejects the whole list when one address is unknown, never publishing it half-addressed', () => {
    expect(() =>
      createShare(
        scope, 'adnan@team.com',
        { what: 'x', priority: 'fyi', recipients: ['sam@team.com', 'sma@team.com'] },
        NOW,
      ),
    ).toThrow(/sma@team\.com/);

    // Not "published, addressed to Sam only" — not published at all.
    expect(countShares()).toBe(0);
    expect(countRecipientRows()).toBe(0);
  });

  it('is scoped: a member of ANOTHER team is not an address this team can use', () => {
    const otherScope = makeTeamScope(db, createTeam(db, 'Other', hashToken('ts_other'), NOW));
    upsertMember(otherScope, 'outsider@other.com', 'Outsider', NOW);

    expect(() =>
      createShare(
        scope, 'adnan@team.com',
        { what: 'x', priority: 'fyi', recipients: ['outsider@other.com'] },
        NOW,
      ),
    ).toThrow(/outsider@other\.com/);
    expect(countShares()).toBe(0);
  });

  it('reports every addressed person, and only real ones, as notified', () => {
    const { notified } = createShare(
      scope, 'adnan@team.com',
      // Duplicated and differently-cased on purpose: notified counts people,
      // not entries.
      { what: 'x', priority: 'fyi', recipients: ['sam@team.com', 'SAM@team.com', 'priya@team.com'] },
      NOW,
    );
    expect(notified).toBe(2);
  });
});

describe('retractShare: recipients cascade', () => {
  it('deletes share_recipients rows via ON DELETE CASCADE, same as receipts', () => {
    const { id } = createShare(
      scope, 'adnan@team.com',
      { what: 'x', priority: 'fyi', recipients: ['sam@team.com'] },
      NOW,
    );
    const before = db
      .prepare('SELECT COUNT(*) AS n FROM share_recipients WHERE team_id = ? AND share_id = ?')
      .get(scope.teamId, id) as { n: number };
    expect(before.n).toBe(1);

    const result = retractShare(scope, id, 'adnan@team.com');
    expect(result.ok).toBe(true);

    const after = db
      .prepare('SELECT COUNT(*) AS n FROM share_recipients WHERE team_id = ? AND share_id = ?')
      .get(scope.teamId, id) as { n: number };
    expect(after.n).toBe(0);
  });
});

describe('listShares', () => {
  it('returns newest first and filters by tag and sender', () => {
    createShare(scope, 'adnan@team.com', { what: 'first', priority: 'fyi', tags: ['auth'] }, '2026-08-01T00:00:00.000Z');
    createShare(scope, 'priya@team.com', { what: 'second', priority: 'fyi', tags: ['ui'] }, '2026-08-02T00:00:00.000Z');
    expect(listShares(scope, {}).map(s => s.what)).toEqual(['second', 'first']);
    expect(listShares(scope, { tag: 'auth' }).map(s => s.what)).toEqual(['first']);
    expect(listShares(scope, { sender: 'Priya@Team.com' }).map(s => s.what)).toEqual(['second']);
    expect(listShares(scope, { limit: 1 }).map(s => s.what)).toEqual(['second']);
  });

  it('a fresh share has a null stale_at', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    expect(getShare(scope, id)?.stale_at).toBeNull();
  });
});

describe('retractShare', () => {
  it('hard-deletes the share and its receipts (via ON DELETE CASCADE) when the author retracts', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'secret leak', priority: 'fyi' }, NOW);
    db.prepare(
      `INSERT INTO receipts (team_id, share_id, member_email, status, at) VALUES (?, ?, ?, ?, ?)`,
    ).run(scope.teamId, id, 'priya@team.com', 'viewed', NOW);

    const result = retractShare(scope, id, 'adnan@team.com');
    expect(result.ok).toBe(true);

    expect(getShare(scope, id)).toBeUndefined();
    expect(listShares(scope, {}).map((s) => s.id)).not.toContain(id);
    const receipts = db.prepare('SELECT * FROM receipts WHERE team_id = ? AND share_id = ?').all(scope.teamId, id);
    expect(receipts).toHaveLength(0);
  });

  it('rejects retraction by anyone other than the author, and leaves the share intact', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    const result = retractShare(scope, id, 'priya@team.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('only the author can retract a share');
    expect(getShare(scope, id)).toBeDefined();
  });

  it('is case-insensitive when comparing the caller to the author', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    const result = retractShare(scope, id, 'Adnan@Team.com');
    expect(result.ok).toBe(true);
    expect(getShare(scope, id)).toBeUndefined();
  });

  it('reports an unknown id as an error rather than throwing', () => {
    const result = retractShare(scope, 'shr_missing', 'adnan@team.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('shr_missing');
  });
});

describe('markStale', () => {
  it('sets stale_at when the author marks their own share stale', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    const result = markStale(scope, id, 'adnan@team.com', '2026-08-30T00:00:00.000Z');
    expect(result.ok).toBe(true);
    expect(getShare(scope, id)?.stale_at).toBe('2026-08-30T00:00:00.000Z');
  });

  it('rejects mark_stale by anyone other than the author', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    const result = markStale(scope, id, 'priya@team.com', '2026-08-30T00:00:00.000Z');
    expect(result.ok).toBe(false);
    expect(getShare(scope, id)?.stale_at).toBeNull();
  });

  it('is idempotent: marking an already-stale share does not change stale_at', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    markStale(scope, id, 'adnan@team.com', '2026-08-30T00:00:00.000Z');
    const second = markStale(scope, id, 'adnan@team.com', '2026-09-15T00:00:00.000Z');
    expect(second.ok).toBe(true);
    expect(getShare(scope, id)?.stale_at).toBe('2026-08-30T00:00:00.000Z');
  });

  it('reports an unknown id as an error rather than throwing', () => {
    const result = markStale(scope, 'shr_missing', 'adnan@team.com', NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('shr_missing');
  });

  it('leaves listShares once marked irrelevant — withdrawn from the team, not just the digest', () => {
    // "No longer relevant" that still turns up in every browse does not remove
    // the noise, it moves it. The row survives so the author can find it and
    // the receipts stay auditable; that is the difference from retract.
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    markStale(scope, id, 'adnan@team.com', '2026-08-30T00:00:00.000Z');
    expect(listShares(scope, {}).map((s) => s.id)).not.toContain(id);
  });

  it('is still findable by an explicit ask, so the mark is not a one-way door', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'x', priority: 'fyi' }, NOW);
    markStale(scope, id, 'adnan@team.com', '2026-08-30T00:00:00.000Z');
    expect(listShares(scope, { includeIrrelevant: true }).map((s) => s.id)).toContain(id);
    // The row itself is untouched — only its visibility changed.
    expect(getShare(scope, id)?.what).toBe('x');
  });
});

// Cross-team isolation. All of these live in the SAME database (as real
// multi-tenant data would), with two independent teams.
describe('cross-team isolation', () => {
  let otherScope: TeamScope;

  beforeEach(() => {
    const otherTeamId = createTeam(db, 'other team', hashToken('ts_other'), NOW);
    otherScope = makeTeamScope(db, otherTeamId);
    upsertMember(otherScope, 'intruder@other.com', 'Intruder', NOW);
  });

  it('listShares scopes even when called with an empty options object — never a clause-free scan of every team', () => {
    createShare(scope, 'adnan@team.com', { what: 'team A only', priority: 'fyi' }, NOW);
    createShare(otherScope, 'intruder@other.com', { what: 'team B only', priority: 'fyi' }, NOW);

    expect(listShares(scope, {}).map((s) => s.what)).toEqual(['team A only']);
    expect(listShares(otherScope, {}).map((s) => s.what)).toEqual(['team B only']);
  });

  it('getShare is scoped in SQL: another team cannot fetch a share by id', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'private to team A', priority: 'fyi' }, NOW);
    expect(getShare(otherScope, id)).toBeUndefined();
    expect(getShare(scope, id)).toBeDefined();
  });

  it('no existence oracle: a foreign-team id and a truly nonexistent id produce the identical "no share" message, never the author-mismatch message', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'team A secret', priority: 'fyi' }, NOW);

    const foreignAttempt = retractShare(otherScope, id, 'intruder@other.com');
    expect(foreignAttempt).toEqual({ ok: false, error: `no share with id ${id}` });

    const missingId = 'shr_definitely_missing_000000';
    const nonexistentAttempt = retractShare(otherScope, missingId, 'intruder@other.com');
    expect(nonexistentAttempt).toEqual({ ok: false, error: `no share with id ${missingId}` });

    // The author-mismatch message would confirm the id exists somewhere on
    // the instance — it must never be reachable for another team's share.
    expect((foreignAttempt as { ok: false; error: string }).error).not.toContain('only the author');

    // And the original share must be untouched by the foreign attempt.
    expect(getShare(scope, id)).toBeDefined();
  });

  it('markStale is likewise unreachable for another team\'s share', () => {
    const { id } = createShare(scope, 'adnan@team.com', { what: 'team A plan', priority: 'fyi' }, NOW);
    const result = markStale(otherScope, id, 'intruder@other.com', NOW);
    expect(result).toEqual({ ok: false, error: `no share with id ${id}` });
    expect(getShare(scope, id)?.stale_at).toBeNull();
  });

  it('createShare\'s notified count only counts the calling team\'s members', () => {
    upsertMember(otherScope, 'second@other.com', 'Second', NOW);
    const { notified } = createShare(otherScope, 'intruder@other.com', { what: 'x', priority: 'fyi' }, NOW);
    expect(notified).toBe(1); // second@other.com only — never team A's 3 members
  });
});

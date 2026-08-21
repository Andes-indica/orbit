import { describe, expect, test } from 'bun:test';
import {
  collectCommitsInRange,
  groupByArea,
  isMainReleasePR,
  renderNotes,
  selectDatedTag,
  selectLatestPublishedRelease,
} from '../../../scripts/release-notes';

const pr = (overrides: Record<string, unknown> = {}) => ({
  number: 1,
  title: 'Improve release workflow',
  html_url: 'https://github.com/Noveum/orbit/pull/1',
  body: null,
  labels: [],
  merged_at: '2026-08-21T00:00:00Z',
  base: { ref: 'main' },
  ...overrides,
});

describe('release notes grouping', () => {
  test('groups area labels and keeps unlabelled PRs in Other', () => {
    const result = groupByArea([
      pr({ number: 1, labels: [{ name: 'area:release' }] }),
      pr({ number: 2, labels: [] }),
    ]);

    expect(result.areas['area:release']?.map((item) => item.number)).toEqual([1]);
    expect(result.areas['Other']?.map((item) => item.number)).toEqual([2]);
    expect(result.breaking).toEqual([]);
  });

  test('accepts only PRs merged into main', () => {
    expect(isMainReleasePR(pr({ base: { ref: 'main' } }))).toBe(true);
    expect(isMainReleasePR(pr({ base: { ref: 'develop' } }))).toBe(false);
  });

  test('detects breaking changes from labels and body', () => {
    const result = groupByArea([
      pr({ number: 1, labels: [{ name: 'breaking change' }] }),
      pr({ number: 2, body: 'BREAKING CHANGE: update the API' }),
    ]);

    expect(result.breaking.map((item) => item.number)).toEqual([1, 2]);
  });
});

describe('release range pagination', () => {
  test('stops exactly at the base commit across pages', async () => {
    const commits = await collectCommitsInRange('base', [
      Array.from({ length: 100 }, (_, index) => ({ sha: `commit-${index}` })),
      [{ sha: 'commit-100' }, { sha: 'base' }, { sha: 'older' }],
    ]);

    expect(commits).toHaveLength(101);
    expect(commits.at(-1)?.sha).toBe('commit-100');
  });

  test('does not silently stop at a short page before finding the base', () => {
    expect(() => collectCommitsInRange('base', [[{ sha: 'commit-1' }]])).toThrow(
      'was not found in the main history',
    );
  });
});

describe('published release boundary selection', () => {
  test('ignores drafts, prereleases, and unrelated tags', () => {
    const latest = selectLatestPublishedRelease([
      {
        tag_name: '2026.08.20',
        draft: false,
        prerelease: false,
        published_at: '2026-08-20T00:00:00Z',
      },
      { tag_name: '2026.08.21', draft: true, prerelease: false, published_at: null },
      { tag_name: 'v1.0.0', draft: false, prerelease: false, published_at: '2026-08-21T00:00:00Z' },
      {
        tag_name: '2026.08.19',
        draft: false,
        prerelease: true,
        published_at: '2026-08-19T00:00:00Z',
      },
    ]);

    expect(latest?.tag_name).toBe('2026.08.20');
  });

  test('uses publication time rather than array order', () => {
    const latest = selectLatestPublishedRelease([
      {
        tag_name: '2026.08.20',
        draft: false,
        prerelease: false,
        published_at: '2026-08-20T00:00:00Z',
      },
      {
        tag_name: '2026.08.21',
        draft: false,
        prerelease: false,
        published_at: '2026-08-21T00:00:00Z',
      },
    ]);

    expect(latest?.tag_name).toBe('2026.08.21');
  });
});

describe('dated tag selection', () => {
  test('recovers an orphan tag on the same day when it points at the target', () => {
    expect(selectDatedTag('2026.08.21', 'target', { '2026.08.21': 'target' })).toEqual({
      tag: '2026.08.21',
      reuse: true,
    });
  });

  test('does not create a suffix for a same-day retry of the same target', () => {
    expect(
      selectDatedTag('2026.08.21', 'target', {
        '2026.08.21': 'target',
        '2026.08.21-1': 'other',
      }),
    ).toEqual({ tag: '2026.08.21', reuse: true });
  });

  test('uses the next suffix when an existing dated tag targets another commit', () => {
    expect(selectDatedTag('2026.08.21', 'target', { '2026.08.21': 'other' })).toEqual({
      tag: '2026.08.21-1',
      reuse: false,
    });
  });
});

describe('release notes rendering', () => {
  test('includes the exact release range', () => {
    const notes = renderNotes([pr()], 'base123', 'target456');
    expect(notes).toContain('Changes: base123..target456');
  });

  test('includes breaking-change guidance', () => {
    const notes = renderNotes(
      [pr({ body: 'BREAKING CHANGE: migrate this setting' })],
      'base123',
      'target456',
    );
    expect(notes).toContain(
      'Action required: review the linked pull requests for database migrations',
    );
  });

  test('reports an empty exact range without referring to a wall-clock cutoff', () => {
    const notes = renderNotes([], 'base123', 'target456');
    expect(notes).toContain('No merged pull requests found in this release range.');
    expect(notes).not.toContain('since the last tag');
  });
});

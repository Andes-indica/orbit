#!/usr/bin/env bun
import { writeFile } from 'node:fs/promises';

type Label = { name: string };
type PullRequest = {
  number: number;
  title: string;
  html_url: string;
  body?: string | null;
  labels?: Label[];
  merged_at?: string | null;
  updated_at: string;
};

const repo = process.env['GITHUB_REPOSITORY'];
const token = process.env['GITHUB_TOKEN'];

const githubSha = process.env['GITHUB_SHA'] || '';

if (!repo) {
  console.error('GITHUB_REPOSITORY is not set');
  process.exitCode = 2;
  throw new Error('GITHUB_REPOSITORY is not set');
}

async function getSinceDate(): Promise<string> {
  const lastTag = await getLastTag();

  if (!lastTag) {
    return new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  }

  const proc = Bun.spawn(['git', 'log', '-1', '--format=%cI', lastTag], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = await new Response(proc.stdout).text();
  const error = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0 || !output.trim()) {
    throw new Error(`Failed to determine date for tag ${lastTag}: ${error.trim()}`);
  }

  return output.trim();
}
const [owner, repoName] = repo.split('/');

const headers: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'orbit-release-bot',
};
if (token) headers['Authorization'] = `token ${token}`;

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Request failed ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}
async function getLastTag(): Promise<string | null> {
  const proc = Bun.spawn(['git', 'describe', '--tags', '--abbrev=0'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = await new Response(proc.stdout).text();
  const error = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    if (error.trim()) {
      console.warn(`Could not determine last tag: ${error.trim()}`);
    }
    return null;
  }

  return output.trim() || null;
}

async function fetchPageOfPRs(page: number): Promise<PullRequest[]> {
  const url = `https://api.github.com/repos/${owner}/${repoName}/pulls?state=closed&per_page=100&sort=updated&direction=desc&page=${page}`;
  const data = await fetchJson(url);
  if (!Array.isArray(data)) return [];
  return data as PullRequest[];
}

async function collectMergedPRs(since: string): Promise<PullRequest[]> {
  const merged: PullRequest[] = [];
  const sinceDate = new Date(since);
  for (let page = 1; ; page++) {
    const pagePRs = await fetchPageOfPRs(page);
    if (pagePRs.length === 0) break;
    for (const p of pagePRs) {
      if (new Date(p.updated_at) < sinceDate) return merged;

      if (!p.merged_at) continue;

      if (new Date(p.merged_at) >= sinceDate) {
        merged.push(p);
      }
    }
    if (pagePRs.length < 100) break;
  }
  return merged;
}

function groupByArea(prs: PullRequest[]) {
  const areas: Record<string, PullRequest[]> = {};
  const breaking: PullRequest[] = [];
  for (const p of prs) {
    const labels = (p.labels || []).map((l) => l.name);
    const body: string = p.body || '';
    const hasBreakingLabel = labels.some((n) => n.toLowerCase() === 'breaking change');
    const hasBreakingBody = /BREAKING CHANGE/.test(body);
    if (hasBreakingLabel || hasBreakingBody) {
      breaking.push(p);
      continue;
    }
    const area = labels.find((n) => n.startsWith('area:')) || 'Other';
    areas[area] = areas[area] || [];
    areas[area].push(p);
  }
  return { areas, breaking };
}

function renderNotes(prs: PullRequest[]): string {
  const { areas, breaking } = groupByArea(prs);
  let body = `Automated release for ${githubSha}\n\n`;

  if (breaking.length) {
    body += '## Breaking changes\n';
    for (const pr of breaking) {
      body += `- ${pr.title} (#${pr.number}) ${pr.html_url}\n`;
      if (pr.body) {
        const excerpt = pr.body.split(/\r?\n/).slice(0, 6).join('\n  ');
        body += `\n  ${excerpt}\n`;
      }
    }
    body += '\n';
  }

  const areaNames = Object.keys(areas).sort();
  for (const area of areaNames) {
    const title = area.replace('area:', 'Area: ');
    body += `## ${title}\n`;
    for (const pr of areas[area] ?? []) {
      body += `- ${pr.title} (#${pr.number}) ${pr.html_url}\n`;
    }
    body += '\n';
  }

  if (!breaking.length && areaNames.length === 0) {
    body += 'No merged pull requests found since the last tag.\n';
  }

  return body;
}

async function main(): Promise<void> {
  const since = await getSinceDate();
  const prs = await collectMergedPRs(since);
  const notes = renderNotes(prs);
  await writeFile('RELEASE_NOTES.md', notes, 'utf8');
  console.log('WROTE RELEASE_NOTES.md');
}

main().catch((err: unknown) => {
  console.error('Failed to generate release notes:', err);
  process.exitCode = 2;
});

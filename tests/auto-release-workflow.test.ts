import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../.github/workflows/auto-release.yml', import.meta.url);

const scriptPath = new URL('../scripts/release-notes.ts', import.meta.url);

const workflow = await readFile(workflowPath, 'utf8');
const script = await readFile(scriptPath, 'utf8');

describe('automated release workflow contract', () => {
  test('connects every generator output to the workflow', () => {
    expect(script).toContain("writeGitHubOutput('tag', selectedTag.tag)");
    expect(script).toContain("writeGitHubOutput('tag_action', selectedTag.action)");
    expect(script).toContain("'release_target_sha',");

    expect(workflow).toMatch(/TAG="\$\{\{\s*steps\.build_notes\.outputs\.tag\s*\}\}"/);
    expect(workflow).toMatch(
      /TAG_ACTION="\$\{\{\s*steps\.build_notes\.outputs\.tag_action\s*\}\}"/,
    );
    expect(workflow).toMatch(
      /RELEASE_TARGET_SHA:\s*\$\{\{\s*steps\.build_notes\.outputs\.release_target_sha\s*\}\}/,
    );
  });

  test('passes the selected tag into the publish step', () => {
    expect(workflow).toMatch(/TAG:\s*\$\{\{\s*steps\.release_tag\.outputs\.tag\s*\}\}/);
    expect(workflow).toContain('echo "tag=$TAG" >> "$GITHUB_OUTPUT"');
  });

  test('keeps checkout credentials disabled and scopes mutation credentials', () => {
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toMatch(/GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
    expect(workflow).toContain(
      'REPOSITORY_URL="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"',
    );
  });

  test('recovers orphan tags without moving them', () => {
    expect(workflow).toContain('reuse|recover)');
    expect(workflow).not.toContain('repair)');
    expect(workflow).not.toContain('--force-with-lease');
    expect(workflow).not.toContain('git tag -fa');
    expect(workflow).not.toContain('RELEASE_STATUS');

    expect(workflow).toContain('git tag -a "$TAG" "$RELEASE_TARGET_SHA"');
  });
});

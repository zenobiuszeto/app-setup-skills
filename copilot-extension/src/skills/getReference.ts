import fs   from 'fs';
import path from 'path';

const VALID_TOPICS = [
  'api-design',
  'core-java',
  'persistence',
  'kafka',
  'observability',
  'cicd-github-actions',
  'gatling-perf',
  'jfr-profiling',
  'project-scaffold',
] as const;

type Topic = (typeof VALID_TOPICS)[number];

/**
 * Skill: get_reference
 *
 * Returns the full Markdown content of a reference guide from the
 * references/ folder in this workspace.
 *
 * Resolution order:
 *   1. REFERENCES_PATH env var (absolute path) — use when deployed remotely
 *   2. Local filesystem relative to this extension: ../../references
 *      (correct when running inside the workspace as `copilot-extension/`)
 *
 * For GitHub API–based reading (when deployed outside the repo), set:
 *   GITHUB_REPO=owner/repo
 * and pass the token via the `github_token` argument.
 */
export async function getReference(
  topic: string,
  githubToken?: string,
): Promise<string> {
  if (!VALID_TOPICS.includes(topic as Topic)) {
    return [
      `❌ Unknown reference topic: \`${topic}\``,
      '',
      `**Available topics:** ${VALID_TOPICS.join(', ')}`,
    ].join('\n');
  }

  // ── Strategy 1: GitHub Contents API ─────────────────────────────────────────
  if (githubToken && process.env.GITHUB_REPO) {
    const result = await fetchFromGitHub(topic, githubToken);
    if (result) return `## Reference: \`${topic}\`\n\n${result}`;
  }

  // ── Strategy 2: Local filesystem ─────────────────────────────────────────────
  const refsDir =
    process.env.REFERENCES_PATH ||
    path.resolve(__dirname, '..', '..', '..', 'references');

  const filePath = path.join(refsDir, `${topic}.md`);

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return `## Reference: \`${topic}\`\n\n${content}`;
  } catch {
    return [
      `⚠️  Could not load reference file: \`${filePath}\``,
      '',
      '**Troubleshooting:**',
      '- Set `REFERENCES_PATH` env var to the absolute path of the `references/` folder.',
      '- Or set `GITHUB_REPO=owner/repo` to load via the GitHub API.',
      `- Current resolved path: \`${refsDir}\``,
    ].join('\n');
  }
}

async function fetchFromGitHub(
  topic: string,
  token: string,
): Promise<string | null> {
  const [owner, repo] = (process.env.GITHUB_REPO ?? '').split('/');
  if (!owner || !repo) return null;

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/references/${topic}.md`;

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.raw+json',
        'User-Agent': 'java-backend-copilot-extension/1.0',
      },
    });

    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

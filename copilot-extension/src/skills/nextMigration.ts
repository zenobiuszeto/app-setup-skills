/**
 * Skill: next_flyway_version
 *
 * Parses existing Flyway migration filenames, determines the next sequential
 * version, and returns a ready-to-use filename + DDL skeleton.
 * Convention: V{N}__{description}.sql  (see references/persistence.md)
 */
export function nextFlywayVersion(existingFiles: string, description: string): string {
  // Parse the comma-separated list of filenames
  const files = existingFiles
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);

  // Extract version numbers — support both integer (V1) and decimal (V1.1) versions
  const versions = files
    .map((f) => {
      const m = f.match(/^V(\d+(?:\.\d+)?)__/i);
      return m ? parseFloat(m[1]) : null;
    })
    .filter((v): v is number => v !== null);

  const maxVersion = versions.length > 0 ? Math.max(...versions) : 0;
  const nextVersion = Math.floor(maxVersion) + 1;

  // Normalise description to snake_case
  const safeDesc = description
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^_+|_+$/g, '');

  const filename = `V${nextVersion}__${safeDesc}.sql`;

  // Derive a plausible table name from the description for the DDL skeleton
  const tableName = safeDesc
    .replace(/^(create|add|alter|drop|update)_/, '')
    .replace(/_table$/, '');

  const lines: string[] = [
    `## Next Flyway Migration`,
    '',
    `| | |`,
    `|---|---|`,
    `| **Suggested filename** | \`${filename}\` |`,
    `| **Version number** | V${nextVersion} |`,
    `| **Location** | \`src/main/resources/db/migration/${filename}\` |`,
    '',
  ];

  if (files.length > 0) {
    lines.push(`### Existing migrations (${files.length})`);
    files.forEach((f) => lines.push(`- \`${f}\``));
    lines.push('');
  }

  lines.push(
    `### DDL Skeleton`,
    '```sql',
    `-- ${filename}`,
    ``,
    `CREATE TABLE ${tableName} (`,
    `    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),`,
    `    -- TODO: add your columns here`,
    `    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),`,
    `    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()`,
    `);`,
    ``,
    `-- Always index columns you filter/sort by`,
    `CREATE INDEX idx_${tableName}_created_at ON ${tableName} (created_at);`,
    '```',
    '',
    `> **Convention:** \`V{N}__{description}.sql\` — double underscore, snake_case description.`,
    `> Always add indexes on columns used in \`WHERE\`, \`ORDER BY\`, or \`JOIN\` clauses.`,
  );

  return lines.join('\n');
}

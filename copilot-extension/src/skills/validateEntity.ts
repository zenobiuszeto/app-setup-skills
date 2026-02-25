/**
 * Skill: validate_jpa_entity
 *
 * Statically analyses a JPA entity Java source file against the project's
 * conventions (see references/persistence.md).
 */

interface ValidationResult {
  issues:   string[];
  warnings: string[];
  passes:   string[];
}

export function validateJpaEntity(sourceCode: string, className: string): string {
  const r: ValidationResult = { issues: [], warnings: [], passes: [] };

  // ── Rule 1: No @Data ────────────────────────────────────────────────────────
  // @Data generates equals/hashCode based on ALL fields, breaking Hibernate proxies.
  if (/@Data\b/.test(sourceCode)) {
    r.issues.push(
      '❌ **@Data detected** — remove it from JPA entities. ' +
      '@Data generates `equals/hashCode` using all fields, which causes identity ' +
      'issues with Hibernate proxy objects. Use `@Getter @Setter @Builder ' +
      '@NoArgsConstructor @AllArgsConstructor` individually instead.',
    );
  } else {
    r.passes.push('✅ No `@Data` annotation.');
  }

  // ── Rule 2: @EqualsAndHashCode(onlyExplicitlyIncluded = true) ───────────────
  if (!/@EqualsAndHashCode\s*\(\s*onlyExplicitlyIncluded\s*=\s*true\s*\)/.test(sourceCode)) {
    r.issues.push(
      '❌ **Missing `@EqualsAndHashCode(onlyExplicitlyIncluded = true)`** — ' +
      'required so that only the `@Id` field is included in equals/hashCode.',
    );
  } else {
    r.passes.push('✅ `@EqualsAndHashCode(onlyExplicitlyIncluded = true)` present.');
  }

  // ── Rule 3: @EqualsAndHashCode.Include on the @Id field ─────────────────────
  // Find the block between @Id and the next field/method declaration
  const idRegion = sourceCode.match(/@Id\b[\s\S]{0,300}?(?=\n\s*(?:@|private|public|protected))/);
  if (idRegion) {
    if (!/@EqualsAndHashCode\.Include/.test(idRegion[0])) {
      r.issues.push(
        '❌ **`@EqualsAndHashCode.Include` not on `@Id` field** — ' +
        'place `@EqualsAndHashCode.Include` directly above the `private UUID id;` field.',
      );
    } else {
      r.passes.push('✅ `@EqualsAndHashCode.Include` is on the `@Id` field.');
    }
  } else if (/@EqualsAndHashCode\.Include/.test(sourceCode)) {
    r.passes.push('✅ `@EqualsAndHashCode.Include` found (could not verify position).');
  } else {
    r.warnings.push('⚠️  No `@Id` field region detected — ensure the entity has a UUID primary key.');
  }

  // ── Rule 4: GenerationType.UUID ─────────────────────────────────────────────
  if (/@GeneratedValue\b/.test(sourceCode)) {
    if (!/GenerationType\.UUID/.test(sourceCode)) {
      r.issues.push(
        '❌ **`@GeneratedValue` does not use `GenerationType.UUID`** — ' +
        'use `@GeneratedValue(strategy = GenerationType.UUID)` for distributed-friendly IDs (JPA 3.1+).',
      );
    } else {
      r.passes.push('✅ `GenerationType.UUID` used for ID generation.');
    }
  } else {
    r.warnings.push(
      '⚠️  No `@GeneratedValue` found — add ' +
      '`@GeneratedValue(strategy = GenerationType.UUID)` to the `@Id` field.',
    );
  }

  // ── Rule 5: @Builder.Default on collection fields ───────────────────────────
  const collectionFieldRegex = /(List|Set|Map)<[^>]+>\s+\w+\s*[=;]/g;
  let match: RegExpExecArray | null;
  let foundCollectionIssue = false;

  while ((match = collectionFieldRegex.exec(sourceCode)) !== null) {
    const fieldStart = match.index;
    const preceding = sourceCode.slice(Math.max(0, fieldStart - 250), fieldStart);

    // Ignore @Transient fields — they don't participate in persistence
    if (/@Transient/.test(preceding)) continue;

    if (!/@Builder\.Default/.test(preceding)) {
      r.warnings.push(
        `⚠️  Collection field \`${match[0].trim()}\` appears to be missing **\`@Builder.Default\`**. ` +
        "Without it, Lombok's builder sets collections to `null` instead of an empty collection, " +
        'causing `NullPointerException` in callers.',
      );
      foundCollectionIssue = true;
    }
  }

  if (!foundCollectionIssue && /@Builder\.Default/.test(sourceCode)) {
    r.passes.push('✅ `@Builder.Default` found on collection fields.');
  }

  // ── Rule 6: Lifecycle timestamps ─────────────────────────────────────────────
  const hasPrePersist = /@PrePersist\b/.test(sourceCode);
  const hasCreatedDate = /@CreatedDate\b/.test(sourceCode);
  const hasPreUpdate  = /@PreUpdate\b/.test(sourceCode);
  const hasModifiedDate = /@LastModifiedDate\b/.test(sourceCode);

  if (!hasPrePersist && !hasCreatedDate) {
    r.warnings.push(
      '⚠️  No audit timestamp strategy detected. Add either:\n' +
      '  - `@PrePersist` / `@PreUpdate` lifecycle hooks, or\n' +
      '  - `@CreatedDate` / `@LastModifiedDate` with `@EnableJpaAuditing`.',
    );
  } else {
    const strategy = hasCreatedDate || hasModifiedDate ? '@CreatedDate/@LastModifiedDate' : '@PrePersist/@PreUpdate';
    r.passes.push(`✅ Lifecycle timestamps via ${strategy}.`);
  }

  // ── Rule 7: open-in-view advisory ───────────────────────────────────────────
  r.warnings.push(
    'ℹ️  Reminder: verify `spring.jpa.open-in-view: false` is set in `application.yml`. ' +
    'OSIV keeps the Hibernate session alive for the whole HTTP request, masking N+1 bugs.',
  );

  // ── Build report ─────────────────────────────────────────────────────────────
  const lines: string[] = [
    `## JPA Entity Validation Report: \`${className}\``,
    '',
  ];

  if (r.issues.length > 0) {
    lines.push(`### ❌ Critical Issues (${r.issues.length})`);
    r.issues.forEach((i) => lines.push(i, ''));
  }

  if (r.warnings.length > 0) {
    lines.push(`### ⚠️  Warnings (${r.warnings.length})`);
    r.warnings.forEach((w) => lines.push(w, ''));
  }

  if (r.passes.length > 0) {
    lines.push(`### ✅ Passing Checks (${r.passes.length})`);
    r.passes.forEach((p) => lines.push(p));
    lines.push('');
  }

  lines.push(
    r.issues.length === 0
      ? '**✅ Entity passes all critical checks.**'
      : `**❌ ${r.issues.length} critical issue(s) found — fix before merging.**`,
  );

  return lines.join('\n');
}

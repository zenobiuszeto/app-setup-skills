/**
 * Skill: check_kafka_topic
 *
 * Checks whether a Kafka topic (and its companion DLT) are declared via
 * TopicBuilder in a KafkaTopicConfig source file.
 * Convention: see references/kafka.md — Topic Management section.
 */
export function checkKafkaTopic(topicName: string, configSource: string): string {
  const lines: string[] = [`## Kafka Topic Check: \`${topicName}\``, ''];
  const dltName = `${topicName}.DLT`;

  // ── Main topic ──────────────────────────────────────────────────────────────
  const mainTopicDeclared =
    new RegExp(`TopicBuilder\\.name\\s*\\(\\s*["']${esc(topicName)}["']`).test(configSource) ||
    new RegExp(`["']${esc(topicName)}["']`).test(configSource);

  const usesTopicBuilder =
    new RegExp(`TopicBuilder\\.name\\s*\\(\\s*["']${esc(topicName)}["']`).test(configSource);

  if (mainTopicDeclared) {
    lines.push(`✅ Topic \`${topicName}\` is declared.`);
    if (usesTopicBuilder) {
      lines.push('✅ Uses `TopicBuilder.name(...)` pattern (declarative — correct).');
    }
  } else {
    lines.push(`❌ Topic \`${topicName}\` is **NOT declared** in KafkaTopicConfig.`);
    lines.push('');
    lines.push('**Add this `@Bean` to your `KafkaTopicConfig`:**');
    lines.push('```java');
    lines.push('@Bean');
    lines.push(`public NewTopic ${toCamelCase(topicName)}Topic() {`);
    lines.push(`    return TopicBuilder.name("${topicName}")`);
    lines.push('            .partitions(6)          // match consumer concurrency');
    lines.push('            .replicas(3)            // production replication factor');
    lines.push('            .config(TopicConfig.RETENTION_MS_CONFIG,');
    lines.push('                    String.valueOf(Duration.ofDays(7).toMillis()))');
    lines.push('            .build();');
    lines.push('}');
    lines.push('```');
  }

  lines.push('');

  // ── DLT topic ───────────────────────────────────────────────────────────────
  const dltDeclared =
    new RegExp(`TopicBuilder\\.name\\s*\\(\\s*["']${esc(dltName)}["']`).test(configSource) ||
    new RegExp(`["']${esc(dltName)}["']`).test(configSource);

  if (dltDeclared) {
    lines.push(`✅ DLT topic \`${dltName}\` is declared.`);
  } else {
    lines.push(`⚠️  DLT topic \`${dltName}\` is **not declared**.`);
    lines.push('');
    lines.push(
      'The `DefaultErrorHandler` sends failed messages to `{topic}.DLT` after exhausting retries. ' +
      'Without this bean, the DLT will be auto-created with default settings (1 partition, no retention).',
    );
    lines.push('');
    lines.push('**Add the DLT `@Bean`:**');
    lines.push('```java');
    lines.push('@Bean');
    lines.push(`public NewTopic ${toCamelCase(topicName)}DltTopic() {`);
    lines.push(`    return TopicBuilder.name("${dltName}")`);
    lines.push('            .partitions(1)');
    lines.push('            .replicas(3)');
    lines.push('            .build();');
    lines.push('}');
    lines.push('```');
  }

  lines.push('');

  // ── Configuration quality checks ─────────────────────────────────────────────
  const hasPartitions = /\.partitions\s*\(\s*\d+\s*\)/.test(configSource);
  const hasReplicas   = /\.replicas\s*\(\s*\d+\s*\)/.test(configSource);
  const hasRetention  = /RETENTION_MS_CONFIG/.test(configSource);

  if (!hasPartitions) {
    lines.push('⚠️  No explicit `.partitions(N)` found — set partition count equal to your consumer concurrency setting.');
  }
  if (!hasReplicas) {
    lines.push('⚠️  No explicit `.replicas(N)` found — set to `3` for production resilience.');
  }
  if (!hasRetention) {
    lines.push('ℹ️  Consider setting `RETENTION_MS_CONFIG` (e.g., 7 days) to control disk usage.');
  }

  if (hasPartitions && hasReplicas) {
    lines.push('✅ Partition count and replica factor are explicitly configured.');
  }

  return lines.join('\n');
}

/** Escape special regex characters in a string */
function esc(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Convert kebab-case / dot.case to lowerCamelCase for Java method names */
function toCamelCase(str: string): string {
  return str.replace(/[-.](.)/g, (_, c: string) => (c as string).toUpperCase());
}

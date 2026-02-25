import type { ToolDefinition } from '../types';
import { validateJpaEntity }  from './validateEntity';
import { nextFlywayVersion }  from './nextMigration';
import { checkKafkaTopic }    from './checkKafkaTopic';
import { getReference }       from './getReference';

// ── Tool definitions (sent to the Copilot model on every request) ────────────

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'validate_jpa_entity',
      description:
        'Validates a JPA entity Java class against project conventions. ' +
        'Checks for: @Data misuse, correct @EqualsAndHashCode usage, ' +
        'GenerationType.UUID for IDs, @Builder.Default on collection fields, ' +
        'and missing @PrePersist/@PreUpdate lifecycle hooks.',
      parameters: {
        type: 'object',
        properties: {
          source_code: {
            type: 'string',
            description: 'Full Java source code of the JPA entity to validate.',
          },
          class_name: {
            type: 'string',
            description: 'Simple class name of the entity, e.g. "Order".',
          },
        },
        required: ['source_code', 'class_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'next_flyway_version',
      description:
        'Given a comma-separated list of existing Flyway migration filenames, ' +
        'returns the next available version number and a ready-to-use filename template ' +
        'with a DDL skeleton.',
      parameters: {
        type: 'object',
        properties: {
          existing_files: {
            type: 'string',
            description:
              'Comma-separated existing migration filenames. ' +
              'Example: "V1__create_users.sql,V2__add_orders.sql,V3__add_indexes.sql"',
          },
          description: {
            type: 'string',
            description: 'Short snake_case description of the new migration, e.g. "add_payment_table".',
          },
        },
        required: ['existing_files', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_kafka_topic',
      description:
        'Checks whether a Kafka topic (and its DLT) are declared in a KafkaTopicConfig ' +
        'source file. Returns a pass/fail report and, on failure, provides the missing ' +
        'TopicBuilder bean snippet.',
      parameters: {
        type: 'object',
        properties: {
          topic_name: {
            type: 'string',
            description: 'Kafka topic name to check, e.g. "order-events".',
          },
          config_source: {
            type: 'string',
            description: 'Full Java source code of the KafkaTopicConfig class.',
          },
        },
        required: ['topic_name', 'config_source'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_reference',
      description:
        'Retrieves the full content of a project reference guide. Use this to look up ' +
        'conventions, patterns, and code templates before generating or reviewing code.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description:
              'Reference topic to retrieve. Must be one of: ' +
              'api-design, core-java, persistence, kafka, observability, ' +
              'cicd-github-actions, gatling-perf, jfr-profiling, project-scaffold',
          },
        },
        required: ['topic'],
      },
    },
  },
];

// ── Dispatcher ───────────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  args: Record<string, string>,
): Promise<string> {
  switch (name) {
    case 'validate_jpa_entity':
      return validateJpaEntity(args.source_code, args.class_name);

    case 'next_flyway_version':
      return nextFlywayVersion(args.existing_files, args.description);

    case 'check_kafka_topic':
      return checkKafkaTopic(args.topic_name, args.config_source);

    case 'get_reference':
      return getReference(args.topic);

    default:
      return `❌ Unknown skill: "${name}". Available: validate_jpa_entity, next_flyway_version, check_kafka_topic, get_reference`;
  }
}

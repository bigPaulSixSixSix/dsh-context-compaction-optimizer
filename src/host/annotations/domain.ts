/**
 * Storage Domain declaration for operator annotations.
 *
 * Field choices are pinned by M0 findings rather than preference:
 *
 * - `layout: 'per-record'` — Spike 3 (`01开发日志.md` N008) opened exactly this
 *   shape and wrote a real `MessageId` as the key. It lands as
 *   `$DSH_HOME/storages/cco_annotations/annotations/<key>.json`, so one
 *   annotation is one small file: a corrupt record cannot take the rest of the
 *   annotations down with it.
 * - `invalidRecords: 'backup-and-skip'` — a record that fails the schema is
 *   moved aside rather than aborting the whole domain, matching the first-party
 *   `session_projcache` precedent.
 * - `version` is the domain's own schema generation, independent of the
 *   package version, so an annotation file written by an older build is either
 *   accepted or quarantined — never silently reinterpreted.
 *
 * @module dsh-context-compaction-optimizer/host/annotations/domain
 */

import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';

/** Domain unit name. Must match the storage layer's `^[a-z][a-z0-9_]*$`. */
export const ANNOTATION_DOMAIN_NAME = 'cco_annotations';

/** Bump when the stored record shape changes incompatibly. */
export const ANNOTATION_DOMAIN_VERSION = 1;

/** Stored status: `unmarked` is represented by absence, never persisted. */
export const storedStatusSchema = z.enum(['valid', 'invalid']);

/** How an annotation came to exist. */
export const annotationSourceSchema = z.enum(['user', 'system', 'import']);

/**
 * One persisted annotation.
 *
 * `sessionId` is stored alongside the key even though the key already encodes
 * it: the value stays self-describing, so an export, a backup, or a manual
 * inspection never needs the key rule to be known.
 */
export const annotationRecordSchema = z
  .object({
    sessionId: z.string().min(1),
    status: storedStatusSchema,
    updatedAt: z.number().int().nonnegative(),
    source: annotationSourceSchema,
  })
  .strict();

/** Inferred stored record type. */
export type StoredAnnotationRecord = z.infer<typeof annotationRecordSchema>;

/**
 * The annotation domain.
 *
 * Only one table exists: everything the plugin needs is derivable from the
 * records themselves, and keeping a second table would create a second source of
 * truth that could drift.
 */
export const annotationDomainSpec = defineDomain({
  name: ANNOTATION_DOMAIN_NAME,
  version: ANNOTATION_DOMAIN_VERSION,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    annotations: domainTable(annotationRecordSchema),
  },
});

/** Resolved domain spec type, for adapter signatures. */
export type AnnotationDomainSpec = typeof annotationDomainSpec;

import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { canonicalJson, partGroupName, partTypeDefinitionSchema, partTypeIssues, type PartTypeDefinition } from '@permitzip/bim-kernel'
import type { EditorPartPublishReceipt } from '@permitzip/bim-editor-host'
import { drawnPartItemId, sizeHashes, type LibraryPartTypeEntry } from '@permitzip/bim-editor/contracts/bim/firm-part-versions'

type Outcome = 'saved' | 'up_to_date'

function success(receipt: EditorPartPublishReceipt, outcome: Outcome) {
  const revision = receipt.revision
  return { status: 200, body: outcome === 'saved'
    ? { status: outcome, summary: { revision }, receipt }
    : { status: outcome, revision, receipt } }
}

/** One local, file-backed catalog shared by every project using this demo server. */
export class LocalFirmParts {
  readonly id: string
  private readonly db: DatabaseSync

  constructor(file: string) {
    const db = new DatabaseSync(file)
    this.db = db
    try {
      db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS firm_parts_catalog (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS firm_part_revisions (
          family TEXT NOT NULL, revision INTEGER NOT NULL, definition TEXT NOT NULL, sizes TEXT NOT NULL,
          PRIMARY KEY (family, revision)
        );
        CREATE TABLE IF NOT EXISTS firm_part_receipts (
          request_id TEXT PRIMARY KEY, family TEXT NOT NULL, base INTEGER NOT NULL, payload_hash TEXT NOT NULL,
          revision INTEGER NOT NULL, outcome TEXT NOT NULL CHECK (outcome IN ('saved','up_to_date')),
          FOREIGN KEY (family, revision) REFERENCES firm_part_revisions (family, revision)
        );
      `)
      db.prepare('INSERT OR IGNORE INTO firm_parts_catalog VALUES (1, ?)').run(randomUUID())
      this.id = String(db.prepare('SELECT id FROM firm_parts_catalog WHERE singleton = 1').get()!.id)
    } catch (err) {
      db.close()
      throw err
    }
  }

  close() { this.db.close() }

  list(): { canPublish: true; partTypes: LibraryPartTypeEntry[] } {
    const entries: LibraryPartTypeEntry[] = []
    const rows = this.db.prepare(`
      SELECT family, revision, sizes, CASE WHEN revision = (
        SELECT MAX(head.revision) FROM firm_part_revisions head WHERE head.family = r.family
      ) THEN definition END AS latest
      FROM firm_part_revisions r ORDER BY family, revision DESC
    `).all()
    let history: { revision: number; sizes: Record<string, string> }[] = []
    for (const row of rows) {
      const key = String(row.family)
      const revision = Number(row.revision)
      if (typeof row.latest === 'string') {
        const definition: PartTypeDefinition = JSON.parse(row.latest)
        history = []
        entries.push({ id: drawnPartItemId(key), key, name: partGroupName(definition), revision, definition, revisions: history, scope: 'firm', provenance: null })
      }
      history.push({ revision, sizes: JSON.parse(String(row.sizes)) })
    }
    return { canPublish: true, partTypes: entries }
  }

  publish(input: unknown): { status: number; body: unknown } {
    if (!input || typeof input !== 'object' || !('requestId' in input) || typeof input.requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) || !('baseRevision' in input) ||
        typeof input.baseRevision !== 'number' || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0 || !('definition' in input)) {
      return { status: 400, body: { error: 'A publish needs a request ID, a nonnegative base revision and a part definition.' } }
    }
    const { requestId, baseRevision } = input
    const payloadHash = createHash('sha256').update(canonicalJson(input.definition)).digest('hex')
    const db = this.db
    db.exec('BEGIN IMMEDIATE')
    try {
      // Read the receipt first, even if a later writer has already advanced the family.
      const prior = db.prepare('SELECT * FROM firm_part_receipts WHERE request_id = ?').get(requestId)
      if (prior) {
        db.exec('COMMIT')
        if (prior.base !== baseRevision || prior.payload_hash !== payloadHash) {
          return { status: 422, body: { error: 'This publish ID already belongs to a different request.' } }
        }
        return success({ requestId, familyId: drawnPartItemId(String(prior.family)), baseRevision, revision: Number(prior.revision) }, prior.outcome as Outcome)
      }

      const parsed = partTypeDefinitionSchema.safeParse(input.definition)
      const family = parsed.success && parsed.data.model?.id
      if (!parsed.success || !family || parsed.data.source.kind === 'script') {
        db.exec('ROLLBACK')
        return { status: 400, body: { error: 'A firm part must have a valid drawn definition and family ID.' } }
      }
      const definition = parsed.data
      const issue = partTypeIssues(definition)[0]
      if (issue) {
        db.exec('ROLLBACK')
        return { status: 400, body: { error: issue.message } }
      }
      const head = db.prepare('SELECT revision, definition FROM firm_part_revisions WHERE family = ? ORDER BY revision DESC LIMIT 1').get(family)
      const currentRevision = Number(head?.revision ?? 0)
      if (baseRevision !== currentRevision) {
        db.exec('ROLLBACK')
        return { status: 409, body: { currentRevision } }
      }
      const content = canonicalJson(definition)
      const outcome: Outcome = content === head?.definition ? 'up_to_date' : 'saved'
      const revision = outcome === 'saved' ? currentRevision + 1 : currentRevision
      if (outcome === 'saved') {
        db.prepare('INSERT INTO firm_part_revisions (family,revision,definition,sizes) VALUES (?,?,?,?)')
          .run(family, revision, content, JSON.stringify(sizeHashes({ key: family, definition })))
      }
      db.prepare('INSERT INTO firm_part_receipts (request_id,family,base,payload_hash,revision,outcome) VALUES (?,?,?,?,?,?)')
        .run(requestId, family, baseRevision, payloadHash, revision, outcome)
      db.exec('COMMIT')
      return success({ requestId, familyId: drawnPartItemId(family), baseRevision, revision }, outcome)
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

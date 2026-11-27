/** @jest-environment node */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { exampleRooftopUnit } from '@permitzip/bim-kernel'
import { LocalFirmParts } from '../src/firm-parts'

it('rolls the revision back if its receipt cannot be stored, then accepts the same request on retry', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mutiny-parts-rollback-'))
  const file = path.join(dir, 'parts.sqlite')
  const catalog = new LocalFirmParts(file)
  const observer = new LocalFirmParts(file)
  const fixture = new DatabaseSync(file)
  try {
    const request = { definition: exampleRooftopUnit(), requestId: 'save-1', baseRevision: 0 }
    fixture.exec("CREATE TRIGGER refuse_receipt BEFORE INSERT ON firm_part_receipts BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END")
    expect(() => catalog.publish(request)).toThrow('fixture receipt failure')
    expect(observer.list().partTypes).toEqual([])
    expect(fixture.prepare('SELECT COUNT(*) AS n FROM firm_part_receipts').get()?.n).toBe(0)
    fixture.exec('DROP TRIGGER refuse_receipt')
    const result = observer.publish(request)
    expect(result).toMatchObject({ status: 200, body: { receipt: { revision: 1, requestId: 'save-1' } } })
    expect(catalog.publish(request)).toEqual(result)
    expect(catalog.list().partTypes[0]?.revisions).toHaveLength(1)
  } finally {
    fixture.close()
    observer.close()
    catalog.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

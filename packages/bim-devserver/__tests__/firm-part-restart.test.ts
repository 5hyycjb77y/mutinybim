/** @jest-environment node */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { exampleRooftopUnit } from '@permitzip/bim-kernel'
import { createDemoFirmParts } from '../../bim-editor/demo/local-firm-parts'

async function startServer(db: string, port = '0') {
  const child = spawn(process.execPath, ['--import', 'tsx', 'packages/bim-devserver/src/server.ts'], {
    cwd: path.resolve(__dirname, '../../..'),
    env: { ...process.env, BIM_DEV_AUTHORITY_URL: '', BIM_DEV_EDITOR: 'lazy', BIM_DEV_PORT: port, BIM_DEV_FIRM_PARTS_DB: db },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exit = once(child, 'exit')
  const stop = async () => { child.kill('SIGKILL'); await exit }
  let log = ''
  const ready = new Promise<string>((resolve, reject) => {
    child.stderr.on('data', chunk => { log += chunk })
    child.stdout.on('data', chunk => {
      log += chunk
      const match = log.match(/editor at (http:\/\/127\.0\.0\.1:\d+)\/m\//)
      if (match) resolve(match[1]!)
    })
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`Demo exited (${code}). ${log}`)))
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30000)
  try {
    return { origin: await ready, stop }
  } finally {
    clearTimeout(timeout)
  }
}

// The browser profile survives its editor instance. Reopening constructs a new client over these bytes.
function profile(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
    key: index => Array.from(values.keys())[index] ?? null,
    clear: () => values.clear(),
  }
}

it('recovers the original receipt after a lost reply, server restart, and another publish', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mutiny-parts-'))
  const db = path.join(dir, 'catalog.sqlite')
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    server = await startServer(db)
    const origin = server.origin
    const catalogId = async () => (await (await fetch(`${origin}/demo-config.json`)).json()).firmPartsId as string
    const id = await catalogId()
    expect(id).toEqual(expect.any(String))
    const endpoint = `${origin}/api/bim/library/part-types?library=${id}`
    const def = exampleRooftopUnit()
    const intent = (requestId: string, baseRevision: number, description: string) => ({ requestId, baseRevision, definition: { ...def, description } })
    const post = (input: unknown) => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    const request = intent('window-a', 2, 'A’s change')
    const next = intent('window-b', 3, 'B’s change')
    expect((await post(intent('first', 0, 'Original'))).status).toBe(200)
    expect((await post(intent('second', 1, 'Second'))).status).toBe(200)
    const browser = profile()
    let lostReply: unknown
    const author = createDemoFirmParts(id, 'Priya', () => browser, async (url, init) => {
      expect(browser.length).toBe(1)
      const response = await fetch(new URL(String(url), origin), init)
      expect(response.status).toBe(200)
      lostReply = await response.json() // The harness sees the committed reply. The editor never receives it.
      throw new TypeError('Connection closed before delivery')
    })
    await expect(author.publishPartTypeAtRevision(request)).rejects.toThrow('before delivery')
    expect(lostReply).toEqual({ status: 'saved', summary: { revision: 3 }, receipt: {
      requestId: request.requestId, familyId: `part:${def.model!.id}`, baseRevision: 2, revision: 3,
    } })
    expect(JSON.parse(browser.getItem(browser.key(0)!)!)).toEqual(request)

    await server.stop()
    server = undefined
    server = await startServer(db, new URL(origin).port)
    expect(await catalogId()).toBe(id)
    expect((await (await post(next)).json()).summary.revision).toBe(4)
    const wire: typeof fetch = (url, init) => fetch(new URL(String(url), origin), init)
    const report = jest.fn()
    await createDemoFirmParts(id, 'Avery', () => browser, wire).recoverPending(report)
    await createDemoFirmParts('another-catalog', 'Priya', () => browser, wire).recoverPending(report)
    expect(report).not.toHaveBeenCalled()
    expect(browser.length).toBe(1)

    let replayed: unknown
    const reopened = createDemoFirmParts(id, 'Priya', () => browser, async (url, init) => {
      const res = await wire(url, init)
      if (init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual(request)
        replayed = await res.clone().json()
      }
      return res
    })
    await reopened.recoverPending(report)
    expect(replayed).toEqual(lostReply)
    expect(report).toHaveBeenCalledWith(true, expect.stringContaining('revision 3'))
    expect(browser.length).toBe(0)

    const read = await (await reopened.partTypes()).json()
    expect(read.partTypes).toHaveLength(1)
    expect(read.partTypes[0]).toMatchObject({ revision: 4, definition: next.definition })
    expect(read.partTypes[0].revisions.map((r: { revision: number }) => r.revision)).toEqual([4, 3, 2, 1])
    expect(Object.keys(read.partTypes[0].revisions[3].sizes)).toHaveLength(3)
    expect((await post({ ...request, requestId: 'new-stale-id' })).status).toBe(409)
    expect((await post({ ...request, baseRevision: 4 })).status).toBe(422)
    expect((await post({ ...request, definition: next.definition })).status).toBe(422)
    expect((await (await post({ ...request, definition: Object.fromEntries(Object.entries(request.definition).reverse()) })).json())).toEqual(lostReply)
    const unchanged = { ...next, baseRevision: 4, requestId: 'unchanged' }
    const same = await (await post(unchanged)).json()
    expect(same).toMatchObject({ status: 'up_to_date', revision: 4, receipt: { requestId: 'unchanged', revision: 4 } })
    expect((await post(intent('fifth', 4, 'New head'))).status).toBe(200)
    expect(await (await post(unchanged)).json()).toEqual(same)
  } finally {
    await server?.stop()
    await rm(dir, { recursive: true, force: true })
  }
}, 90000)

it('declines colliding size IDs, clears the browser intent, and accepts the corrected family', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mutiny-parts-names-'))
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    server = await startServer(path.join(dir, 'catalog.sqlite'))
    const { origin } = server
    const { firmPartsId } = await (await fetch(`${origin}/demo-config.json`)).json()
    const browser = profile()
    const wire: typeof fetch = (url, init) => fetch(new URL(String(url), origin), init)
    const client = createDemoFirmParts(firmPartsId, 'Priya', () => browser, wire)
    const definition = exampleRooftopUnit()
    const model = definition.model!
    const types = model.types.map(row => row.name === 'RTU-10' ? { ...row, name: 'RTU 5' } : row)
    const refused = await client.publishPartTypeAtRevision({
      requestId: 'duplicate-sizes', baseRevision: 0, definition: { ...definition, model: { ...model, types } },
    })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: expect.stringMatching(/RTU-5 and RTU 5.*rename/i) })
    expect(browser.length).toBe(0)
    expect((await (await client.partTypes()).json()).partTypes).toHaveLength(0)
    const corrected = await client.publishPartTypeAtRevision({ requestId: 'renamed', baseRevision: 0, definition })
    expect(await corrected.json()).toMatchObject({ status: 'saved', receipt: { revision: 1 } })
  } finally {
    await server?.stop()
    await rm(dir, { recursive: true, force: true })
  }
}, 90000)

it('admits one winner when two independent server processes publish different edits from the same base', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mutiny-parts-race-'))
  const servers: Awaited<ReturnType<typeof startServer>>[] = []
  try {
    const db = path.join(dir, 'catalog.sqlite')
    servers.push(await startServer(db))
    servers.push(await startServer(db))
    const endpoints = await Promise.all(servers.map(async ({ origin }) => {
      const config = await (await fetch(`${origin}/demo-config.json`)).json()
      return `${origin}/api/bim/library/part-types?library=${config.firmPartsId}`
    }))
    const definition = exampleRooftopUnit()
    const results = await Promise.all(endpoints.map((url, i) => fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: `editor-${i}`, baseRevision: 0, definition: { ...definition, description: `Edit ${i}` } }),
    })))
    expect(results.map(r => r.status).sort()).toEqual([200, 409])
    const winner = results.findIndex(r => r.status === 200)
    for (const url of endpoints) {
      const catalog = await (await fetch(url)).json()
      expect(catalog.partTypes[0]).toMatchObject({ revision: 1, definition: { description: `Edit ${winner}` } })
      expect(catalog.partTypes[0].revisions).toHaveLength(1)
    }
  } finally {
    await Promise.all(servers.map(s => s.stop()))
    await rm(dir, { recursive: true, force: true })
  }
}, 90000)

it('keeps the pending intent through a missing or mismatched receipt and requires browser storage before sending', async () => {
  const browser = profile()
  const definition = exampleRooftopUnit()
  const input = { requestId: 'mine', baseRevision: 0, definition }
  const receipt = { requestId: 'mine', baseRevision: 0, revision: 1, familyId: `part:${definition.model!.id}` }
  const reply = (r: unknown) => Response.json({ status: 'saved', summary: { revision: 1 }, receipt: r })
  const wire = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
  const client = createDemoFirmParts('catalog', 'designer', () => browser, wire)
  for (const wrong of [undefined, { ...receipt, requestId: 'someone-else' }, { ...receipt, baseRevision: 1 }, { ...receipt, familyId: 'part:other' }, { ...receipt, revision: 2 }]) {
    wire.mockResolvedValueOnce(reply(wrong))
    await expect(client.publishPartTypeAtRevision(input)).rejects.toThrow('matching receipt')
    expect(JSON.parse(browser.getItem(browser.key(0)!)!)).toEqual(input)
  }
  await expect(client.publishPartTypeAtRevision({ ...input, baseRevision: 2 })).rejects.toThrow('another edit')
  const refused = createDemoFirmParts('catalog', 'designer', () => { throw new Error('storage unavailable') }, wire)
  await expect(refused.publishPartTypeAtRevision(input)).rejects.toThrow('storage unavailable')
  expect(wire).toHaveBeenCalledTimes(5)
  wire.mockResolvedValueOnce(reply(receipt))
  await client.publishPartTypeAtRevision(input)
  expect(browser.length).toBe(0)
})

import { fireEvent, render, screen } from '@testing-library/react'
import { ManageMembersDialog } from '../src/editor/membership/ManageMembersDialog'
import { readMembers, saveMember } from '../src/editor/membership/members'
import { jsonAnswer } from '../src/host/local-data'

const mara = { personId: '00000000-0000-0000-0000-000000000001', displayName: 'Mara', role: 'manager' }
const jules = { personId: '00000000-0000-0000-0000-000000000002', displayName: 'Jules', role: 'viewer' }
const kim = { personId: '00000000-0000-0000-0000-000000000003', displayName: 'Kim', role: 'manager' }
const roster = jsonAnswer({ ownerId: mara.personId, members: [mara, jules, kim] })
const model = 'east-plant'

function port() {
  return { read: jest.fn().mockResolvedValue(roster), change: jest.fn() }
}

function open(members: ReturnType<typeof port>, actorId = mara.personId) {
  render(<ManageMembersDialog modelId={model} actorId={actorId} port={members} onClose={jest.fn()} />)
}

const button = (name: string) => screen.getByRole('button', { name })

it('gives the operator a recovery action when a proxy returns an unreadable error page', async () => {
  const members = port()
  const gateway = { ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected HTML') } }
  members.read.mockResolvedValue(gateway)
  members.change.mockResolvedValue(gateway)
  await expect(readMembers(members, model)).rejects.toThrow('Members could not be loaded.')
  await expect(saveMember(members, model, { ...jules, role: 'viewer' }, 'editor'))
    .rejects.toThrow('Review the current role before trying again.')
})

async function review(role: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Change role for Jules' }))
  fireEvent.change(screen.getByLabelText('New role'), { target: { value: role } })
  fireEvent.click(button('Review change'))
}
const request = (expectedRole: string | null, role: string | null) => ({ personId: jules.personId, expectedRole, role })

describe('Manage members', () => {
  it('shows all three roles after a conflict and lets Mara keep the current role without writing again', async () => {
    const members = port()
    members.change.mockResolvedValue(jsonAnswer({ result: 'conflict', role: 'editor' }, 409))
    open(members)
    await review('none')
    expect(members.change).not.toHaveBeenCalled()
    fireEvent.click(button('Confirm change'))
    expect(await screen.findByRole('heading', { name: 'Jules’s role changed before you confirmed.' })).toHaveFocus()
    expect(screen.getByText('Role at review').nextElementSibling).toHaveTextContent('Viewer')
    expect(screen.getByText('Current role').nextElementSibling).toHaveTextContent('Editor')
    expect(screen.getByText('Requested role').nextElementSibling).toHaveTextContent('No access')
    expect(screen.queryByRole('button', { name: 'Confirm change' })).toBeNull()
    fireEvent.click(button('Keep current role'))
    await screen.findByRole('list', { name: 'Model members' })
    expect(members.change.mock.calls).toEqual([[model, request('viewer', null)]])
  })

  it('pins the fresh role on review again and waits for another explicit confirmation', async () => {
    const members = port()
    members.change.mockResolvedValueOnce(jsonAnswer({ result: 'conflict', role: null }, 409))
      .mockResolvedValueOnce(jsonAnswer({ result: 'changed', role: 'editor' }))
    open(members)
    await review('editor')
    fireEvent.click(button('Confirm change'))
    fireEvent.click(await screen.findByRole('button', { name: 'Review again' }))
    expect(screen.getByText('Current role').nextElementSibling).toHaveTextContent('No access')
    expect(screen.getByText('Requested role').nextElementSibling).toHaveTextContent('Editor')
    expect(members.change.mock.calls).toEqual([[model, request('viewer', 'editor')]])
    fireEvent.click(button('Confirm change'))
    expect(await screen.findByText(/Jules’s Editor role was saved/)).toBeInTheDocument()
    expect(members.change.mock.calls).toEqual([[model, request('viewer', 'editor')], [model, request(null, 'editor')]])
  })

  it('offers only to keep the current role when another change already granted the requested role', async () => {
    const members = port()
    members.change.mockResolvedValue(jsonAnswer({ result: 'conflict', role: 'editor' }, 409))
    open(members)
    await review('editor')
    fireEvent.click(button('Confirm change'))
    expect(await screen.findByRole('button', { name: 'Keep current role' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Review again' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Confirm change' })).toBeNull()
    expect(members.change).toHaveBeenCalledTimes(1)
  })

  it('keeps a viewer’s own ID available when the roster is denied', async () => {
    const members = port()
    members.read.mockResolvedValue(jsonAnswer({ error: 'Only the model owner or a manager can manage members.' }, 403))
    open(members, jules.personId)
    await screen.findByText(/Only the model owner/)
    expect(screen.getByLabelText('Your person ID')).toHaveValue(jules.personId)
    expect(screen.queryByRole('list', { name: 'Model members' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Look up person' })).toBeNull()
  })

  it('lets a manager change a viewer but protects the owner and managers', async () => {
    const members = port()
    const otherManager = { personId: '00000000-0000-0000-0000-000000000004', displayName: 'Pax', role: 'manager' }
    members.read.mockResolvedValue(jsonAnswer({ ownerId: mara.personId, members: [mara, kim, jules, otherManager] }))
    open(members, kim.personId)
    await screen.findByRole('list', { name: 'Model members' })
    expect(screen.queryByRole('button', { name: 'Change role for Mara' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Change role for Kim' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Change role for Pax' })).toBeNull()
    fireEvent.click(button('Change role for Jules'))
    expect(screen.getByLabelText('New role')).toHaveValue('viewer')
    expect(screen.queryByRole('option', { name: 'Manager' })).toBeNull()
  })

  it('looks up a new person by their exact ID and confirms a grant from No access', async () => {
    const members = port()
    members.read.mockResolvedValueOnce(jsonAnswer({ ownerId: mara.personId, members: [mara] }))
      .mockResolvedValueOnce(jsonAnswer({ ownerId: mara.personId, members: [{ ...jules, role: null }] }))
    members.change.mockResolvedValue(jsonAnswer({ result: 'changed', role: 'viewer' }))
    open(members)
    fireEvent.change(await screen.findByLabelText('Person ID'), { target: { value: jules.personId } })
    fireEvent.click(button('Look up person'))
    fireEvent.click(await screen.findByRole('button', { name: 'Review change' }))
    expect(screen.getByText('Current role').nextElementSibling).toHaveTextContent('No access')
    expect(members.read).toHaveBeenLastCalledWith(model, jules.personId, undefined)
    expect(members.change).not.toHaveBeenCalled()
    fireEvent.click(button('Confirm change'))
    await screen.findByText(/Jules’s Viewer role was saved/)
    expect(members.change.mock.calls).toEqual([[model, request(null, 'viewer')]])
  })

  it.each([
    ['lost reply', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['incomplete conflict', () => Promise.resolve(jsonAnswer({ result: 'conflict' }, 409))],
  ] as const)('reads the roster again after a %s and leaves retry to the user', async (_name, response) => {
    const members = port()
    members.change.mockImplementation(response)
    open(members)
    await review('editor')
    fireEvent.click(button('Confirm change'))
    await screen.findByText(/Review the current role before trying again/)
    await screen.findByRole('list', { name: 'Model members' })
    expect(members.read).toHaveBeenCalledTimes(2)
    expect(members.change).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Review again' })).toBeNull()
  })
})

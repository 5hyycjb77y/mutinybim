import type { EditorMemberRole, EditorModelMembersPort } from '@permitzip/bim-editor-host'

export type Role = EditorMemberRole | null
export interface Member { personId: string; displayName: string; role: Role }
export interface Roster { ownerId: string; members: Member[] }
export const roles = ['viewer', 'editor', 'manager'] as const
export const roleName = (role: Role) => role === null ? 'No access' : ({ viewer: 'Viewer', editor: 'Editor', manager: 'Manager' })[role]
const isRole = (value: unknown): value is Role => value === null || roles.some(role => role === value)
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isMember = (value: unknown): value is Member => record(value) && typeof value.personId === 'string' && typeof value.displayName === 'string' && isRole(value.role)

export async function readMembers(port: EditorModelMembersPort, model: string, target?: string, signal?: AbortSignal): Promise<Roster> {
  const response = await port.read(model, target, signal)
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(record(body) && typeof body.error === 'string' ? body.error : 'Members could not be loaded.')
  if (!record(body) || typeof body.ownerId !== 'string' || !Array.isArray(body.members) || !body.members.every(isMember)) {
    throw new Error('The server returned an unreadable member list.')
  }
  return { ownerId: body.ownerId, members: body.members }
}

export async function saveMember(port: EditorModelMembersPort, model: string, member: Member, next: Role): Promise<{ conflict: boolean; role: Role }> {
  const response = await port.change(model, { personId: member.personId, expectedRole: member.role, role: next })
  const body: unknown = await response.json().catch(() => null)
  if (record(body) && isRole(body.role)) {
    if (response.status === 409 && body.result === 'conflict') return { conflict: true, role: body.role }
    if (response.ok && (body.result === 'changed' || body.result === 'unchanged') && body.role === next) return { conflict: false, role: next }
  }
  if (response.status >= 400 && response.status < 500 && record(body) && typeof body.error === 'string') throw new Error(body.error)
  throw new Error('The server could not confirm your change. Review the current role before trying again.')
}

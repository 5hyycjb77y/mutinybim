import type { EditorHostCapabilities } from '@permitzip/bim-editor-host'

/**
 * Why a feature is missing where the editor runs, in words a person can act
 * on. `service` names what they tried, as a sentence subject ("Firm title
 * blocks"). The host's capabilities say where to connect it, when it can.
 */
export function unavailableWords(service: string, host?: EditorHostCapabilities | null): string {
  const where = host?.hostName ?? 'this app'
  const next = host?.connectHint ? ` Connect it in ${host.connectHint}, or open this model where it is set up.` : ' Open this model in an app that has it set up.'
  return `${service}: not available here, because ${where} doesn't provide it.${next}`
}

/** Thrown (or returned as a message) when the host has no port for what was asked. Not a fault: the host can't serve it. */
export class EditorServiceUnavailableError extends Error {
  readonly service: string

  constructor(service: string, host?: EditorHostCapabilities | null) {
    super(unavailableWords(service, host))
    this.name = 'EditorServiceUnavailableError'
    this.service = service
  }
}

export function isEditorServiceUnavailable(err: unknown): err is EditorServiceUnavailableError {
  return err instanceof EditorServiceUnavailableError
}

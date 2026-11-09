import { toast } from 'sonner'
import type { EditorNotifier, EditorNotifyOptions } from '@permitzip/bim-editor-host'

function sonnerOptions(options: EditorNotifyOptions | undefined) {
  if (!options) return undefined
  return { description: options.description, action: options.action, id: options.id }
}

/** Messages through `sonner`; the app mounts sonner's `<Toaster />` once. */
export const sonnerNotifier: EditorNotifier = {
  success: (message, options) => void toast.success(message, sonnerOptions(options)),
  error: (message, options) => void toast.error(message, sonnerOptions(options)),
  info: (message, options) => void toast.info(message, sonnerOptions(options)),
  warning: (message, options) => void toast.warning(message, sonnerOptions(options)),
}

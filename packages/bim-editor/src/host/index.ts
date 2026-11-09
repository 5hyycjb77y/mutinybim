// Kernel-free: host apps import this on pages that never open the editor.
// The standalone host is `@permitzip/bim-editor/host/local`.
export { EditorHostProvider, useEditorHost, useOptionalEditorHost } from './context'
export { useEditorNavigation, type EditorNavigation } from './navigation'
export { HostLink } from './link'
export { sonnerNotifier } from './sonner-notifier'
export { checkEditorHostConformance } from './conformance'
export * from './unavailable'

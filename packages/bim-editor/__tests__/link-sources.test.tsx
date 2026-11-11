import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { EditorHost, EditorLinkedModelsPort } from '@permitzip/bim-editor-host'
import { EditorHostProvider } from '../src/host'
import { createLocalEditorHost } from '../src/host/local'
import { jsonAnswer } from '../src/host/local-data'
import { TooltipProvider } from '../src/ui/tooltip'
import { LinkModelDialog } from '../src/editor/LinkModelDialog'
import { LinkedModelsPanel } from '../src/editor/LinkedModelsPanel'
import { canLinkFrom, linkDescription, linkSourcesOf, linkUnavailableReason } from '../src/editor/linked-api'

const NOTHING_LINKED = { canEdit: true, revitModel: null, references: [], autodeskExport: null, docsImports: [] }
const ok = async () => jsonAnswer({ ok: true })

/** What every host with linked models serves: the list, placement and unlinking. */
function listOnly(): EditorLinkedModelsPort {
  return { list: jest.fn(async () => jsonAnswer(NOTHING_LINKED)), update: jest.fn(ok), unlink: jest.fn(ok) }
}

function ifcUpload() {
  return {
    startUpload: jest.fn(async () => jsonAnswer({ referenceId: 'reference-1', versionId: 'version-1', sourcePath: 'uploads/sample-warehouse.ifc' })),
    putFile: jest.fn(async () => ({ done: Promise.resolve(), cancel: () => {} })),
    convert: jest.fn(ok),
  }
}

function revitExport() {
  return { autodeskExport: jest.fn(ok), updateFromRevit: jest.fn(async () => jsonAnswer({ outcome: 'queued', kind: 'project_model', latestDocsVersion: null })) }
}

function autodeskDocs() {
  return {
    browseDocs: jest.fn(async () => jsonAnswer({ folders: [], files: [] })),
    addDocs: jest.fn(async () => jsonAnswer({ results: [] })),
    refreshDocs: jest.fn(async () => jsonAnswer({ outcome: 'up_to_date', versionNumber: null })),
    lineUp: jest.fn(ok),
    freshness: jest.fn(async () => jsonAnswer({ models: [] })),
  }
}

function hostWith(port?: EditorLinkedModelsPort): EditorHost {
  const local = createLocalEditorHost({ authorityUrl: 'ws://127.0.0.1:3095/sync' })
  return port ? { ...local, data: { ...local.data, linkedModels: port } } : local
}

function panel(port?: EditorLinkedModelsPort) {
  return render(
    <EditorHostProvider host={hostWith(port)}>
      <TooltipProvider>
        <LinkedModelsPanel projectId="sample-warehouse" linkOpen={false} onLinkOpenChange={() => {}} onViewChange={() => {}} onCanEditChange={() => {}} fixtureReferences={[]} headerless />
      </TooltipProvider>
    </EditorHostProvider>,
  )
}

function dialog(port: EditorLinkedModelsPort, onQueued = () => {}) {
  return render(
    <EditorHostProvider host={hostWith(port)}>
      <LinkModelDialog projectId="sample-warehouse" open onOpenChange={() => {}} revitModel={null} autodeskExport={null} replacing={null} onQueued={onQueued} onOpenDocsPicker={null} />
    </EditorHostProvider>,
  )
}

describe('which link sources a host serves', () => {
  it('offers a source only when the host has every method it needs', () => {
    expect(linkSourcesOf(undefined)).toEqual({ ifcUpload: false, revitExport: false, autodeskDocs: false })
    expect(linkSourcesOf(listOnly())).toEqual({ ifcUpload: false, revitExport: false, autodeskDocs: false })
    expect(linkSourcesOf({ ...listOnly(), ...ifcUpload() })).toEqual({ ifcUpload: true, revitExport: false, autodeskDocs: false })
    expect(linkSourcesOf({ ...listOnly(), ...ifcUpload(), ...revitExport(), ...autodeskDocs() })).toEqual({ ifcUpload: true, revitExport: true, autodeskDocs: true })
    // Half a source is no source: browsing without adding can't link anything.
    expect(linkSourcesOf({ ...listOnly(), browseDocs: autodeskDocs().browseDocs }).autodeskDocs).toBe(false)
    expect(linkSourcesOf({ ...listOnly(), startUpload: ifcUpload().startUpload }).ifcUpload).toBe(false)
  })

  it('names only the sources that are there, and says so in words when none is', () => {
    const upload = linkSourcesOf({ ...listOnly(), ...ifcUpload() })
    expect(linkDescription(upload)).toBe("Bring in the architect's model from an IFC file")
    expect(linkDescription(upload)).not.toMatch(/Autodesk|Revit/)
    expect(linkUnavailableReason(upload, 'this computer')).toBeNull()
    expect(linkDescription(linkSourcesOf({ ...listOnly(), ...ifcUpload(), ...revitExport(), ...autodeskDocs() }))).toBe("Bring in the architect's model from Autodesk Docs or an IFC file")

    const none = linkSourcesOf(undefined)
    expect(canLinkFrom(none)).toBe(false)
    expect(linkUnavailableReason(none, 'this computer')).toBe("Linked models aren't available here: this computer doesn't keep linked model files. You can model without one.")
  })
})

describe('the Linked models section', () => {
  it('offers IFC upload but nothing from Autodesk where the host serves uploads only', async () => {
    const port = { ...listOnly(), ...ifcUpload() }
    panel(port)
    await waitFor(() => expect(screen.getByTestId('link-model-open')).toBeEnabled())
    expect(screen.queryByTestId('docs-picker-open')).toBeNull()
    expect(screen.queryByText(/Autodesk|Revit/)).toBeNull()
  })

  it('keeps every source where the host serves them all', async () => {
    const port = { ...listOnly(), ...ifcUpload(), ...revitExport(), ...autodeskDocs() }
    panel(port)
    await waitFor(() => expect(screen.getByTestId('link-model-open')).toBeEnabled())
    expect(screen.getByTestId('docs-picker-open')).toHaveTextContent('Add from Autodesk Docs…')
  })

  it('says linking is not available, with no buttons and no error, where the host has no linked models', () => {
    panel()
    expect(screen.getByTestId('linked-models-unavailable')).toHaveTextContent("Linked models aren't available here: this computer doesn't keep linked model files.")
    expect(screen.queryByTestId('link-model-open')).toBeNull()
    expect(screen.queryByTestId('docs-picker-open')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('Try again')).toBeNull()
  })
})

describe('Link a model', () => {
  it('shows the IFC upload alone, with no Revit tab, where the host serves uploads only', () => {
    dialog({ ...listOnly(), ...ifcUpload() })
    expect(screen.getByTestId('link-model-dialog')).toBeInTheDocument()
    expect(document.getElementById('link-model-file')).toBeInstanceOf(HTMLInputElement)
    expect(screen.queryByText('From linked models in our Revit file')).toBeNull()
    expect(screen.queryByText(/Revit model is connected/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Upload and link' })).toBeDisabled()
  })

  it('offers both, as tabs, where the host serves the Revit model and uploads', () => {
    dialog({ ...listOnly(), ...ifcUpload(), ...revitExport() })
    expect(screen.getByRole('tab', { name: /From linked models in our Revit file/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Upload an IFC file/ })).toBeInTheDocument()
  })

  it('uploads the chosen IFC through the host and queues its conversion', async () => {
    const port = { ...listOnly(), ...ifcUpload() }
    const onQueued = jest.fn()
    dialog(port, onQueued)
    const input = document.getElementById('link-model-file')
    if (!(input instanceof HTMLInputElement)) throw new Error('the IFC file field is missing')
    const file = new File(['ISO-10303-21;\nEND-ISO-10303-21;\n'], 'sample-warehouse.ifc')
    fireEvent.change(input, { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload and link' }))

    await waitFor(() => expect(onQueued).toHaveBeenCalled())
    expect(port.startUpload).toHaveBeenCalledWith({ projectId: 'sample-warehouse', request: expect.objectContaining({ fileName: 'sample-warehouse.ifc', label: 'sample-warehouse' }) })
    expect(port.putFile).toHaveBeenCalledWith({ sourcePath: 'uploads/sample-warehouse.ifc', file }, expect.any(Function))
    expect(port.convert).toHaveBeenCalledWith({ projectId: 'sample-warehouse', versionId: 'version-1' })
  })
})

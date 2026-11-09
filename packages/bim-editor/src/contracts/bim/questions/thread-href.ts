/** Where a question notice opens: the project's Building Model with the question's thread open (and its branch, for one asked on a branch). Imports nothing, so the bell stays small. */
export function questionThreadHref(projectId: string, modelId: string, questionId: string): string {
  const branch = modelId.includes("~") ? modelId.slice(modelId.indexOf("~") + 1) : null
  const qs = new URLSearchParams({ question: questionId, ...(branch ? { branch } : {}) })
  return `/projects/${encodeURIComponent(projectId)}/building-model?${qs.toString()}`
}

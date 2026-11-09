/** Editor page addresses: `/m/<model>` and the standalone window's `/mutinybim/<model>`. The first group is the model. */
export const MODEL_PATH = /^\/(?:m|mutinybim)\/([^/]+)\/?$/

/** The browser event the local host raises when the address changes without a page load. */
export const LOCATION_CHANGED = 'mutinybim:location'

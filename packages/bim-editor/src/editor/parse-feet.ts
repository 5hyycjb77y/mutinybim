/** Feet as typed: `2`, `-1.5`, `2'6"`, `2 ft 6 in`, `30"`. Null when it doesn't read as a length. */
export function parseFeet(text: string): number | null {
  const num = String.raw`(\d+(?:\.\d+)?)`
  const sign = String.raw`^\s*([+-])?\s*`
  const feetInches = new RegExp(`${sign}${num}\\s*(?:'|ft)\\s*(?:${num}\\s*(?:"|in))?\\s*$`, 'i').exec(text)
  const inches = new RegExp(`${sign}${num}\\s*(?:"|in)\\s*$`, 'i').exec(text)
  const bare = new RegExp(`${sign}${num}\\s*$`).exec(text)
  const ft = feetInches ? Number(feetInches[2]) + Number(feetInches[3] ?? 0) / 12 : inches ? Number(inches[2]) / 12 : bare ? Number(bare[2]) : null
  if (ft === null) return null
  return (feetInches ?? inches ?? bare)?.[1] === '-' ? -ft : ft
}

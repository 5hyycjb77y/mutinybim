/** The disciplines Model settings › Codes lists, in the order a reviewer reads a code summary. A pack's own slot shows by its id. */
export const CODE_OF_RECORD_DISCIPLINES = ["building", "fire", "energy", "mechanical", "plumbing", "fuel_gas", "electrical"] as const

export const CODE_OF_RECORD_DISCIPLINE_LABELS: Readonly<Record<string, string>> = {
  building: "Building",
  fire: "Fire",
  energy: "Energy",
  mechanical: "Mechanical",
  plumbing: "Plumbing",
  fuel_gas: "Fuel gas",
  electrical: "Electrical",
}

export function disciplineWords(discipline: string): string {
  return CODE_OF_RECORD_DISCIPLINE_LABELS[discipline] ?? discipline.replace(/_/g, " ")
}

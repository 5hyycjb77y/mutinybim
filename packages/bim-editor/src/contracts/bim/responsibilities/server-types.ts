/** What the viewer may do on this project's model (from the host's project permissions). */
export interface ResponsibilityPowers {
  /** Name, change and remove responsible professionals (the project lead). */
  readonly canName: boolean
  /** Approve a part their accepted responsibility covers. */
  readonly canApprove: boolean
  /** Edit the model, so propose and land merges. */
  readonly canPropose: boolean
}

import type { ProjectAdoptionLookup, ProjectCodeAdoptions, ProjectFuelGasLookup, ProjectPlumbingLookup } from "./capabilities";

/**
 * A local server keeps no record of the codes a project adopted, so every
 * lookup answers "none": a calc run then uses the edition or state the call
 * gives, or asks for one. Nothing is guessed.
 */
export const noAdoptedElectricalCode: ProjectAdoptionLookup = async () => null;
export const noAdoptedFuelGasCode: ProjectFuelGasLookup = async () => null;
export const noAdoptedPlumbingCode: ProjectPlumbingLookup = async () => null;

export const noAdoptedCodes: ProjectCodeAdoptions = {
  projectAdoption: noAdoptedElectricalCode,
  fuelGas: noAdoptedFuelGasCode,
  plumbing: noAdoptedPlumbingCode,
};

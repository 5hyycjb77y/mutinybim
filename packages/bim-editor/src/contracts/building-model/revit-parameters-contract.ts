/**
 * What the Building Model reads about an element straight from Revit (the
 * add-in's parameters file, stored as a parameter pack), shared by the routes
 * and the browser. No server code here.
 */

/** built-in = Revit's own; project = a project or family parameter; shared = from a shared parameter file. */
export type RevitParameterKind = "built-in" | "project" | "shared";

export interface RevitParameterView {
  readonly name: string;
  /** As Revit shows it (units included when Revit formats them), or "" when the parameter has no value. */
  readonly value: string;
  readonly empty: boolean;
  readonly kind: RevitParameterKind;
  readonly readOnly: boolean;
  /** The display unit in words ("feet and fractional inches"), when the parameter is a measurement. */
  readonly unit: string | null;
}

export interface RevitParameterGroupView {
  /** Revit's parameter group ("Constraints", "Electrical - Loads", "Identity Data"...). */
  readonly name: string;
  /** instance = set on this element; type = shared by every element of its type. */
  readonly source: "instance" | "type";
  readonly parameters: readonly RevitParameterView[];
}

export interface RevitElementSummary {
  readonly elementId: number;
  readonly globalId: string | null;
  readonly category: string | null;
  readonly family: string | null;
  readonly typeName: string | null;
  readonly name: string | null;
  readonly level: string | null;
  /** False when the IFC export left the element out (no 3D body: receptacles, junction boxes). */
  readonly inIfc: boolean;
}

export interface RevitElementParameters {
  readonly model: string;
  readonly exportedAt: string | null;
  readonly element: RevitElementSummary;
  readonly typeElementId: number | null;
  readonly groups: readonly RevitParameterGroupView[];
}

export type RevitParametersResponse =
  | { readonly available: true; readonly parameters: RevitElementParameters }
  | { readonly available: false; readonly reason: "not_exported" | "not_found"; readonly message: string };

export interface UnplacedElementView extends RevitElementSummary {
  /** Revit's location point in the model file's own frame: metres, IFC axes (X east, Y north, Z up). */
  readonly location: readonly [number, number, number];
}

export type UnplacedElementsResponse =
  | { readonly available: true; readonly model: string; readonly elements: readonly UnplacedElementView[] }
  | { readonly available: false; readonly message: string };

/** The key a reference's Revit data is looked up by: a linked version, or one model of the project's test export. */
export type ParameterSourceKey = `linked:${string}` | `fixture:${string}`;

export const NOT_EXPORTED_MESSAGE =
  "This model has no Revit parameter data. Bring it in again from Revit (Link architect model → From Autodesk Docs) to see every Revit parameter here.";
export const UPLOADED_IFC_MESSAGE =
  "This model was uploaded as an IFC file, so only what's in the file is shown. Revit parameters come with models brought in from Autodesk Docs.";
export const ELEMENT_NOT_FOUND_MESSAGE = "Revit's export doesn't list this element, so only what's in the IFC file is shown.";

/** Outside add-ons: the install gate, data add-ons and one firm's library (round 11 A11, D5). */
export { DATA_ADDON_FORMAT, DATA_ADDON_FORMAT_VERSION, DATA_ADDON_POINTS, buildDataAddon, readDataAddonDocument, type DataAddonBuild, type DataAddonContribution, type DataAddonDocument, type DataAddonPoint, type DataAddonRead } from "./data-addon";
export { libraryPackageVerifier, type OutsidePackage, type PackageVerification, type PackageVerifier, type PackageVerifyContext } from "./package";
export { checkOutsidePackage, namespaceProblem, packageScope, type GatedAddon, type InstallGateOptions, type InstallOutcome } from "./gate";
export { OutsideAddonLibrary, openWithOutsidePacks, type OpenedWithOutsidePacks } from "./library";

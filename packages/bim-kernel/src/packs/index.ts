/**
 * `@permitzip/bim-kernel/packs`: the add-on contract (manifest, versioned
 * extension points, pack sets bound per model). Pack authors import
 * `@permitzip/bim-pack`, which re-exports this plus every layer's points.
 */
export {
  PACK_CONTRACT_VERSION,
  RESERVED_PACK_NAMESPACES,
  PackDefinitionError,
  contribute,
  contributionProblems,
  defineExtensionPoint,
  definePack,
  isRangeShape,
  keepsBareIds,
  manifestProblems,
  parseVersion,
  satisfies,
  type Contribution,
  type ErasedContribution,
  type ExtensionPoint,
  type Pack,
  type PackManifest,
  type PackRequirement,
} from "./contract";
export {
  BUILTIN_PACK_SET,
  PACKS_PINS_FEATURE,
  PackSet,
  PackSetError,
  firstPartyOwnerOf,
  installFirstPartyPacks,
  installedFirstPartyPacks,
  packNotLoadedMessage,
  resolvePackPins,
  type PackPin,
  type PackSetOptions,
  type PointContributor,
} from "./set";
export { activePackSet, bindModelPacks, modelPackSet, modelStatePackSet, setModelStateBinder, unbindModelPacks, withModelPacks, withModelStatePacks, withPackSet, type ModelPackState, type ModelStateBinder } from "./scope";
export {
  ELECTRICAL_MANIFEST,
  FIRST_PARTY_MANIFESTS,
  FIRST_PARTY_PACK_IDS,
  MECHANICAL_MANIFEST,
  FIRE_PROTECTION_MANIFEST,
  ARCHITECTURE_MANIFEST,
  PLUMBING_GAS_MANIFEST,
  STRUCTURAL_MANIFEST,
  firstPartyCommandOwner,
  firstPartyStoredOwner,
  firstPartyPackName,
  firstPartyPackOfDiscipline,
  isFirstPartyPackId,
  type FirstPartyPackId,
} from "./first-party/manifests";
export {
  ADDON_TOOL_PACK_PREFIX,
  AGENT_TOOL_PACK_POINT,
  AGENT_TOOL_POINT,
  agentToolPackOf,
  agentToolPackRowProblems,
  agentToolPackSetProblems,
  type AgentToolPackDescriptor,
  COMMAND_BUILDER_POINT,
  FIRST_PARTY_TOOL_PREFIX,
  HOST_RESERVED_TOOL_INPUT_KEYS,
  PACK_READ_POINT,
  agentToolNameProblem,
  isPackRefusal,
  reservedToolInputProblem,
  type AgentToolDescriptor,
  type AgentToolTarget,
  type BuiltCommand,
  type CommandBuilderDef,
  type JsonSchemaObject,
  type PackReadDef,
  type PackRefusal,
} from "./points";// Round 11 A11 (D5): pins with digest and tier, trust and review, and set.ts's install section.
export { PACKS_OUTSIDE_PINS_FEATURE, PACK_TIERS, PackPinWriteError, isOutsidePin, isPackDigest, needsAddonWords, pinKey, readStoredPackPin, readStoredPackPins, samePin, writePackPin, type OutsidePackPin, type PackDigest, type PackTier, type PinRead } from "./pin";
export { CHECK_PASSED, DATA_ONLY_POLICY, REVIEW_STATES, ReviewActError, applyReviewAct, checkFailed, checkNotRun, checkProblems, checksPassed, codeTierRefusal, isReviewDigest, packTrustOf, readInstallChecks, tierProblem, type CheckResult, type CheckStatus, type HostTrustPolicy, type InstallChecks, type InstallReview, type PackTrust, type ReviewAct, type ReviewState } from "./trust";
export { missingPinWords, outsidePacksForPins, type BlockedPin, type InstalledOutsidePack, type OutsidePinResolution } from "./set";

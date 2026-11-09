/**
 * In-memory stand-ins for the schedule engine, sync, registry, library and
 * formula engine. For demos and tests only; hosts pass the real ones.
 */
export { createMockScheduleConnection, type MockConnectionOptions, type MockRow, type MockSchedule, type MockScheduleConnection } from "./connection";
export { DOOR_COLUMNS, SPRINKLER_COLUMNS, WATER_HEATER_COLUMNS, doorSchedule, sprinklerSchedule, waterHeaterSchedule } from "./samples";
export { catalogFormulaSchema, createMockCatalog, createMockFormulaEngine, createMockLibraryProvider, type MockLibraryOptions } from "./catalog";

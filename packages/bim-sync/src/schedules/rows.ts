/**
 * The row shapes a schedule subscription carries are the kernel row engine's
 * own (Stream E, `packages/bim-kernel/src/schedules/engine/types.ts`). They
 * cross the wire unchanged except for typed arrays and maps, which
 * `protocol.ts` encodes as JSON.
 */
export type {
  CellValue,
  ColumnId,
  ColumnSourceRef,
  ColumnValues,
  ColumnWriter,
  RowGroup,
  RowHighlight,
  RowKey,
  RowPatch,
  RowSet,
  RowSetColumn,
  RowUpsert,
  ValueType,
} from "@permitzip/bim-kernel/schedules";

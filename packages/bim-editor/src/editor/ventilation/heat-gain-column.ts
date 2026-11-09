import { useMemo } from 'react'
import { draftHeatGainCell } from '@permitzip/bim-pack-mechanical'
import type { ComputedEquipmentColumn } from '../equipment-list/EquipmentListDialog'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { useKitchenHeatTablesFrom, type KitchenHeatTables } from './kitchen-heat-client'

/** The Equipment list's Heat gain column over tables already read: the table's heat for a row that names an appliance it has. */
export function heatGainColumn(tables: KitchenHeatTables): ComputedEquipmentColumn {
  return {
    id: 'heat-gain',
    label: 'Heat gain',
    cell: (row) => {
      if (tables.status === 'loading') return { text: '…', title: 'Reading the kitchen heat table' }
      if (tables.status === 'error') return { text: 'Not read', title: tables.error ?? "Couldn't read the kitchen heat tables" }
      return draftHeatGainCell(row.description, { firm: tables.firm, project: tables.project })
    },
  }
}

/** The Heat gain column for the Equipment list, reading the firm's and the project's tables once. */
export function useHeatGainColumns(projectId: string | null | undefined): readonly ComputedEquipmentColumn[] {
  const tables = useKitchenHeatTablesFrom(useEditorHost().data.firmLibrary, projectId)
  return useMemo(() => [heatGainColumn(tables)], [tables])
}

'use client'

import { blockTextTable } from '@permitzip/bim-kernel'
import { Badge } from '../../ui/badge'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'

const GOVERNING = 'governing cell'

/**
 * A worked calculation as a table (the block's own text, split into cells).
 * The row whose lookup decided the answer is marked twice: a warning tint and
 * a "Governing cell" label naming the row and column, so it never depends on
 * colour alone. Checks, references and what the sheet still needs follow as
 * lines, failures in the danger colour with the word FAIL.
 */
export function CalcSheetTable({ text, caption }: { readonly text: string; readonly caption: string }) {
  const t = blockTextTable(text)
  return (
    <div className="flex flex-col gap-2" data-testid="calc-sheet-table">
      {t.header && (
        <Table>
          <TableCaption className="sr-only">{caption}</TableCaption>
          <TableHeader>
            <TableRow>
              {t.header.map((h) => (
                <TableHead key={h}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {t.rows.map((row, i) => {
              const how = row[3] ?? ''
              const governing = how.startsWith(GOVERNING)
              return (
                <TableRow key={`${row[0] ?? ''}-${i}`} className={governing ? 'bg-warning-100' : undefined} data-testid={governing ? 'calc-governing-row' : undefined}>
                  <TableCell className="font-medium">{row[0]}</TableCell>
                  <TableCell className="tabular-nums">{row[1]}</TableCell>
                  <TableCell>{row[2]}</TableCell>
                  <TableCell className="text-sm">
                    {governing ? (
                      <div className="flex flex-col gap-1">
                        <Badge variant="outline" className="w-fit border-warning-300">
                          Governing cell
                        </Badge>
                        <span>{how.slice(GOVERNING.length + 2)}</span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">{how}</span>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
      {[...t.lead, ...t.notes].map((line, i) => (
        <p key={`${i}-${line}`} className={line.startsWith('FAIL') ? 'text-sm text-danger-600' : line.startsWith('Needs:') ? 'text-sm text-warning-700' : 'text-sm text-muted-foreground'}>
          {line}
        </p>
      ))}
    </div>
  )
}

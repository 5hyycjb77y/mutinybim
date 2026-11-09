import { formatter, parseToSI, PROFILE_US_FEET_INCHES, UnitError, unitLabel, type DisplayProfile, type Kind, type Precision, type UnitCode } from "@permitzip/bim-units";

/**
 * Unit formatting for schedule cells, bound to one display profile. Cells show
 * the bare number (`label: "none"`) and the unit rides in the column heading,
 * so a 10,000-row column doesn't repeat "MBH" ten thousand times. Formatters
 * come from bim-units' per-(profile, kind, override) cache: one multiply-add
 * and a rounding per cell.
 */
export interface ColumnDisplay {
  readonly unit?: UnitCode;
  readonly precision?: Precision;
}

export interface ScheduleUnits {
  readonly profile: DisplayProfile;
  /** Text for a cell (SI in, no unit label). Empty string for NaN. */
  format(kind: Kind, si: number, display?: ColumnDisplay): string;
  /** Heading label ("MBH", "gpm"), or "" when the format carries its own marks (feet-inches). */
  heading(kind: Kind, display?: ColumnDisplay): string;
  /** SI value, or a plain-words reason the text isn't a value of this kind. */
  parse(text: string, kind: Kind, display?: ColumnDisplay): { readonly ok: true; readonly si: number } | { readonly ok: false; readonly message: string };
}

export function createScheduleUnits(profile: DisplayProfile = PROFILE_US_FEET_INCHES): ScheduleUnits {
  const override = (display?: ColumnDisplay) => ({ label: "none" as const, ...(display?.unit ? { unit: display.unit } : {}), ...(display?.precision ? { precision: display.precision } : {}) });
  return {
    profile,
    format(kind, si, display) {
      if (Number.isNaN(si)) return "";
      return formatter(kind, profile, override(display))(si);
    },
    heading(kind, display) {
      return unitLabel(kind, profile, display?.unit ? { unit: display.unit } : undefined);
    },
    parse(text, kind, display) {
      try {
        const scoped: DisplayProfile = display?.unit ? { ...profile, kinds: { ...profile.kinds, [kind]: { ...(profile.kinds[kind] ?? { precision: { kind: "decimals", digits: 2 } }), unit: display.unit } } } : profile;
        return { ok: true, si: parseToSI(text, kind, scoped) };
      } catch (err) {
        if (err instanceof UnitError) return { ok: false, message: err.message };
        throw err;
      }
    },
  };
}

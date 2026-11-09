import { SCREENS as first } from '../electrical/register'
import { SCREENS as second } from '../plumbing/register'
import { SCREENS as third } from '../ventilation/register'
import { SCREENS as fourth, SCHEDULE_OFFER as fourthOffer } from '../architecture/register'
import type { AddonScheduleOffer } from '../../contracts/bim/addon-schedule-templates'
import type { AddonContributions } from './types'

/**
 * The first-party add-ons' screens, always installed, in the order their
 * tabs sit after Model (each folder's `register.ts` pairs its package's
 * `ADDON_UI` with its loader map).
 */
export const FIRST_PARTY_CONTRIBUTIONS: readonly AddonContributions[] = [first, second, third, fourth]

/** What each first-party add-on's library rows bring to New schedule…, named while the add-on is off (other add-ons append theirs). */
export const FIRST_PARTY_SCHEDULE_OFFERS: readonly AddonScheduleOffer[] = [fourthOffer]

/**
 * Hand-maintained release notes shown in the "What's New" dialog.
 *
 * Add a new entry to the TOP of CHANGELOG whenever there is something worth
 * announcing, dated with the build date. The dialog auto-opens once for returning
 * users whose last-seen date differs from LATEST_UPDATE (= CHANGELOG[0].date).
 * Keep entries user-facing and short. Entries are keyed by build date, not a
 * semver — the app is versioned by build hash + date (see VersionInfo) — so a
 * rebuild without a new entry never nags users.
 */
export interface ChangelogEntry {
  date: string; // YYYY-MM-DD build date, also the show-once key
  title: string;
  features?: string[];
  fixes?: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: '2026-08-04',
    title: 'Compound callsign support',
    features: [
      'Full support for compound / portable callsigns such as DL/OK1CDJ or OK1CDJ/P — calling CQ, answering, and the complete signal-report exchange now work end to end.',
    ],
    fixes: [
      'Compound-callsign QSOs no longer skip the signal report or stall before completing.',
      'Answering another station’s CQ with a compound call now sends your full call first, so the other operator can decode who is calling.',
      'More reliable handling of hashed callsigns (shown as <…>) while a compound call is still being learned on the band.',
    ],
  },
];

/** Date of the newest entry — the marker the What's New dialog tracks. */
export const LATEST_UPDATE = CHANGELOG[0]?.date ?? '';

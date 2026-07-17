import { logBook } from '../LogBook';

export class LogbookService {
  /**
   * Retrieves a Set of all callsigns already worked/logged for the given band and mode.
   * Callsigns are normalized to uppercase for consistent instant checking.
   * When `ignoreMode` is true, matching is band-only (mode is ignored).
   */
  static async getWorkedCallsigns(band: string, mode: string, ignoreMode = false): Promise<Set<string>> {
    const workedSet = new Set<string>();
    try {
      const qsos = await logBook.getAllQSOs();
      const targetBand = band.trim().toUpperCase();
      const targetMode = mode.trim().toUpperCase();

      for (const qso of qsos) {
        // Mode could be 'FT8' or submode could be related. Standard check.
        const qsoBand = (qso.band || '').trim().toUpperCase();
        const qsoMode = (qso.mode || '').trim().toUpperCase();

        if (qsoBand === targetBand && (ignoreMode || qsoMode === targetMode)) {
          const call = (qso.call || '').trim().toUpperCase();
          if (call) {
            workedSet.add(call);
          }
        }
      }
    } catch (error) {
      console.error('[LogbookService] Failed to retrieve worked callsigns:', error);
    }
    return workedSet;
  }

  static async getWorkedDxccEntities(): Promise<Set<number>> {
    try {
      const qsos = await logBook.getAllQSOs();
      return new Set(qsos.map(q => q.dxcc).filter((d): d is number => d !== undefined && d > 0));
    } catch (error) {
      console.error('[LogbookService] Failed to retrieve worked DXCC entities:', error);
      return new Set();
    }
  }
}

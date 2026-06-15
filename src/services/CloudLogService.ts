import { QSO, logBook } from '../LogBook';

export interface CloudLogConfig {
  wavelogEnabled: boolean;
  wavelogUrl: string;
  wavelogApiKey: string;
  wavelogStationProfileId: string;
}

export class CloudLogService {
  /**
   * Generates a simple ADIF string for a single QSO to be submitted to Cloudlog/Wavelog.
   */
  private static generateAdif(qso: QSO): string {
    let row = "";

    const processField = (field: string, value: string | number | undefined) => {
      if (value !== undefined && value !== null && value !== "") {
        const strVal = String(value);
        row += `<${field}:${strVal.length}>${strVal}`;
      }
    };

    processField("call", qso.call);
    processField("band", qso.band);
    processField("mode", qso.mode || "FT8");
    if (qso.submode) {
      processField("submode", qso.submode);
    }
    if (qso.freq) {
      const freqStr = Number(qso.freq).toFixed(6).replace(/\.?0+$/, "");
      processField("freq", freqStr);
    }
    processField("qso_date", qso.qso_date);
    processField("time_on", qso.time_on);
    processField("time_off", qso.time_on); // standard ADIF includes time_off
    processField("rst_rcvd", qso.rst_rcvd);
    processField("rst_sent", qso.rst_sent);
    processField("gridsquare", qso.gridsquare);

    row += "<eor>";
    return row;
  }

  /**
   * Cleans the user provided URL to prevent double slashes before /api/qso
   */
  private static getBaseUrl(url: string): string {
    return url.replace(/\/+$/, '');
  }

  /**
   * Sends a single record. Returns success boolean.
   */
  static async pushSingleQSO(qso: QSO, config: CloudLogConfig): Promise<boolean> {
    if (!config.wavelogEnabled || !config.wavelogUrl || !config.wavelogApiKey) {
      console.warn('[Wavelog Debug] Upload skipped because Wavelog integration is disabled or missing credentials.');
      return false;
    }

    const targetUrl = `${this.getBaseUrl(config.wavelogUrl)}/api/qso`;
    const endpoint = '/api/log-proxy';
    const adifData = this.generateAdif(qso);
    
    const payload = {
      targetUrl: targetUrl,
      key: config.wavelogApiKey,
      api_key: config.wavelogApiKey,
      station_profile_id: config.wavelogStationProfileId,
      type: 'adif',
      string: adifData,
      adif: adifData
    };

    console.log(`[Wavelog Debug] Attempting to push QSO for ${qso.call} to ${targetUrl}`, {
      qsoDate: qso.qso_date,
      timeOn: qso.time_on,
      band: qso.band,
      rst_sent: qso.rst_sent,
      rst_rcvd: qso.rst_rcvd,
      gridsquare: qso.gridsquare,
      adifPayload: adifData
    });

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      console.log(`[Wavelog Debug] Received HTTP status code: ${response.status} ${response.statusText}`);

      if (response.ok) {
        let responseData: any = {};
        try {
          responseData = await response.json();
          console.log('[Wavelog Debug] API JSON Response parsed successfully:', responseData);
        } catch (jsonErr) {
          console.warn('[Wavelog Debug] Response was ok, but failed to parse response body as JSON. Assuming success.', jsonErr);
          return true;
        }

        // Standard Wavelog/Cloudlog API keys failures can return status: "failed" or similar within 200 OK
        if (responseData && (responseData.status === 'failed' || responseData.status === 'error' || responseData.status === 'auth_failed')) {
          console.error('[Wavelog Debug] QSO Upload failed according to API response content:', {
            status: responseData.status,
            reason: responseData.reason || responseData.message || 'unknown error reason'
          });
          return false;
        }

        console.log(`[Wavelog Debug] QSO for ${qso.call} successfully pushed and verified by Wavelog API.`);
        return true;
      } else {
        let errorBody: any = null;
        try {
          errorBody = await response.json();
        } catch (_) {
          try {
            errorBody = await response.text();
          } catch (_) {}
        }
        console.error(`[Wavelog Debug] Server returned failed HTTP response. Status: ${response.status}`, errorBody);
        return false;
      }
    } catch (e) {
      console.error('[Wavelog Debug] Network or unexpected exception occurred during QSO push:', e);
      return false;
    }
  }

  /**
   * Fetches all local database entries where synced === false.
   * Loops through them asynchronously, attempts to push them via pushSingleQSO,
   * and updates their local DB status to true upon success.
   */
  static async syncOfflineQueue(config: CloudLogConfig): Promise<void> {
    if (!config.wavelogEnabled || !config.wavelogUrl || !config.wavelogApiKey) {
      return;
    }

    try {
      const qsos = await logBook.getAllQSOs();
      const unsyncedQsos = qsos.filter((q) => q.synced === false);

      for (const qso of unsyncedQsos) {
        const success = await this.pushSingleQSO(qso, config);
        if (success && qso.id !== undefined) {
          await logBook.updateQSO({ ...qso, synced: true });
        }
      }
    } catch (e) {
      console.error('Failed to sync offline queue', e);
    }
  }

  /**
   * Performs a mock/lightweight validation fetch to verify credentials.
   */
  static async testWavelogConnection(url: string, apiKey: string, stationProfileId: string): Promise<{ success: boolean; message: string }> {
    try {
      const targetUrl = `${this.getBaseUrl(url)}/api/qso`;
      // Route test through the proxy to bypass CORS
      const endpoint = '/api/log-proxy';
      
      const payload = {
        targetUrl: targetUrl,
        key: apiKey,
        api_key: apiKey,
        station_profile_id: stationProfileId,
        type: 'adif',
        string: "Generated by WebFT8 <adif_ver:5>3.1.4 <eoh>\n<eor>\n",
        adif: "Generated by WebFT8 <adif_ver:5>3.1.4 <eoh>\n<eor>\n"
      };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        // Look for typical json response from Wavelog/Cloudlog
        try {
          const data = await response.json();
          // API returns e.g. { "status": "created" } or { "status": "failed", "reason": "invalid api key" }
          if (data.status === 'failed') {
             return { success: false, message: `API Error: ${data.reason || JSON.stringify(data)}` };
          }
        } catch(err) {
          // not json? just fallback to ok
        }
        return { success: true, message: 'Connection successful' };
      }
      return { success: false, message: `HTTP Error ${response.status}: ${response.statusText}` };
    } catch (e: any) {
      console.error('Failed to test Wavelog connection', e);
      // Detailed error for CORS or mixed content
      let msg = e.message || String(e);
      if (msg.includes('Failed to fetch')) {
        msg = 'Failed to fetch (Check CORS/Mixed Content. If using HTTPS app, use HTTPS Server URL)';
      }
      return { success: false, message: msg };
    }
  }
}

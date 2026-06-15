import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Inject CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Handle POST requests
  if (req.method === 'POST') {
    try {
      const { targetUrl, api_key, key, type, string, adif, station_profile_id } = req.body;

      if (!targetUrl) {
        return res.status(400).json({ status: 'failed', reason: 'Missing targetUrl in request body' });
      }

      const apiKeyToForward = key || api_key;
      const adifToForward = string || adif;

      // Forward payload to the target URL with exact keys expected by Wavelog API
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          key: apiKeyToForward,
          station_profile_id: station_profile_id,
          type: type || 'adif',
          string: adifToForward
        })
      });

      // Parse JSON from Wavelog/Cloudlog if available
      let responseData;
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        responseData = await response.json();
      } else {
        const text = await response.text();
        try {
          responseData = JSON.parse(text);
        } catch {
          responseData = { status: response.ok ? 'success' : 'failed', message: text };
        }
      }

      return res.status(response.status).json(responseData);
    } catch (error: any) {
      console.error('Proxy Error:', error);
      return res.status(500).json({ status: 'failed', reason: error.message || 'Error occurred in proxy' });
    }
  }

  // Handle other methods
  return res.status(405).json({ status: 'failed', reason: 'Method Not Allowed' });
}

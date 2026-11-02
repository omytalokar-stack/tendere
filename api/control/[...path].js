function getAllowedPath(pathValue) {
  const segments = Array.isArray(pathValue)
    ? pathValue
    : typeof pathValue === 'string' ? pathValue.split('/') : [];
  const cleanSegments = segments.filter(Boolean);
  if (cleanSegments.length === 2
    && cleanSegments[0] === 'bot'
    && ['start', 'stop'].includes(cleanSegments[1])) {
    return cleanSegments.join('/');
  }
  if (cleanSegments.length === 3
    && cleanSegments[0] === 'trades'
    && /^[a-f\d]{24}$/i.test(cleanSegments[1])
    && cleanSegments[2] === 'close') {
    return cleanSegments.join('/');
  }
  return null;
}

function validBackendUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expectedOrigin = process.env.CONTROL_DASHBOARD_ORIGIN;
  if (!expectedOrigin || req.headers.origin !== expectedOrigin) {
    return res.status(403).json({ error: 'Control request origin is not allowed' });
  }

  const token = process.env.BOT_CONTROL_TOKEN;
  if (!token) return res.status(503).json({ error: 'Bot control gateway is not configured' });

  const backendUrl = process.env.PAPER_TRADING_API_URL;
  const allowedPath = getAllowedPath(req.query?.path);
  if (!validBackendUrl(backendUrl) || !allowedPath) {
    return res.status(503).json({ error: 'Bot control gateway configuration or action is invalid' });
  }

  try {
    const response = await fetch(`${backendUrl.replace(/\/+$/, '')}/api/${allowedPath}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    const body = await response.text();
    res.status(response.status);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
    return res.send(body);
  } catch {
    return res.status(502).json({ error: 'Paper trading backend is unavailable' });
  }
}

export { getAllowedPath };

/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Custom server entry point for Railway deployments.
 * Handles the case where Railway is configured to run `node server.js`.
 * Starts Next.js on $PORT (Railway-injected) or defaults to 3000.
 */
const { createServer } = require('http');
const { parse, URL } = require('url');
const next = require('next');
const { WebSocketServer } = require('ws');

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '3000', 10);
const hostname = '0.0.0.0';

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

function parseSseFrame(rawFrame) {
  const frame = rawFrame.replace(/\r/g, '');
  const lines = frame.split('\n');
  let event = 'message';
  const dataLines = [];

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim() || 'message';
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) return null;
  return { event, data: dataLines.join('\n') };
}

async function bridgeSseToWebSocket(ws, req) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${port}`}`);
  const upstreamUrl = new URL('/api/stream', `http://127.0.0.1:${port}`);
  const connId = requestUrl.searchParams.get('conn_id');
  if (connId) upstreamUrl.searchParams.set('conn_id', connId);

  const abortController = new AbortController();
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(pingTimer);
    abortController.abort();
  };

  const pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 25_000);

  ws.on('close', cleanup);
  ws.on('error', cleanup);
  ws.on('message', (buffer) => {
    try {
      const payload = JSON.parse(buffer.toString());
      if (payload?.type === 'ping' && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      }
    } catch {
      // Ignore malformed client messages; the browser stream is read-only.
    }
  });

  try {
    const upstream = await fetch(upstreamUrl, {
      signal: abortController.signal,
      headers: {
        Accept: 'text/event-stream',
        Cookie: req.headers.cookie || '',
      },
      cache: 'no-store',
    });

    if (!upstream.ok || !upstream.body) {
      if (ws.readyState === ws.OPEN) ws.close(1011, 'upstream_unavailable');
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const rawFrame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseSseFrame(rawFrame);
        if (frame && ws.readyState === ws.OPEN) {
          try {
            const payload = JSON.parse(frame.data);
            if (!payload.type) payload.type = frame.event;
            ws.send(JSON.stringify(payload));
          } catch {
            ws.send(JSON.stringify({ type: frame.event, raw: frame.data }));
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }

    if (!closed && ws.readyState === ws.OPEN) {
      ws.close(1000, 'upstream_closed');
    }
  } catch {
    if (!closed && ws.readyState === ws.OPEN) {
      ws.close(1011, 'upstream_error');
    }
  } finally {
    cleanup();
  }
}

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error handling request:', req.url, err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    void bridgeSseToWebSocket(ws, req);
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${port}`}`);
    if (url.pathname !== '/ws/stream') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  server.listen(port, hostname, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});

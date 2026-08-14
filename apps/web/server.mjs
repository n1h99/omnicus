import { createReadStream, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDistDirectory = fileURLToPath(new URL('./dist/', import.meta.url));

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

function loadApiOrigin(distDirectory, logger) {
  try {
    const runtimeConfig = JSON.parse(
      readFileSync(resolve(distDirectory, 'runtime-config.json'), 'utf8'),
    );
    const apiUrl = new URL(runtimeConfig.apiUrl);
    if (apiUrl.protocol !== 'http:' && apiUrl.protocol !== 'https:') {
      throw new Error('runtime API URL must use HTTP or HTTPS');
    }
    return apiUrl.origin;
  } catch (error) {
    logger({
      level: 'warn',
      message:
        error instanceof Error
          ? `Runtime API origin unavailable: ${error.message}`
          : 'Runtime API origin unavailable',
      service: 'web',
    });
    return undefined;
  }
}

function createSecurityHeaders(apiOrigin) {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'self'",
      `connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ''} https://connect.facebook.net https://www.facebook.com https://web.facebook.com https://graph.facebook.com`,
      "font-src 'self' data:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      'frame-src https://www.facebook.com https://web.facebook.com',
      "img-src 'self' data: https:",
      "object-src 'none'",
      "script-src 'self' https://connect.facebook.net",
      "style-src 'self' 'unsafe-inline'",
    ].join('; '),
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

class HttpRequestError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function writeHeaders(response, securityHeaders, headers = {}) {
  for (const [name, value] of Object.entries({ ...securityHeaders, ...headers })) {
    response.setHeader(name, value);
  }
}

function sendJson(response, securityHeaders, statusCode, body) {
  writeHeaders(response, securityHeaders, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.statusCode = statusCode;
  response.end(JSON.stringify(body));
}

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function proxyHeaders(requestHeaders, target) {
  const headers = {};
  for (const [name, value] of Object.entries(requestHeaders)) {
    const normalizedName = name.toLowerCase();
    if (
      value !== undefined &&
      !hopByHopHeaders.has(normalizedName) &&
      !normalizedName.startsWith('x-forwarded-')
    ) {
      headers[name] = value;
    }
  }
  headers.host = target.host;
  return headers;
}

function resolveProxyTarget(requestUrl, apiOrigin) {
  const incomingUrl = new URL(requestUrl ?? '/api', 'http://web.invalid');
  const target = new URL(apiOrigin);
  target.pathname = incomingUrl.pathname;
  target.search = incomingUrl.search;
  return target;
}

async function proxyApiRequest(request, response, apiOrigin, securityHeaders) {
  if (!apiOrigin) {
    throw new HttpRequestError(503, 'API_PROXY_UNAVAILABLE', 'API proxy is not configured');
  }

  const target = resolveProxyTarget(request.url, apiOrigin);
  const requester = target.protocol === 'https:' ? httpsRequest : httpRequest;

  await new Promise((resolveProxy, rejectProxy) => {
    const outgoing = requester(
      target,
      {
        headers: proxyHeaders(request.headers, target),
        method: request.method,
      },
      (upstream) => {
        response.statusCode = upstream.statusCode ?? 502;
        for (const [name, value] of Object.entries(upstream.headers)) {
          if (value !== undefined && !hopByHopHeaders.has(name.toLowerCase())) {
            response.setHeader(name, value);
          }
        }
        writeHeaders(response, securityHeaders);
        upstream.once('error', rejectProxy);
        upstream.pipe(response);
        response.once('finish', resolveProxy);
      },
    );

    outgoing.once('error', rejectProxy);
    request.once('aborted', () => outgoing.destroy());
    request.pipe(outgoing);
  });
}

function decodeRequestPath(requestUrl) {
  const rawUrl = requestUrl ?? '/';

  try {
    decodeURIComponent(rawUrl);
    const parsedUrl = new URL(rawUrl, 'http://web.invalid');
    return decodeURIComponent(parsedUrl.pathname);
  } catch {
    throw new HttpRequestError(400, 'MALFORMED_URL', 'Malformed URL encoding');
  }
}

function resolveCandidate(distDirectory, requestPath) {
  const candidate = resolve(distDirectory, requestPath.replace(/^[/\\]+/, ''));
  const relativeCandidate = relative(distDirectory, candidate);

  if (
    relativeCandidate === '..' ||
    relativeCandidate.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(relativeCandidate)
  ) {
    throw new HttpRequestError(400, 'INVALID_PATH', 'Invalid request path');
  }

  return candidate;
}

async function resolveFilePath(distDirectory, requestPath) {
  const candidate = resolveCandidate(distDirectory, requestPath);

  try {
    const candidateHandle = await open(candidate, 'r');
    const candidateStat = await candidateHandle.stat();
    await candidateHandle.close();

    if (candidateStat.isFile()) {
      return candidate;
    }

    if (candidateStat.isDirectory()) {
      return resolve(candidate, 'index.html');
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
      throw error;
    }
  }

  if (extname(requestPath).length > 0) {
    throw new HttpRequestError(404, 'ASSET_NOT_FOUND', 'Static asset was not found');
  }

  return resolve(distDirectory, 'index.html');
}

async function serveFile(response, requestMethod, filePath, fileOpener, securityHeaders) {
  const fileHandle = await fileOpener(filePath, 'r');

  try {
    const fileStat = await fileHandle.stat();
    if (!fileStat.isFile()) {
      throw new HttpRequestError(404, 'ASSET_NOT_FOUND', 'Static asset was not found');
    }

    writeHeaders(response, securityHeaders, {
      'Cache-Control': filePath.endsWith('index.html')
        ? 'no-cache'
        : 'public, max-age=31536000, immutable',
      'Content-Length': String(fileStat.size),
      'Content-Type': contentTypes.get(extname(filePath)) ?? 'application/octet-stream',
    });
    response.statusCode = 200;

    if (requestMethod === 'HEAD') {
      response.end();
      return;
    }

    await pipeline(createReadStream('', { fd: fileHandle.fd, autoClose: false }), response);
  } finally {
    await fileHandle.close().catch(() => undefined);
  }
}

function defaultLogger(entry) {
  const stream = entry.level === 'error' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(entry)}\n`);
}

export function createWebServer({
  apiOrigin,
  distDirectory = defaultDistDirectory,
  fileOpener = open,
  logger = defaultLogger,
} = {}) {
  const resolvedDistDirectory = resolve(distDirectory);
  const resolvedApiOrigin = apiOrigin ?? loadApiOrigin(resolvedDistDirectory, logger);
  const securityHeaders = createSecurityHeaders(resolvedApiOrigin);

  return createServer((request, response) => {
    void (async () => {
      const requestPath = decodeRequestPath(request.url);

      if (requestPath === '/api' || requestPath.startsWith('/api/')) {
        await proxyApiRequest(request, response, resolvedApiOrigin, securityHeaders);
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new HttpRequestError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      }

      if (requestPath === '/health/live') {
        sendJson(response, securityHeaders, 200, {
          data: { service: 'web', status: 'live' },
          meta: {},
        });
        return;
      }

      if (requestPath === '/health/ready') {
        const indexPath = resolve(resolvedDistDirectory, 'index.html');
        const indexHandle = await fileOpener(indexPath, 'r');
        try {
          const indexStat = await indexHandle.stat();
          if (!indexStat.isFile()) {
            throw new HttpRequestError(503, 'WEB_BUILD_MISSING', 'Web build is not available');
          }
        } finally {
          await indexHandle.close().catch(() => undefined);
        }
        sendJson(response, securityHeaders, 200, {
          data: { service: 'web', status: 'ready' },
          meta: {},
        });
        return;
      }

      const filePath = await resolveFilePath(resolvedDistDirectory, requestPath);
      await serveFile(response, request.method, filePath, fileOpener, securityHeaders);
    })().catch((error) => {
      const requestError = error instanceof HttpRequestError ? error : undefined;

      logger({
        code: requestError?.code ?? 'WEB_REQUEST_FAILED',
        level: requestError && requestError.statusCode < 500 ? 'warn' : 'error',
        message: error instanceof Error ? error.message : 'Unknown web server error',
        method: request.method,
        path: request.url?.split('?', 1)[0],
        service: 'web',
      });

      if (response.headersSent) {
        response.destroy();
        return;
      }

      sendJson(response, securityHeaders, requestError?.statusCode ?? 500, {
        error: {
          code: requestError?.code ?? 'WEB_INTERNAL_ERROR',
          message: requestError?.message ?? 'An internal server error occurred',
        },
      });
    });
  });
}

export async function startWebServer() {
  const portValue = process.env.PORT ?? '3000';
  const port = Number(portValue);
  const host = process.env.HOST ?? '0.0.0.0';

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535; received ${portValue}`);
  }

  const server = createWebServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  defaultLogger({
    host,
    level: 'log',
    message: 'Web server started',
    port,
    service: 'web',
  });

  let closing = false;
  const shutdown = (signal) => {
    if (closing) {
      return;
    }
    closing = true;
    defaultLogger({
      level: 'log',
      message: 'Web server shutting down',
      service: 'web',
      signal,
    });
    server.close((error) => {
      process.exitCode = error ? 1 : 0;
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  void startWebServer().catch((error) => {
    defaultLogger({
      level: 'error',
      message: error instanceof Error ? error.message : 'Unknown web bootstrap error',
      service: 'web',
    });
    process.exitCode = 1;
  });
}

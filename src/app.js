const express = require('express');
const path = require('path');
const healthRouter = require('./routes/health');
const briefRouter = require('./routes/brief');
const transitRouter = require('./routes/transit');
const radioRouter = require('./routes/radio');
const cinemaRouter = require('./routes/cinema');
const mastersRouter = require('./routes/masters');
const plansRouter = require('./routes/plans');
const log = require('./log');

const app = express();

/*
 * Behind Vercel (and any other proxy) the TLS terminates upstream, so the
 * request reaching this process is plain HTTP. Without this, `req.protocol`
 * reads "http" and every download URL handed to a client is built as
 * http://... -- which browsers upgrade or block, and which looks wrong in a
 * quotation. Trusting the proxy makes req.protocol follow X-Forwarded-Proto.
 */
app.set('trust proxy', true);

app.use(express.json());

app.use('/transit', express.static(path.join(__dirname, 'public/transit')));
app.use('/radio', express.static(path.join(__dirname, 'public/radio')));
app.use('/cinema', express.static(path.join(__dirname, 'public/cinema')));
app.use('/masters', express.static(path.join(__dirname, 'public/masters')));
app.use('/media-catalog', express.static(path.join(__dirname, 'public/media-catalog')));
for (const medium of ['btl', 'digital', 'digital-pr', 'magazine', 'newspaper', 'tv']) {
  app.use(`/${medium}`, express.static(path.join(__dirname, `public/${medium}`)));
}
app.use('/master-images', (req, res, next) => {
  if (!/\.(png|jpe?g|webp|avif|gif|svg)$/i.test(req.path)) return res.sendStatus(404);
  next();
}, express.static(path.join(__dirname, 'assets/Masters'), {
  immutable: true,
  maxAge: '7d',
  setHeaders(res, filePath) {
    if (/\.svg$/i.test(filePath)) res.setHeader('Content-Security-Policy', 'sandbox');
  }
}));
app.use(
  '/transit-images',
  express.static(path.join(__dirname, 'assets/Masters/Transit/product-images'), {
    fallthrough: true,
    immutable: true,
    maxAge: '7d'
  })
);
app.use('/radio-images', express.static(path.join(__dirname, 'assets/Masters/Radio/product-images/product'), { immutable: true, maxAge: '7d' }));
app.use('/cinema-images', express.static(path.join(__dirname, 'assets/Masters/Cinema/Images'), { immutable: true, maxAge: '7d' }));

// Correlate every API request without logging query strings, request bodies or
// authorization headers. Health probes are deliberately skipped to keep
// Railway logs useful rather than filling them with polling noise.
app.use((req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/health/')) return next();

  const started = Date.now();
  const method = req.method;
  const requestPath = req.path;
  req.requestId = log.requestId(req.get('x-request-id'));
  res.setHeader('X-Request-Id', req.requestId);

  log.withContext({ request_id: req.requestId }, () => {
    log.info('http.request.started', { method, path: requestPath });

    let completed = false;
    res.once('finish', () => {
      completed = true;
      const fields = {
        method,
        path: requestPath,
        status: res.statusCode,
        duration_ms: Date.now() - started,
        response_bytes: Number(res.getHeader('content-length')) || undefined
      };
      if (res.statusCode >= 500) log.error('http.request.completed', fields);
      else if (res.statusCode >= 400) log.warn('http.request.completed', fields);
      else log.info('http.request.completed', fields);
      void log.flush();
    });

    res.once('close', () => {
      if (!completed) {
        log.warn('http.request.aborted', {
          method,
          path: requestPath,
          status: res.statusCode,
          duration_ms: Date.now() - started
        });
        void log.flush();
      }
    });
    next();
  });
});

app.use('/health', healthRouter);
app.use('/brief', briefRouter);
app.use('/plans', plansRouter);
app.use('/api/transit', transitRouter);
app.use('/api/radio', radioRouter);
app.use('/api/cinema', cinemaRouter);
app.use('/api/masters', mastersRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.originalUrl });
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((err, req, res, next) => {
  log.error('http.request.failed', {
    request_id: req.requestId,
    method: req.method,
    path: req.path,
    error: log.errorDetails(err)
  });
  res.status(err.status || 500).json({
    status: 'error',
    code: err.code || 'internal_error',
    message: err.message || 'Internal Server Error'
  });
});

module.exports = app;

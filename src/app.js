const express = require('express');
const path = require('path');
const healthRouter = require('./routes/health');
const briefRouter = require('./routes/brief');
const transitRouter = require('./routes/transit');
const radioRouter = require('./routes/radio');

const app = express();

app.use(express.json());

app.use('/transit', express.static(path.join(__dirname, 'public/transit')));
app.use('/radio', express.static(path.join(__dirname, 'public/radio')));
app.use(
  '/transit-images',
  express.static(path.join(__dirname, 'assets/Masters/Transit/product-images'), {
    fallthrough: true,
    immutable: true,
    maxAge: '7d'
  })
);
app.use('/radio-images', express.static(path.join(__dirname, 'assets/Masters/Radio/product-images/product'), { immutable: true, maxAge: '7d' }));

app.use('/health', healthRouter);
app.use('/brief', briefRouter);
app.use('/api/transit', transitRouter);
app.use('/api/radio', radioRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.originalUrl });
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

module.exports = app;

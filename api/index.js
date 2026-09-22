/**
 * The Vercel entrypoint.
 *
 * Vercel does not run a long-lived process, so it never calls src/server.js --
 * that file's `app.listen()` is for local development and for any host that
 * runs a real server (Railway, Render, a VM). Here the platform imports this
 * module and calls the exported handler once per request.
 *
 * Express apps are themselves `(req, res) => void` handlers, so exporting the
 * app is all that is required. vercel.json rewrites every path to this file, so
 * the routing inside src/app.js stays the single source of truth and nothing has
 * to be listed twice.
 */

module.exports = require('../src/app');

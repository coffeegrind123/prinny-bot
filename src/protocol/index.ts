/**
 * The wire protocol on its own, with no matrix-js-sdk dependency.
 *
 * Importable as `@prinny/bot/protocol` by anything that needs to read or
 * validate `app.prinny.bot.*` without running a bot — a Matrix client
 * renderer, most obviously.
 */

export * from './constants.js';
export * from './types.js';
export * from './validate.js';

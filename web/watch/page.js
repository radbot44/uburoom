// @ts-check
import { store } from './store.js';
/* Element lookup for the watch page's fixed markup (including when #stage is inside Document PiP). */
/** @param {string} id */
export const $ = id =>
  /** @type {any} */ (document.getElementById(id) || store.player.pipWindow?.document?.getElementById(id));

'use strict';

/*
 * The prompt library: every prompt Higgsfield ships in Marketing Studio
 * (hook scripts, scene prompts), harvested from their API into
 * catalog/higgsfield/prompt-library.json. This is the raw material the
 * prompt agent studies to write better generation prompts, and the lookup
 * table for injecting full prompt text where an engine only got a name.
 */

const LIBRARY = require('../../../catalog/higgsfield/prompt-library.json');

function findHook(idOrName) {
  return LIBRARY.hooks.find(function (h) { return h.id === idOrName || h.name === idOrName; }) || null;
}

function findSetting(idOrName) {
  return LIBRARY.settings.find(function (s) { return s.id === idOrName || s.name === idOrName; }) || null;
}

/* The library rendered as study material for the prompt agent. */
function asExemplars() {
  const lines = ['PROVEN HOOK SCRIPTS (openers that stop the scroll):'];
  LIBRARY.hooks.forEach(function (h) { lines.push('- ' + h.name + ': ' + h.prompt); });
  lines.push('', 'PROVEN SCENE PROMPTS (settings that read as real):');
  LIBRARY.settings.forEach(function (s) { lines.push('- ' + s.name + ': ' + s.prompt); });
  return lines.join('\n');
}

module.exports = { LIBRARY, findHook, findSetting, asExemplars };

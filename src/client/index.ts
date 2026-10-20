import { createClientPlugin } from './plugin.js';

window.__ModuleLoader__.load({
  id: 'dsh-session-delete-local',
  factory(require) {
    // Obtain React and UI controls from the host, preserving native themes and focus handling.
    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const renderer = require('react-dom');
    return createClientPlugin(React, primitives, renderer);
  },
});

/**
 * Declarative record/replay step identifiers shared by graph policy and the
 * Rust contract export. Keep this module independent of graph algorithms.
 */
export const RR_STEP_TYPES = {
  CLICK: 'click',
  DBLCLICK: 'dblclick',
  FILL: 'fill',
  DRAG: 'drag',
  KEY: 'key',
  WAIT: 'wait',
  ASSERT: 'assert',
  IF: 'if',
  FOREACH: 'foreach',
  WHILE: 'while',
  NAVIGATE: 'navigate',
  SCRIPT: 'script',
  HTTP: 'http',
  EXTRACT: 'extract',
  SCREENSHOT: 'screenshot',
  SCROLL: 'scroll',
  TRIGGER_EVENT: 'triggerEvent',
  SET_ATTRIBUTE: 'setAttribute',
  LOOP_ELEMENTS: 'loopElements',
  SWITCH_FRAME: 'switchFrame',
  OPEN_TAB: 'openTab',
  SWITCH_TAB: 'switchTab',
  CLOSE_TAB: 'closeTab',
  EXECUTE_FLOW: 'executeFlow',
  HANDLE_DOWNLOAD: 'handleDownload',
  // UI-only, mapped to WAIT
  DELAY: 'delay',
} as const;

export type RRStepType = (typeof RR_STEP_TYPES)[keyof typeof RR_STEP_TYPES];

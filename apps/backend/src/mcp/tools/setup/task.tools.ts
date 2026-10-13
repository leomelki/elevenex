import { TASK_DISCOVERY_TOOLS } from './task-discovery.tools.js';
import { TASK_LIFECYCLE_TOOLS } from './task-lifecycle.tools.js';
import { TASK_COMPOSER_TOOLS } from './task-composer.tools.js';

/** Task primitives grouped by discovery, lifecycle and composer responsibility. */
export const TASK_TOOLS = [
  ...TASK_DISCOVERY_TOOLS,
  ...TASK_LIFECYCLE_TOOLS,
  ...TASK_COMPOSER_TOOLS,
];

// Startup hook: keep <stateDir>/current pointing at this installation.
import { refreshCurrentLink } from './paths.js';

refreshCurrentLink();

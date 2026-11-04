/**
 * Run every test file in one process. `node --test` spawns a child per file,
 * which is blocked by the Windows sandbox's piped-stdio restriction; importing
 * the test modules directly keeps the runner in-process and still exits
 * non-zero on failure.
 */
import '../test/peak.test.mjs'
import '../test/pause.test.mjs'
import '../test/state.test.mjs'
import '../test/data.test.mjs'
import '../test/update.test.mjs'
import '../test/pre-step.test.mjs'

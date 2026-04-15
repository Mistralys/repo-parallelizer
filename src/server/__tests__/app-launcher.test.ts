import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchApplication } from '../app-launcher.js';

// ---------------------------------------------------------------------------
// launchApplication
// ---------------------------------------------------------------------------

test('launchApplication: resolves when spawning a known-good command', async () => {
    // `node --version` is a safe, cross-platform command that exits cleanly.
    // Because the process is detached and unref'd we only care that spawn
    // succeeds — we do not wait for the child to exit.
    await assert.doesNotReject(() => launchApplication('node', ['--version']));
});

test('launchApplication: rejects with a descriptive error for a non-existent command', async () => {
    const bogus = '__non_existent_command_paralizer_test__';

    await assert.rejects(
        () => launchApplication(bogus, []),
        (err: unknown) => {
            assert.ok(err instanceof Error, 'should be an Error instance');
            assert.ok(
                err.message.includes(bogus),
                `error message should mention the command — got: ${err.message}`,
            );
            assert.ok(
                err.message.startsWith('Failed to launch application'),
                `error message should start with the expected prefix — got: ${err.message}`,
            );
            return true;
        },
    );
});

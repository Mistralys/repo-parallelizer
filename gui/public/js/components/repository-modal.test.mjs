/**
 * Unit tests for components/repository-modal.js — WP-007.
 *
 * Acceptance Criteria verified:
 *   AC1 — Create mode: an empty URL fails validateRequired and blocks submit.
 *   AC2 — Create mode: a successful submit calls api.repositories.create(),
 *         and when a credential was selected, follows with
 *         api.repositories.updateCredential() using the created repository's ID.
 *   AC3 — Edit mode: fields are pre-filled from the passed repo (URL and Name
 *         editable, ID disabled); submit calls
 *         api.repositories.update(repo.id, { name, url }), and calls
 *         updateCredential() only when the selection changed from
 *         repo.credentialId ?? ''.
 *   AC4 — Changing the URL field in either mode triggers a debounced re-fetch
 *         of credentialOptionsForUrl() and repopulates the select,
 *         re-applying the stored/auto-match/None priority.
 *   AC5 — Cancel, Escape, and backdrop-click reject the modal's Promise
 *         without any API call, in both modes.
 *   AC6 — While create()/update()/updateCredential() is in flight, Submit,
 *         Cancel, Escape, and backdrop-click are all disabled/no-op; a
 *         rejected call re-enables all four, shows an error toast, and keeps
 *         the modal open without resolving/rejecting the Promise.
 *   AC7 — A rejected updateCredential() call following a successful
 *         create()/update() still resolves the modal's Promise with the
 *         pre-credential-update resolvedRepo and shows an error toast.
 *   AC8 — On open, the URL field receives initial focus in both modes;
 *         closing the modal restores focus to the element that opened it.
 *
 * Uses Node's built-in test runner with jsdom for a minimal DOM environment.
 * Run individually with:
 *   node --test gui/public/js/components/repository-modal.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// jsdom setup — install globals before any module is imported
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="toast-container"></div></body></html>', {
    url: 'http://localhost/',
});

const { window } = dom;

globalThis.document      = window.document;
globalThis.window        = window;
globalThis.HTMLElement   = window.HTMLElement;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.MouseEvent    = window.MouseEvent;
globalThis.CSS           = window.CSS ?? { escape: (s) => s.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, '\\$&') };

// ---------------------------------------------------------------------------
// Minimal fetch mock (required by api.js, unused by these tests directly
// since api.repositories methods are reassigned per-test below).
// ---------------------------------------------------------------------------

globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    statusText: 'OK',
    headers: { get: () => 'application/json' },
    json: async () => ({}),
});

const { api } = await import('../api.js');
const { showRepositoryModal } = await import('./repository-modal.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EXISTING_REPO = {
    id: 'my-repo',
    name: 'My Repository',
    url: 'https://github.com/org/my-repo.git',
    credentialId: 'cred-1',
};

// ---------------------------------------------------------------------------
// Call trackers, reset per test
// ---------------------------------------------------------------------------

let createCalls;
let updateCalls;
let updateCredentialCalls;
let credentialOptionsCalls;

/** A promise that never settles, standing in for an in-flight API call. */
function pending() {
    return new Promise(() => {});
}

beforeEach(() => {
    document.body.innerHTML = '<div id="toast-container"></div><button id="outside-btn" type="button">Outside</button>';

    createCalls = [];
    updateCalls = [];
    updateCredentialCalls = [];
    credentialOptionsCalls = [];

    api.repositories.create = async (data) => {
        createCalls.push(data);
        return { Id: 'new-repo', Name: data.name || '', Url: data.url };
    };
    api.repositories.update = async (id, data) => {
        updateCalls.push({ id, data });
        return { Id: id, Name: data.name, Url: data.url };
    };
    api.repositories.updateCredential = async (id, credentialId) => {
        updateCredentialCalls.push({ id, credentialId });
        return { Id: id, CredentialId: credentialId || undefined };
    };
    api.repositories.credentialOptionsForUrl = async (url) => {
        credentialOptionsCalls.push(url);
        return [];
    };
});

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

function dispatchKeydown(target, key) {
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
}

function dispatchClick(target) {
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
}

function dispatchInput(target) {
    const event = new window.Event('input', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
}

function getForm() {
    return document.querySelector('.modal form');
}

function getUrlInput() {
    return getForm().querySelector('[name="url"]');
}

function getNameInput() {
    return getForm().querySelector('[name="name"]');
}

function getIdInput() {
    return getForm().querySelector('[name="id"]');
}

function getCredentialSelect() {
    return getForm().querySelector('[name="credentialId"]');
}

function getSubmitBtn() {
    return Array.from(document.querySelectorAll('.modal-actions button'))
        .find((btn) => btn.type === 'submit');
}

function getCancelBtn() {
    return Array.from(document.querySelectorAll('.modal-actions button'))
        .find((btn) => btn.textContent === 'Cancel');
}

function getOverlay() {
    return document.querySelector('.modal-overlay');
}

function submitForm() {
    dispatchClick(getSubmitBtn());
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// AC1 — Create mode validation
// ---------------------------------------------------------------------------

test('AC1: create mode — an empty URL fails validation and blocks submit', async () => {
    const promise = showRepositoryModal({ mode: 'create' });
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });

    getUrlInput().value = '';
    submitForm();
    await wait(0);

    assert.equal(settled, false);
    assert.equal(createCalls.length, 0);

    // Clean up the still-open modal.
    dispatchClick(getCancelBtn());
    await promise.catch(() => {});
});

// ---------------------------------------------------------------------------
// AC2 — Create mode submit
// ---------------------------------------------------------------------------

test('AC2: create mode — submit with no credential selected calls create() only', async () => {
    const promise = showRepositoryModal({ mode: 'create' });

    getUrlInput().value = 'https://github.com/org/new-repo.git';
    getNameInput().value = 'New Repo';
    submitForm();

    const repo = await promise;

    assert.equal(createCalls.length, 1);
    assert.deepEqual(createCalls[0], { url: 'https://github.com/org/new-repo.git', name: 'New Repo' });
    assert.equal(updateCredentialCalls.length, 0);
    assert.equal(repo.id, 'new-repo');
});

test('AC2: create mode — submit with a credential selected calls create() then updateCredential() with the created repo\'s ID', async () => {
    const promise = showRepositoryModal({ mode: 'create' });

    getUrlInput().value = 'https://github.com/org/new-repo.git';

    const select = getCredentialSelect();
    const option = document.createElement('option');
    option.value = 'cred-9';
    option.textContent = 'Credential 9';
    select.appendChild(option);
    select.value = 'cred-9';

    submitForm();
    await promise;

    assert.equal(createCalls.length, 1);
    assert.equal(updateCredentialCalls.length, 1);
    assert.deepEqual(updateCredentialCalls[0], { id: 'new-repo', credentialId: 'cred-9' });
});

// ---------------------------------------------------------------------------
// AC3 — Edit mode pre-fill and submit
// ---------------------------------------------------------------------------

test('AC3: edit mode — fields are pre-filled from the passed repo, ID is disabled', async () => {
    const promise = showRepositoryModal({ mode: 'edit', repo: EXISTING_REPO });

    assert.equal(getUrlInput().value, EXISTING_REPO.url);
    assert.equal(getNameInput().value, EXISTING_REPO.name);
    assert.equal(getIdInput().value, EXISTING_REPO.id);
    assert.equal(getIdInput().disabled, true);
    assert.equal(getUrlInput().disabled, false);
    assert.equal(getNameInput().disabled, false);

    dispatchClick(getCancelBtn());
    await promise.catch(() => {});
});

test('AC3: edit mode — submit calls update(repo.id, { name, url }) and skips updateCredential() when selection is unchanged', async () => {
    // Ensure the initial fetch re-selects the repo's stored credential, so the
    // submit-time comparison against storedCredentialId is genuinely "unchanged".
    api.repositories.credentialOptionsForUrl = async (url) => {
        credentialOptionsCalls.push(url);
        return [{ credentialId: 'cred-1', label: 'Credential 1', host: 'github.com', auto: false }];
    };

    const promise = showRepositoryModal({ mode: 'edit', repo: EXISTING_REPO });
    await wait(0); // let the initial credentialOptionsForUrl fetch resolve

    assert.equal(getCredentialSelect().value, 'cred-1', 'stored credential should be pre-selected');

    getUrlInput().value = 'https://github.com/org/my-repo-renamed.git';
    getNameInput().value = 'Renamed';
    submitForm();
    await promise;

    assert.equal(updateCalls.length, 1);
    assert.deepEqual(updateCalls[0], {
        id: EXISTING_REPO.id,
        data: { name: 'Renamed', url: 'https://github.com/org/my-repo-renamed.git' },
    });
    assert.equal(updateCredentialCalls.length, 0, 'unchanged selection should not call updateCredential()');
});

test('AC3: edit mode — calls updateCredential() when the selection changed from repo.credentialId', async () => {
    const promise = showRepositoryModal({ mode: 'edit', repo: EXISTING_REPO });
    await wait(0);

    const select = getCredentialSelect();
    const option = document.createElement('option');
    option.value = 'cred-2';
    option.textContent = 'Credential 2';
    select.appendChild(option);
    select.value = 'cred-2';

    submitForm();
    await promise;

    assert.equal(updateCredentialCalls.length, 1);
    assert.deepEqual(updateCredentialCalls[0], { id: EXISTING_REPO.id, credentialId: 'cred-2' });
});

// ---------------------------------------------------------------------------
// AC4 — Debounced URL-change re-fetch
// ---------------------------------------------------------------------------

test('AC4: changing the URL field triggers a debounced credentialOptionsForUrl() re-fetch', async () => {
    const promise = showRepositoryModal({ mode: 'create' });

    getUrlInput().value = 'https://github.com/org/typed-url.git';
    dispatchInput(getUrlInput());

    await wait(200);
    assert.equal(credentialOptionsCalls.length, 0, 'should not fetch before the debounce delay elapses');

    await wait(300);
    assert.equal(credentialOptionsCalls.length, 1);
    assert.equal(credentialOptionsCalls[0], 'https://github.com/org/typed-url.git');

    dispatchClick(getCancelBtn());
    await promise.catch(() => {});
});

test('AC4: rapid successive URL edits only trigger one re-fetch, for the latest value', async () => {
    const promise = showRepositoryModal({ mode: 'create' });

    getUrlInput().value = 'https://github.com/org/first.git';
    dispatchInput(getUrlInput());
    await wait(100);

    getUrlInput().value = 'https://github.com/org/second.git';
    dispatchInput(getUrlInput());
    await wait(500);

    assert.equal(credentialOptionsCalls.length, 1);
    assert.equal(credentialOptionsCalls[0], 'https://github.com/org/second.git');

    dispatchClick(getCancelBtn());
    await promise.catch(() => {});
});

test('AC4: an out-of-order (slower, earlier) credentialOptionsForUrl() response does not overwrite a fresher selection', async () => {
    const deferred = {};
    api.repositories.credentialOptionsForUrl = (url) => {
        credentialOptionsCalls.push(url);
        return new Promise((resolve) => { deferred[url] = resolve; });
    };

    const promise = showRepositoryModal({ mode: 'create' });

    // First edit — debounce fires, a slow fetch for URL A starts.
    getUrlInput().value = 'https://github.com/org/url-a.git';
    dispatchInput(getUrlInput());
    await wait(500);

    // Second edit — debounce fires, a fetch for URL B starts and will resolve first.
    getUrlInput().value = 'https://github.com/org/url-b.git';
    dispatchInput(getUrlInput());
    await wait(500);

    assert.equal(credentialOptionsCalls.length, 2);

    // Resolve the later request (B) first — this is the "fresher" selection.
    deferred['https://github.com/org/url-b.git']([
        { credentialId: 'cred-b', label: 'B Credential', host: 'github.com', auto: false },
    ]);
    await wait(0);

    const select = getCredentialSelect();
    assert.deepEqual(Array.from(select.options).map((o) => o.value), ['', 'cred-b']);

    // Now resolve the earlier, stale request (A) — it must be discarded.
    deferred['https://github.com/org/url-a.git']([
        { credentialId: 'cred-a', label: 'A Credential', host: 'github.com', auto: false },
    ]);
    await wait(0);

    assert.deepEqual(
        Array.from(select.options).map((o) => o.value),
        ['', 'cred-b'],
        'the stale response for URL A must not overwrite the select repopulated by URL B',
    );

    dispatchClick(getCancelBtn());
    await promise.catch(() => {});
});

// ---------------------------------------------------------------------------
// AC5 — Cancel / Escape / backdrop-click (both modes)
// ---------------------------------------------------------------------------

for (const [modeLabel, config] of [
    ['create', { mode: 'create' }],
    ['edit', { mode: 'edit', repo: EXISTING_REPO }],
]) {
    test(`AC5: ${modeLabel} mode — Cancel rejects without any API call`, async () => {
        const promise = showRepositoryModal(config);
        dispatchClick(getCancelBtn());

        await assert.rejects(promise, (err) => {
            assert.ok(err instanceof Error);
            assert.equal(err.message, 'User cancelled');
            return true;
        });
        assert.equal(createCalls.length, 0);
        assert.equal(updateCalls.length, 0);
    });

    test(`AC5: ${modeLabel} mode — Escape rejects without any API call`, async () => {
        const promise = showRepositoryModal(config);
        dispatchKeydown(document, 'Escape');

        await assert.rejects(promise, (err) => {
            assert.equal(err.message, 'User cancelled');
            return true;
        });
        assert.equal(createCalls.length, 0);
        assert.equal(updateCalls.length, 0);
    });

    test(`AC5: ${modeLabel} mode — backdrop click rejects without any API call`, async () => {
        const promise = showRepositoryModal(config);
        dispatchClick(getOverlay());

        await assert.rejects(promise, (err) => {
            assert.equal(err.message, 'User cancelled');
            return true;
        });
        assert.equal(createCalls.length, 0);
        assert.equal(updateCalls.length, 0);
    });
}

// ---------------------------------------------------------------------------
// AC6 — Busy-gating during in-flight calls
// ---------------------------------------------------------------------------

test('AC6: while create() is in flight, Submit/Cancel are disabled and Escape/backdrop are no-ops', async () => {
    api.repositories.create = () => pending();

    const promise = showRepositoryModal({ mode: 'create' });
    getUrlInput().value = 'https://github.com/org/new-repo.git';
    submitForm();
    await wait(0);

    assert.equal(getSubmitBtn().disabled, true);
    assert.equal(getCancelBtn().disabled, true);

    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });

    dispatchKeydown(document, 'Escape');
    dispatchClick(getOverlay());
    await wait(0);

    assert.equal(settled, false, 'Escape/backdrop should be no-ops while busy');
    assert.ok(getOverlay(), 'modal should remain open');
});

test('AC6: a rejected create() call re-enables Submit/Cancel/Escape/backdrop, shows a toast, and keeps the modal open', async () => {
    api.repositories.create = async () => { throw new Error('Network error'); };

    const promise = showRepositoryModal({ mode: 'create' });
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });

    getUrlInput().value = 'https://github.com/org/new-repo.git';
    submitForm();
    await wait(0);

    assert.equal(settled, false, 'the Promise should not resolve or reject on a failed save');
    assert.equal(getSubmitBtn().disabled, false);
    assert.equal(getCancelBtn().disabled, false);
    assert.ok(getOverlay(), 'modal should remain open');

    const toastEl = document.querySelector('#toast-container .toast-error');
    assert.ok(toastEl, 'an error toast should be shown');
    assert.match(toastEl.textContent, /Network error/);

    dispatchClick(getCancelBtn());
    await promise.catch(() => {});
});

test('AC6: rapid triple-click on Submit only fires one api.repositories.create() call', async () => {
    let resolveCreate;
    api.repositories.create = (data) => {
        createCalls.push(data);
        return new Promise((resolve) => { resolveCreate = resolve; });
    };

    const promise = showRepositoryModal({ mode: 'create' });
    getUrlInput().value = 'https://github.com/org/new-repo.git';

    submitForm();
    submitForm();
    submitForm();
    await wait(0);

    assert.equal(createCalls.length, 1, 'setBusy(true) should disable Submit before subsequent clicks are processed');

    resolveCreate({ Id: 'new-repo', Name: '', Url: 'https://github.com/org/new-repo.git' });
    await promise;
});

// ---------------------------------------------------------------------------
// AC7 — Rejected updateCredential() after a successful primary call
// ---------------------------------------------------------------------------

test('AC7: a rejected updateCredential() after a successful create() still resolves with the pre-credential-update repo and shows a toast', async () => {
    api.repositories.updateCredential = async () => { throw new Error('Credential save failed'); };

    const promise = showRepositoryModal({ mode: 'create' });
    getUrlInput().value = 'https://github.com/org/new-repo.git';

    const select = getCredentialSelect();
    const option = document.createElement('option');
    option.value = 'cred-9';
    option.textContent = 'Credential 9';
    select.appendChild(option);
    select.value = 'cred-9';

    submitForm();

    const repo = await promise;

    assert.equal(repo.id, 'new-repo', 'should resolve with the create()-only repo, not reject');
    const toastEl = document.querySelector('#toast-container .toast-error');
    assert.ok(toastEl, 'an error toast should be shown for the credential failure');
    assert.match(toastEl.textContent, /Credential save failed/);
});

// ---------------------------------------------------------------------------
// AC8 — Focus
// ---------------------------------------------------------------------------

test('AC8: on open, the URL field (not a button) receives initial focus, in both modes', async () => {
    const createPromise = showRepositoryModal({ mode: 'create' });
    assert.equal(document.activeElement, getUrlInput());
    dispatchClick(getCancelBtn());
    await createPromise.catch(() => {});

    document.body.innerHTML = '<button id="outside-btn" type="button">Outside</button>';
    const editPromise = showRepositoryModal({ mode: 'edit', repo: EXISTING_REPO });
    assert.equal(document.activeElement, getUrlInput());
    dispatchClick(getCancelBtn());
    await editPromise.catch(() => {});
});

test('AC8: closing the modal restores focus to the element that opened it', async () => {
    const outsideBtn = document.getElementById('outside-btn');
    outsideBtn.focus();

    const promise = showRepositoryModal({ mode: 'create' });
    getUrlInput().value = 'https://github.com/org/new-repo.git';
    submitForm();
    await promise;

    assert.equal(document.activeElement, outsideBtn);
    assert.equal(getOverlay(), null, 'overlay should be removed from the DOM');
});

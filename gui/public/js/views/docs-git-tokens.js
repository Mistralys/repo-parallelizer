/**
 * Documentation View: Setting Up Git Tokens — Repo Parallelizer GUI.
 *
 * A static documentation page that explains how to create and configure
 * Personal Access Tokens (PATs) in Paralizer, including the specific steps
 * required for private repositories hosted in GitHub organizations that
 * enforce SAML Single Sign-On (SSO).
 *
 * All content is hard-coded static markup — no API calls are made and no
 * user data is rendered, so innerHTML is safe to use for the page skeleton.
 *
 * @param {HTMLElement} container - The `#app` root element supplied by the router.
 * @param {Object}      _params   - Route params (none for this route).
 */

import { APP_NAME_SHORT } from '../utils/constants.js';

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

/**
 * Build the page header with an `<h1>` and a back-link to Settings.
 *
 * @returns {HTMLElement}
 */
function buildPageHeader() {
    const header = document.createElement('div');
    header.className = 'docs-page-header';

    const backLink = document.createElement('a');
    backLink.href = '#/settings';
    backLink.className = 'docs-back-link';
    backLink.textContent = '← Back to Settings';
    header.appendChild(backLink);

    const h1 = document.createElement('h1');
    h1.textContent = 'Setting Up Git Tokens';
    header.appendChild(h1);

    const intro = document.createElement('p');
    intro.className = 'docs-intro';
    intro.textContent =
        'Paralizer uses Personal Access Tokens (PATs) to authenticate with private ' +
        'Git repositories over HTTPS. This page explains how to create the right kind ' +
        'of token, configure it in Paralizer, and troubleshoot the common errors that ' +
        'occur with organization-owned repositories.';
    header.appendChild(intro);

    return header;
}

/**
 * Build a `<section>` with an `<h2>` heading.
 *
 * @param {string} headingText
 * @returns {HTMLElement}
 */
function buildSection(headingText) {
    const section = document.createElement('section');
    section.className = 'docs-section';

    const h2 = document.createElement('h2');
    h2.textContent = headingText;
    section.appendChild(h2);

    return section;
}

/**
 * Append a paragraph to an element.
 *
 * @param {HTMLElement} parent
 * @param {string}      text
 * @returns {HTMLParagraphElement}
 */
function appendP(parent, text) {
    const p = document.createElement('p');
    p.textContent = text;
    parent.appendChild(p);
    return p;
}

/**
 * Build an ordered list from an array of strings.
 *
 * @param {string[]} items
 * @returns {HTMLOListElement}
 */
function buildOl(items) {
    const ol = document.createElement('ol');
    for (const item of items) {
        const li = document.createElement('li');
        li.textContent = item;
        ol.appendChild(li);
    }
    return ol;
}

/**
 * Build a notice box (info or warning).
 *
 * @param {'info'|'warning'} type
 * @param {string}           text
 * @returns {HTMLElement}
 */
function buildNotice(type, text) {
    const div = document.createElement('div');
    div.className = `docs-notice docs-notice--${type}`;

    const p = document.createElement('p');
    p.textContent = text;
    div.appendChild(p);

    return div;
}

// ---------------------------------------------------------------------------
// Section: Adding a credential in Paralizer
// ---------------------------------------------------------------------------

function buildAddingSection() {
    const section = buildSection('Adding a Credential in Paralizer');

    appendP(section,
        'Credentials are managed in Settings → Git Credentials. Each entry holds a ' +
        'Label (a human-readable name for your reference), the Host the token applies ' +
        'to (e.g. github.com), and the Token itself.'
    );

    appendP(section, 'To add a new credential:');
    section.appendChild(buildOl([
        'Open Settings from the top navigation bar.',
        'In the Git Credentials section, click "Add / Update Credential".',
        'Fill in a Label, the Host (e.g. github.com), and paste your token.',
        'Click "Add Credential". The token is stored masked — only the last 4 characters remain visible.',
    ]));

    appendP(section,
        'Once a credential is saved, it is available for assignment to any repository ' +
        'whose remote URL hostname matches the credential\'s host. You can assign a ' +
        'credential to a repository from the Repositories list or the Repository Detail page.'
    );

    return section;
}

// ---------------------------------------------------------------------------
// Section: Classic vs Fine-Grained PATs
// ---------------------------------------------------------------------------

function buildTokenTypesSection() {
    const section = buildSection('Token Types: Classic vs Fine-Grained');

    appendP(section,
        'GitHub offers two kinds of Personal Access Tokens. Both work with Paralizer, ' +
        'but they behave differently — especially for organization-owned repositories.'
    );

    // Classic PAT
    const h3Classic = document.createElement('h3');
    h3Classic.textContent = 'Classic PAT';
    section.appendChild(h3Classic);

    appendP(section,
        'Classic tokens apply broadly to all repositories your account can access. They ' +
        'require the repo scope to clone and push to private repositories. For ' +
        'organization repositories that enforce SAML SSO, Classic PATs require an ' +
        'additional one-time SSO authorization step after the token is created — see the ' +
        '"Organization Repositories & SSO" section below.'
    );

    // Fine-Grained PAT
    const h3Fine = document.createElement('h3');
    h3Fine.textContent = 'Fine-Grained PAT';
    section.appendChild(h3Fine);

    appendP(section,
        'Fine-grained tokens are scoped to a single resource owner — either your personal ' +
        'account or an organization. They do not require a separate SSO authorization step; ' +
        'org access is granted during the token creation wizard. They also require you to ' +
        'explicitly select which repositories the token may access.'
    );

    section.appendChild(buildNotice('warning',
        'A fine-grained token created under your personal account cannot access ' +
        'organization repositories, even if you are a member of the organization. The ' +
        'resource owner must be set to the organization during creation.'
    ));

    return section;
}

// ---------------------------------------------------------------------------
// Section: Organization repos & SSO
// ---------------------------------------------------------------------------

function buildOrgSection() {
    const section = buildSection('Organization Repositories & SSO');

    appendP(section,
        'If you see a 403 error ("Write access to repository not granted") when Paralizer ' +
        'tries to clone or fetch a private repository owned by a GitHub organization, one ' +
        'of the following is the cause.'
    );

    // Fine-grained misconfiguration
    const h3Fine = document.createElement('h3');
    h3Fine.textContent = 'Fine-Grained PAT: Wrong resource owner or no repositories selected';
    section.appendChild(h3Fine);

    appendP(section,
        'If you open the token in GitHub Settings and see "This token does not have ' +
        'access to any repositories", the token is unusable for any clone operation. ' +
        'There are two things to check:'
    );

    section.appendChild(buildOl([
        'Resource owner must be the organization (e.g. IONOS-CPH), not your personal account. ' +
            'This cannot be changed after creation — you must create a new token.',
        'Repository access must be explicitly selected. Choose "Only select repositories" ' +
            'and pick the repositories Paralizer needs, or choose "All repositories" for ' +
            'broader access.',
    ]));

    appendP(section, 'To create a correctly configured fine-grained token:');
    section.appendChild(buildOl([
        'Go to github.com/settings/tokens (Fine-grained tokens tab) → Generate new token.',
        'Under Resource owner, select your organization (not your personal account).',
        'Under Repository access, select the repositories to grant access to.',
        'Under Repository permissions → Contents, set Read and Write access.',
        'Generate the token, copy it, and paste it into the Paralizer credential form.',
    ]));

    section.appendChild(buildNotice('info',
        'Blocker: if your organization does not appear in the Resource owner dropdown, ' +
        'or the token enters a "pending approval" state, the organization has not enabled ' +
        'fine-grained PAT access. Ask an org admin to enable it under ' +
        'Organization Settings → Personal access tokens, or use a Classic PAT instead.'
    ));

    // Classic PAT SSO
    const h3Classic = document.createElement('h3');
    h3Classic.textContent = 'Classic PAT: SSO authorization required';
    section.appendChild(h3Classic);

    appendP(section,
        'Classic PATs require an additional SSO authorization step for each organization ' +
        'that enforces SAML SSO. The token must be authorized after it is created; ' +
        'creating it and granting the repo scope is not enough.'
    );

    appendP(section, 'To authorize a Classic PAT for SSO:');
    section.appendChild(buildOl([
        'Go to github.com/settings/tokens → Tokens (classic).',
        'Next to the token, click Configure SSO.',
        'Click Authorize next to the organization name.',
        'Complete the SSO browser redirect using your company identity provider login.',
    ]));

    section.appendChild(buildNotice('warning',
        'Important: if you regenerate or rotate the Classic PAT, you must repeat the SSO ' +
        'authorization step for the new token. The authorization is tied to the token ' +
        'value, not your account.'
    ));

    return section;
}

// ---------------------------------------------------------------------------
// Section: SSH as an alternative
// ---------------------------------------------------------------------------

function buildSshSection() {
    const section = buildSection('SSH as an Alternative to HTTPS Tokens');

    appendP(section,
        'Paralizer also supports SSH remote URLs (git@github.com:org/repo.git). SSH ' +
        'authentication is handled entirely by your system\'s SSH agent — no credential ' +
        'entry is needed in Paralizer and no token expiry to manage.'
    );

    appendP(section, 'To use SSH:');
    section.appendChild(buildOl([
        'Verify you have an SSH key pair: run ls ~/.ssh/id_*.pub in a terminal. ' +
            'If none exists, generate one with: ssh-keygen -t ed25519 -C "your@email.com"',
        'Add the public key to your GitHub account: github.com/settings/keys.',
        'If the repository belongs to an SSO-enforced organization, also authorize the SSH key: ' +
            'GitHub Settings → SSH keys → Configure SSO → Authorize next to the organization.',
        'In Paralizer, add or edit the repository and set the remote URL to the SSH form: ' +
            'git@github.com:ORG/REPO.git (not the https:// form).',
        'Leave the Credential field for that repository unset — Paralizer will pass the ' +
            'SSH URL through to git without injecting a token.',
    ]));

    appendP(section,
        'SSH key authorization for an SSO organization is a one-time step and persists ' +
        'until the key is revoked. This makes SSH lower-maintenance than rotating HTTPS ' +
        'tokens for organization repositories.'
    );

    return section;
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

/**
 * Render the "Setting Up Git Tokens" documentation page.
 *
 * @param {HTMLElement} container - The `#app` root element supplied by the router.
 * @param {Object}      _params   - Route params (none for this route).
 */
export function renderDocsGitTokens(container, _params) {
    document.title = 'Git Token Setup - ' + APP_NAME_SHORT;

    container.textContent = '';

    const page = document.createElement('div');
    page.className = 'docs-page';

    page.appendChild(buildPageHeader());
    page.appendChild(buildAddingSection());
    page.appendChild(buildTokenTypesSection());
    page.appendChild(buildOrgSection());
    page.appendChild(buildSshSection());

    container.appendChild(page);
}

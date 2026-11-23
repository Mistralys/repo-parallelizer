---
name: paralizer-repo-index-description
description: Write the short index description of a repository for the metadata folder that travels with it. Use when asked to craft, refresh or shorten a repo's index entry or one-line description for an AGENTS.md index. The result is at most 500 characters.
---

# Repo Index Description

Write one description of the repository for an index that an agent reads when it opens an AGENTS.md for the first time. The description has to stand alone, because it travels with the repository.

## Hard constraints

- **At most 500 characters.** Measure the final text with `printf '%s' "<text>" | wc -c`. Do not estimate. Aim for about 450 so there is room for small edits.
- **One paragraph of plain prose.** No line breaks, bullet lists, markdown headings or tables.
- **Self-contained.** Don't rely on the workspace the repo currently sits in. Don't write "see the other repos", "the workspace", or relative paths to sibling folders. You may name other systems the repo directly works with (for example a sibling service or a consuming application), but only if the repo's own docs name them. If the text would be read outside the workspace, add a short gloss for each name.
- **No counts.** No numbers of classes, files, tests, content types or brands. They go stale.
- **Verified claims only.** Every statement must come from the repo's own `README.md`, `AGENTS.md` or `composer.json`/`package.json`/`pom.xml`. If a fact can't be confirmed, leave it out. Never fill gaps from memory or from the existing index row.

## Process

1. Read the repo's `README.md`, `AGENTS.md` and package manifest. Skim the docs folder only if the README is thin.
2. Note the following, with a source for each:
   - What the repo is (library, service, web application, tool).
   - Its purpose, from a reader's point of view.
   - Its position relative to other systems (consumer, provider, dependency).
   - What it is not, when its docs say so (for example "not a CMS").
   - The one setup requirement an agent could miss, if there is one.
   - Whether it has its own `AGENTS.md`, and how its docs are organised (manifest, generated module docs).
3. Draft, in this order:
   1. What it is and what it is for.
   2. What it provides, as the few capabilities that decide whether a task belongs here.
   3. How it relates to other systems, including a "not a ..." boundary if its docs state one.
   4. The pointer: "Read its own AGENTS.md first" followed by one clause on how its docs are organised. Only include this if the repo has an `AGENTS.md`.
4. Measure the length. If it is over 500 characters, cut in this order:
   1. Rarely decisive features.
   2. Secondary clauses.
   3. Adjectives.
   Keep the "what it is", the relationship to other systems and the `AGENTS.md` pointer to the end.
5. Re-check each remaining claim against the sources.

## Agent-perspective test

Read the draft as an agent that has never seen this repo. It should be able to answer these questions:

- Is code here shared infrastructure, a service, or an application?
- Does a given task belong in this repo or somewhere else?
- Where do I start reading?

If any answer is missing, change the draft.

## Output

- The description in a code block, with its character count.
- A short list of what was cut for length, so the user can restore items.
- Anything the sources disagree on (naming, versions, for example README against package manifest). Report these. Do not fix the sources.
- Anything not verified, if you left something out for that reason.

Don't edit the index or any other file unless the user asks.

Notes on the choices:

- Constraints: It encodes what we settled on: the 500-character limit, a description that doesn't depend on the workspace, no counts, and a pointer to the repo's own AGENTS.md.
- Process rules: The verification and cut-order rules are there because they shaped the earlier entries. The Serializers entry left out claims I couldn't confirm. The framework entry lost "tagging" and "filtering" to fit the limit.
- Manual edit: If you want it to write straight into the metadata folder, add the target path and format to the Output section. I didn't, since I don't know the folder's structure yet.

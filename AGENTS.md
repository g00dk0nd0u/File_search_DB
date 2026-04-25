# Codex instructions

## Final response rule

If you make any fix, implementation, or refactor, always include a commit message as a code block at the end using the following format.

Commit message:
<one concise Japanese line describing the change>

Example:
Commit message:
フォルダ表示と検索UIの英語表記を統一

## Dependency policy

This repository should continue using only the Python standard library.
Do not add third-party Python packages unless the user explicitly changes this policy.

## Implementation policy
- First understand the related context before editing.
- Keep changes focused, but do not avoid broader fixes when they are necessary to solve the root cause.
- Prefer minimal diffs for simple fixes.
- For structural issues, propose the broader design direction first, then implement the smallest safe version of that direction.
- Do not modify clearly unrelated files.
- When multiple files are tightly coupled, update them together to keep behavior consistent.
- Do not paste complete files unless explicitly requested.
- When editing code, briefly explain the root cause, affected files, and changed points.

## Repository export policy

- Use tools/export_repo_zip.py when creating a ZIP snapshot for ChatGPT review.
- The ZIP export should exclude .gitignore targets, .git, __pycache__, and local database files.
- Do not include generated database files, cache files, or local environment files in review ZIPs.
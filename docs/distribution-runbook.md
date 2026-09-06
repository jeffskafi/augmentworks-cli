# Distribution runbook (do not execute in this task)

These commands mutate GitHub/npm metadata. They are prepared for Jeff to run
after review. This task must not publish npm, create tags, or edit the
repository About page.

## GitHub repository About

Current `gh repo view` at implementation time: empty description, empty
homepage, no topics.

Proposed:

```bash
gh repo edit jeffskafi/augmentworks-cli \
  --description "Deterministic hosted and customer-executed local testing for AI agents" \
  --homepage "https://augmentworks.ai" \
  --add-topic agent-testing \
  --add-topic ai-evaluation \
  --add-topic chatbot-testing \
  --add-topic cli \
  --add-topic regression-testing
```

No topics exist today, so there are no proposed removals. Keep useful npm
keywords already in `package.json`; `regression-testing` was added as an
accurate extra term.

## npm

Do not run `npm publish` here. After CI is green on a `v0.3.2` tag, the
existing trusted-publishing release workflow publishes. Then verify the
downloaded tarball; do not treat `package.json` version as publication.

## Website

Adopt a pinned discovery manifest only after tarball inspection. Never `latest`.

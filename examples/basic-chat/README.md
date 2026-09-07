# Basic chat example

This is the minimum chat-only connector. It maps one user message to `/chat`
and extracts `answer` as assistant content. It can assess conversational
behavior, but it cannot establish whether a tool ran or state changed.

Copy `.env.example` to `.env`, set values locally, and run `doctor` against the
YAML before starting an assessment. Source 0.3.2 can preview the sanitized
evidence payload without calling the target:

```bash
node dist/index.js preview-mapping \
  -c augmentworks.yaml \
  --operation send \
  --fixture ./fixtures/send-preview.json
```


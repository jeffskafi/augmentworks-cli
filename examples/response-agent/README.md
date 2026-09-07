# Synthetic response-agent example

This directory is a **synthetic** FAQ assessment fixture for CLI 0.3.2.
It is not a production knowledge base, not a real customer policy, and not
included in the npm tarball. Clone this repository for the example server.

Published `@augmentworks/cli@0.3.2` includes `--assessment`. Copy or write
`augmentworks.assessment.yaml`, then run hosted test against this isolated
synthetic target only. Source `0.3.3` `init` can generate a packaged
response-quality starter instead of copying this example.

From a source 0.3.2 build, preview the chat-only send mapping before an
assessment. This does not call the target or consume credits:

```bash
node dist/index.js preview-mapping \
  -c augmentworks.yaml \
  --operation send \
  --fixture ./fixtures/send-response.json
```

```yaml
# augmentworks.assessment.yaml is synthetic test data only.
```

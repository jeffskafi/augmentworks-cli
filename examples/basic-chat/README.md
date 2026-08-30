# Basic chat example

This is the minimum chat-only connector. It maps one user message to `/chat`
and extracts `answer` as assistant content. It can assess conversational
behavior, but it cannot establish whether a tool ran or state changed.

Copy `.env.example` to `.env`, set values locally, and run `doctor` against the
YAML before starting an assessment.


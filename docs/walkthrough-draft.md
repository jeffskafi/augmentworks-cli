# Walkthrough draft (for Jeff to adapt)

Do not publish this as an external case study or claim validation.

1. Show Node.js 20+ installed. No API key, no login.
2. From a clone: `npm ci && npm run build && node dist/index.js demo`.
3. Point at stderr progress, then the failing HTML/`report.json`.
4. Show fixture amount 80 vs `maximum_refund` 50, observed `order.status`
   `refunded`, failed assertion `policy-limit-order-remains-paid`.
5. Say the assistant text “refund completed” is not the proof; the observer is.
6. Open the passing report for the same packet after the policy check.
7. State this is a deterministic loopback demo, not a production chatbot or
   accuracy benchmark, and not hosted evidence.
8. Next: `init --agent` against the viewer’s isolated synthetic target using
   pinned `@augmentworks/cli@0.3.1` until 0.3.2 is verified on npm.
9. Optional screen recording: terminal + HTML report, no credentials, ~3
   minutes. Do not fabricate a recording.

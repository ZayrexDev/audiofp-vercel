# Verification record — 2026-10-10

Optional-configuration update: 16 tests pass, including a complete HTTP/FFmpeg/WASM request with `VERCEL=1` and all four settings absent. Missing, blank, malformed and partial settings, valid authentication/allowlist enforcement, anonymous Redis quotas and rejected Redis credentials are covered. This is a local simulation of the Vercel environment flag, not a hosted deployment. The Java example still compiles with optional authentication.

Completed locally on Windows x64, Node.js v24.18.1:

- `npm install`: exact production dependencies and lockfile resolved; `npm audit --omit=dev` reported zero known npm vulnerabilities at check time. This does not scan FFmpeg or WASM binaries.
- `npm run build`: vendor SHA-256 checks passed; the package-provided FFmpeg 6.1.1 executable started successfully. Windows binary size: 82,797,568 bytes (~79 MiB).
- `npm test`: tests exercise the real FFmpeg executable and original WASM, HTTP handling, malformed/oversized requests, authentication, DNS classifications, mixed public/private DNS rejection, IP pinning, redirect validation/loop limits, streamed byte limits, the complete HTTP-to-fingerprint pipeline, instance concurrency, mocked distributed quota responses, runtime cancellation and recovery.
- Original `GenerateFP` and the reusable adapter returned exactly equal Base64 for identical decoded PCM. Four-second stereo MP3 selection produced exactly 32,000 mono samples at 8 kHz.
- Separate runtime stress check: 50 consecutive 12-second deterministic noise clips produced identical 3,312-byte fingerprints without failure. A 30-second signal exhausted the original fixed WASM heap, motivating the 12-second API limit.
- `mvn -q package` compiled the Java example with Java 17 target (host JDK 25).

Not claimed as completed:

- No live Vercel build, deployment, cold-start benchmark, Linux binary execution, final traced-function size measurement or hosted smoke test. The included Linux GitHub Actions workflow is provided for those platform checks when pushed; it has not been run here.
- No real Upstash database call. Its JSON command/error handling is tested with mocked responses; the atomic command follows the current REST documentation.
- No live NetEase recognition or song-catalog match. Compatibility means reuse of the exact upstream extractor and verified same-PCM byte equivalence, not a guarantee of recognition of every clip.
- No comparison asserting byte equivalence between FFmpeg downmix/resampling and browser channel-0 decoding.

Deployment acceptance: run the Linux CI workflow, deploy with the optional environment variables for the features you want, check the traced binary/worker/vendor inclusion and function size, then call the endpoint with a known permitted MP3 and use its returned audioFP and duration in `/audio/match`. Observe latency, peak memory, 429 behavior and failure rates in Vercel before increasing traffic. The README links the current primary documentation used for the feasibility assessment.

# oStella AudioFP on Vercel

A bounded Node.js API that downloads an MP3, selects a clip, decodes it to 8,000 Hz mono little-endian float32 PCM, and returns the Base64 fingerprint from the original NetEase `shazam_v2` WASM. No Python, browser, GraalVM, or standalone WASI runtime is needed.

## API

```http
POST /api/audiofp
Authorization: Bearer YOUR_SECRET
Content-Type: application/json

{"url":"https://your-cdn.example/music.mp3","startSeconds":0,"duration":10}
```

The Authorization header is required only when a valid `AUDIOFP_API_KEY` is configured. Only `url` is required. Unknown fields are rejected. Numeric values must be JSON numbers.

| Setting | Default | Limit |
| --- | --- | --- |
| startSeconds | 0 | 0–600 seconds |
| duration | 10 | 3–12 seconds |
| JSON request | — | 8 KiB |
| Download | — | 20 MiB total, including ID3 data |
| Redirects | — | 3, revalidated at every hop |
| Socket inactivity | — | 8 seconds |
| Whole request | — | 45 seconds from handler entry |
| Vercel maxDuration | 60 seconds | Leaves termination/response headroom |
| Per-instance processing | 1 | Concurrent requests receive 429 BUSY |
| Distributed quota (optional) | 20 | Requests per API key per 60-second window; one shared bucket without authentication |

Success (the fingerprint value below is illustrative):

```json
{
  "audioFP": "BASE64_FINGERPRINT",
  "duration": 10,
  "startSeconds": 0,
  "sampleRate": 8000,
  "channels": 1,
  "algorithm": "shazam_v2",
  "requestId": "UUID"
}
```

`duration` is the actual decoded sample count divided by 8,000, in **seconds**. Near EOF it can be shorter than requested; fewer than three seconds is rejected. Pass the returned duration together with `audioFP` to api-enhanced `/audio/match`. Do not Base64-encode the string again. If manually constructing a query string, URL-encode the Base64; JSON serialization does not need that transformation.

The MP3 is downloaded fully before decoding. Seeking uses output-side FFmpeg `-ss`, so samples before the selection are decoded and discarded. Long offsets can exhaust the time budget. Byte-range fetching cannot reliably locate arbitrary time offsets in VBR MP3 and is deliberately omitted.

## Deploy

1. Put this directory at a Git repository root, including `package-lock.json`, `vendor/`, `lib/`, `api/`, `scripts/`, and `vercel.json`. Do not commit `node_modules`, `.env`, `.vercel`, or Java `target`.
2. Import it in Vercel. Choose **Other** as the framework, **Node.js 24.x**, and enable **Fluid compute**. The configuration supplies `npm ci`, `npm run build`, `static` as output directory, a 60-second function duration, and explicit worker/vendor/FFmpeg inclusion. If used inside a monorepo, select this directory as Root Directory.
3. Optionally create an Upstash Redis database and set its REST URL/token, preferably in a region near the function. This is the shared limiter across Vercel instances; an in-memory counter would not enforce the deployment-wide quota.
4. All four environment variables are optional, on Vercel and locally. Configure only the features you want, then deploy:

| Variable | Value |
| --- | --- |
| `AUDIOFP_API_KEY` | Enables authentication when it contains at least 32 printable ASCII characters without whitespace; otherwise authentication is skipped |
| `ALLOWED_AUDIO_HOSTS` | Optional comma-separated exact DNS hostnames, e.g. `cdn.example.com,media.example.com`; invalid entries are ignored, and no valid entries means no host allowlist |
| `UPSTASH_REDIS_REST_URL` | Optional HTTPS REST origin (no credentials, path, query, fragment or nonstandard port); requires a valid token |
| `UPSTASH_REDIS_REST_TOKEN` | Optional nonempty printable ASCII token without whitespace, with EVAL/INCR/EXPIRE access; requires a valid REST URL |

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

When using the allowlist, supply your actual trusted audio CDN domains. No wildcard, suffix match, scheme, port, or path belongs in this setting. A presigned HTTPS URL is supported, and its query remains intact. Only admit hosts whose audio you intend the service to fetch. The service does not forward client credentials, cookies, arbitrary headers, or its API token to the source.

The build explicitly runs the pinned `ffmpeg-static` installer, checks vendor hashes, executes `ffmpeg -version`, and checks binary size. This covers npm versions that block dependency install scripts. Vercel must have build-time access to GitHub release downloads. Installation chooses the build platform's binary; **never upload Windows `node_modules` as a prebuilt Linux deployment**. Do not set `FFMPEG_BIN` in Vercel unless you also package and validate that custom executable.

5. Check build logs for the Linux FFmpeg version and byte count, and inspect the resulting function bundle. Verify it contains `lib/wasm-worker.js`, both vendor JS files, and the Linux `node_modules/ffmpeg-static/ffmpeg` executable. The application is designed for the standard sub-250 MB path; no large-function beta is needed for the expected binary size. The build's 200 MiB check is a binary budget, not a measurement of Vercel's final traced bundle.
6. Smoke-test a real allowed MP3 using the request below. Check the returned Base64 and duration with your existing `/audio/match` backend and a known catalog recording. When authentication is enabled, verify 401 without the bearer token; when the allowlist is enabled, verify 400 for an unallowed source. Omit the Authorization header in the example below if authentication is disabled.

```sh
curl --fail-with-body https://YOUR_PROJECT.vercel.app/api/audiofp \
  -H "Authorization: Bearer $AUDIOFP_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"url":"https://YOUR_ALLOWED_CDN/song.mp3","startSeconds":15,"duration":10}'
```

Preview deployments may have Vercel Deployment Protection enabled. Authenticate through that layer or use a configured production endpoint; its HTML/401 response happens before this API. Use Vercel Firewall controls and spend alerts to bound unauthorized invocation traffic; rejected requests can still incur platform cost.

## Local development

Install Node.js 24 and run:

```sh
npm ci
npm run build
npm test
```

Run `npm start` with no environment variables, or copy `.env.example` to `.env` to enable optional features. Local address: `http://127.0.0.1:3000/api/audiofp`. Missing or invalid configuration skips only the related feature, identically locally and on Vercel. SSRF checks, processing limits and the instance gate always apply.

## oStella Java integration

`java/src/main/java/example/AudioFpClient.java` is a Java 17+ HTTP client example, with a standalone Maven project. It reuses `HttpClient`, has 10-second connect and 55-second request timeouts, refuses endpoint redirects to avoid forwarding the bearer token, validates the response, and exposes status/code/requestId/Retry-After on `ApiException`.

```sh
mvn -f java/pom.xml package
```

Copy the class into oStella's own package and use your project's managed Jackson version, or use the pinned standalone example dependency. It does not modify or assume an existing oStella checkout.

```java
var client = new AudioFpClient(
    URI.create(System.getenv("AUDIOFP_ENDPOINT")),
    System.getenv("AUDIOFP_API_KEY"));
var fp = client.generate(URI.create(sourceMp3Url), 0, 10);
// Existing api-enhanced audio/match request body:
var matchBody = Map.of("audioFP", fp.audioFP(), "duration", fp.duration());
```

Set `AUDIOFP_ENDPOINT=https://YOUR_PROJECT.vercel.app/api/audiofp`. The Java client accepts a null or invalid API key and omits the Authorization header in that case. Reuse the client and run the blocking call on a background executor. Preserve interruption when catching `InterruptedException`. The client makes one attempt: queue and retry 429 using Retry-After with a bounded job policy; avoid retrying invalid input and authentication failures. Do not log source signed URLs or the API key. Java response bodies may be platform-generated HTML on failures; these map to `PLATFORM_ERROR`.

## Compatibility and runtime design

The two unchanged vendor files come from [ZayrexDev/api-enhanced](https://github.com/ZayrexDev/api-enhanced/tree/2db6684453297ee86dec0492842f2320b08182d9/public/audio_match_demo), commit `2db6684453297ee86dec0492842f2320b08182d9`. `vendor/manifest.json` records their packaged SHA-256 hashes. `afp.wasm.js` contains the Base64 WASM payload, not a separate `.wasm` file. The wrapper supplies its Emscripten/Embind imports, so trying to instantiate the binary alone as WASI is not equivalent.

The adapter evaluates the trusted wrapper in a VM context inside a worker, exposing its existing `AudioFingerprintRuntime` factory without editing vendor code. It shares the `ArrayBuffer` constructor across contexts, which the wrapper's type checks require. It waits for `ExtractQueryFP`, passes the raw float32 ArrayBuffer, copies vector bytes, frees the Embind vector with `delete()`, and Base64-encodes the bytes. A warm instance reuses this runtime serially. No promise of reuse spans cold starts, scale-out, or deployment. A failure/timeout discards the worker; the next call starts a fresh runtime.

The 12-second maximum is intentional: the supplied fixed-heap WASM ran out of memory on a tested 30-second signal. Fifty repeated 12-second noise-signal calls were stable in local verification. Input-dependent WASM failures still return a structured error and recycle the worker; do not raise the cap without testing representative recordings and memory behavior.

The upstream [browser demo](https://github.com/ZayrexDev/api-enhanced/blob/2db6684453297ee86dec0492842f2320b08182d9/public/audio_match_demo/index.html) uses an 8 kHz AudioContext and takes channel 0. This API explicitly downmixes to mono as requested. FFmpeg and browser resampling/MP3 decoding can differ slightly, and a stereo downmix can differ materially from the demo's left channel. Therefore the **same PCM** produces identical fingerprint bytes in our equivalence test; arbitrary browser-decoded MP3s are not promised bit-identical. NetEase recognition also depends on audible content, catalog coverage and the external service.

## Security and operational behavior

- HTTPS only, port 443, no URL credentials, fragments or IP literals. URL canonicalization happens before allowlist checks.
- Every redirect is checked again. DNS must return only globally routable addresses. IPv4 private/link-local/loopback/CGNAT/multicast/reserved addresses and IPv6 local/mapped/transition/reserved ranges are rejected. IPv6 is further restricted to global unicast space. The validated address is pinned via the connection's lookup callback while preserving TLS hostname verification and SNI; DNS is not resolved a second time by the socket.
- No automatic HTTP decompression. Both declared and streamed byte counts are bounded. Source MIME headers are not trusted as proof of MP3; FFmpeg must successfully decode it.
- FFmpeg is spawned without a shell and with pipe-only protocols and a forced MP3 demuxer. It cannot retrieve a playlist's URL or local file. No audio is written to disk. Decoding runs in a child process; WASM runs in a worker so its synchronous work cannot block the parent deadline timer.
- The whole-request deadline includes JSON read, Redis, DNS, download, decode and fingerprint. Abort kills FFmpeg and terminates the worker; client disconnect also cancels work when visible to the handler. The timeout does not govern upload time spent in Vercel before invocation.
- The per-instance gate protects shared WASM and CPU, but is not a global concurrency guarantee. Upstash's atomic INCR/EXPIRE script enforces the 20-per-60-second fixed-window quota across instances when Redis is configured. With authentication disabled, all callers share the anonymous bucket, independent of supplied Authorization headers. At window boundaries bursts remain possible. Use a job queue if you need strict global concurrency or steady throughput.
- API responses use `Cache-Control: no-store`; no browser CORS access is enabled. Logs contain only request ID, error code and status. Missing or malformed Redis settings skip the optional quota. Redis HTTP 401/403 credential rejections also skip it. Network failures, timeouts, unexpected responses and other server errors still return 503 when Redis is configured.
- `npm audit` covers JavaScript dependencies, not vulnerabilities in the downloaded FFmpeg binary or opaque WASM. Review/pin upgraded binaries separately and rerun compatibility tests. `ffmpeg-static` 5.3.0 currently pins a 6.1.1 binary release; package version and FFmpeg version are distinct.

Errors use `{"error":{"code":"...","message":"..."},"requestId":"..."}`. No raw stack traces, decoder output or upstream bodies are returned.

| HTTP | Typical codes |
| --- | --- |
| 400 | INVALID_JSON, INVALID_INPUT, UNSAFE_URL |
| 401 / 405 / 415 | UNAUTHORIZED / METHOD_NOT_ALLOWED / CONTENT_TYPE |
| 413 | BODY_TOO_LARGE, SOURCE_TOO_LARGE |
| 422 | INVALID_AUDIO, FP_FAILED, DECODE_FAILED |
| 429 | BUSY (Retry-After 2), RATE_LIMITED (Retry-After 60) |
| 500 | DECODER_UNAVAILABLE, FP_RUNTIME_FAILED |
| 502 | SOURCE_HTTP, TOO_MANY_REDIRECTS, PROCESSING_FAILED |
| 503 | RATE_LIMIT_UNAVAILABLE |
| 504 | TIMEOUT, SOURCE_TIMEOUT |

Vercel can produce its own errors before/after the handler, including payload and platform timeouts. Clients must tolerate non-JSON failures.

## Current-doc feasibility check (2026-10-10)

- Vercel lists [Node.js 24.x](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions) and [full Node APIs](https://vercel.com/docs/functions/runtimes/node-js). This project requires that runtime for worker threads, child processes, HTTPS lookup control and native FFmpeg; it does not use Edge.
- The [function limits](https://vercel.com/docs/functions/limitations) document a 4.5 MB request/response payload cap. Only small JSON enters/leaves the function; the source audio is an outbound download with its own cap. The configured 60-second duration stays within the documented Hobby Fluid limit. The default 2 GB instance is ample for the bounded PCM buffers, but actual CPU timing and memory must be observed on deployment.
- Vercel's newer [large-function guidance](https://vercel.com/kb/guide/troubleshooting-function-250mb-limit) distinguishes the standard 250 MB path and an eligible 5 GB Fluid beta. This implementation targets the standard path, so it does not rely on that beta or on newer extended-duration features. Explicit [includeFiles configuration](https://vercel.com/docs/project-configuration) retains files that dynamic worker/VM loading may evade in tracing.
- [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) provides platform-specific executables downloaded during installation. [FFmpeg's documented options](https://ffmpeg.org/ffmpeg.html) support selected duration, output-side seek, channel count, sample rate and raw PCM output. The dependency lockfile is included.
- [Node HTTPS](https://nodejs.org/docs/latest-v24.x/api/https.html) supports connection options needed for DNS pinning while TLS still validates the original hostname. [Upstash REST](https://upstash.com/docs/redis/features/restapi) supports authenticated JSON Redis commands, including Lua-based atomic counters.

This is a deployable project with local verification, **not a claim of a completed Vercel deployment or live NetEase recognition test**. No Vercel project or Redis credentials were supplied. See `VERIFICATION.md` for actual checks and remaining deployment checks.

## Attribution

The upstream repository MIT license is preserved at `vendor/LICENSE`. The wrapper attributes the fingerprint runtime to a NetEase browser extension; no separate license for that embedded proprietary algorithm is asserted here. `ffmpeg-static` declares GPL-3.0-or-later and its downloaded binary has its own build/license details. Preserve applicable notices and source obligations when redistributing binaries. Dependencies are installed by the recipient and not embedded in the source ZIP.

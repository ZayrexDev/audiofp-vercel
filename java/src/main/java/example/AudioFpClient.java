package example;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Base64;
import java.util.Map;

/** Reuse one client in oStella; call from a background executor, not a gateway event thread. */
public final class AudioFpClient {
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .followRedirects(HttpClient.Redirect.NEVER).build();
    private final ObjectMapper json = new ObjectMapper();
    private final URI endpoint;
    private final String apiKey;

    public AudioFpClient(URI endpoint, String apiKey) {
        if (!"https".equalsIgnoreCase(endpoint.getScheme()) || endpoint.getHost() == null
                || endpoint.getUserInfo() != null || endpoint.getFragment() != null)
            throw new IllegalArgumentException("Use an HTTPS API endpoint");
        if (apiKey == null || apiKey.length() < 32) throw new IllegalArgumentException("Missing API key");
        this.endpoint = endpoint;
        this.apiKey = apiKey;
    }

    public record Fingerprint(String audioFP, double duration, double startSeconds, String requestId) {}

    public static final class ApiException extends IOException {
        public final int status;
        public final String code, requestId, retryAfter;
        ApiException(int status, String code, String requestId, String retryAfter) {
            super("AudioFP HTTP " + status + " (" + code + "), requestId=" + requestId);
            this.status = status; this.code = code; this.requestId = requestId; this.retryAfter = retryAfter;
        }
    }

    public Fingerprint generate(URI mp3Url, double startSeconds, double duration)
            throws IOException, InterruptedException {
        if (!Double.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 600
                || !Double.isFinite(duration) || duration < 3 || duration > 12)
            throw new IllegalArgumentException("startSeconds: 0–600; duration: 3–12");
        var body = json.writeValueAsString(Map.of("url", mp3Url.toASCIIString(),
                "startSeconds", startSeconds, "duration", duration));
        var request = HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(55))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build();
        // No automatic retry: honor Retry-After for 429; use bounded retries at the job layer.
        var response = http.send(request, HttpResponse.BodyHandlers.ofString());
        JsonNode root;
        try { root = json.readTree(response.body()); }
        catch (IOException invalidJson) { root = json.createObjectNode(); }
        if (root == null) root = json.createObjectNode();
        String requestId = root.path("requestId").asText(response.headers().firstValue("x-request-id").orElse("unknown"));
        if (response.statusCode() != 200)
            throw new ApiException(response.statusCode(), root.path("error").path("code").asText("PLATFORM_ERROR"),
                    requestId, response.headers().firstValue("retry-after").orElse(""));
        String fp = root.path("audioFP").asText("");
        double actualDuration = root.path("duration").asDouble(0);
        if (fp.isEmpty() || actualDuration < 3 || actualDuration > 12.1
                || root.path("sampleRate").asInt() != 8000 || root.path("channels").asInt() != 1)
            throw new IOException("Invalid AudioFP response");
        try { Base64.getDecoder().decode(fp); }
        catch (IllegalArgumentException invalidBase64) { throw new IOException("Invalid audioFP encoding", invalidBase64); }
        return new Fingerprint(fp, actualDuration, root.path("startSeconds").asDouble(), requestId);
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 1) throw new IllegalArgumentException("Pass one source MP3 URL");
        var client = new AudioFpClient(URI.create(System.getenv("AUDIOFP_ENDPOINT")), System.getenv("AUDIOFP_API_KEY"));
        var result = client.generate(URI.create(args[0]), 0, 10);
        // Supply both fields to api-enhanced /audio/match (seconds, not milliseconds).
        System.out.println(new ObjectMapper().writeValueAsString(Map.of(
                "audioFP", result.audioFP(), "duration", result.duration())));
    }
}

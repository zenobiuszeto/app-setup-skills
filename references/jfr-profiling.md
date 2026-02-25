# JFR Profiling (JDK Flight Recorder)

JFR is a low-overhead profiling and diagnostics framework built into the JVM. It captures CPU hotspots, memory allocation patterns, GC activity, thread contention, and I/O — all with production-safe overhead (~1-2%).

## Starting JFR

### Via JVM Flags (Docker / startup)

```bash
# Continuous recording that dumps on demand
java -XX:StartFlightRecording=settings=profile,maxsize=256m,dumponexit=true,filename=/tmp/recording.jfr \
     -jar app.jar

# Time-limited recording
java -XX:StartFlightRecording=settings=profile,duration=60s,filename=/tmp/profile-60s.jfr \
     -jar app.jar
```

### Via jcmd (attach to running process)

```bash
# Start recording
jcmd <pid> JFR.start name=profile settings=profile maxsize=256m

# Dump current data
jcmd <pid> JFR.dump name=profile filename=/tmp/recording.jfr

# Stop
jcmd <pid> JFR.stop name=profile
```

### Programmatic (embed in your app)

```java
import jdk.jfr.*;

@Service
@Slf4j
public class JfrService {

    public Path captureProfile(Duration duration) throws Exception {
        Path outputPath = Path.of("/tmp", "profile-" + Instant.now().toEpochMilli() + ".jfr");

        try (var recording = new Recording(Configuration.getConfiguration("profile"))) {
            recording.setMaxSize(256 * 1024 * 1024);  // 256 MB
            recording.start();

            Thread.sleep(duration.toMillis());

            recording.stop();
            recording.dump(outputPath);
        }

        log.info("JFR profile captured: {}", outputPath);
        return outputPath;
    }
}
```

## Custom JFR Events

Create application-specific events to correlate business operations with JVM metrics:

```java
@Name("com.myorg.OrderProcessed")
@Label("Order Processed")
@Category({"Application", "Orders"})
@StackTrace(false)
public class OrderProcessedEvent extends jdk.jfr.Event {

    @Label("Order ID")
    public String orderId;

    @Label("Customer ID")
    public String customerId;

    @Label("Item Count")
    public int itemCount;

    @Label("Total Amount")
    public double totalAmount;

    @Label("Processing Time (ms)")
    @Timespan(Timespan.MILLISECONDS)
    public long processingTimeMs;
}
```

Emit the event:

```java
public OrderResponse processOrder(CreateOrderRequest request) {
    var event = new OrderProcessedEvent();
    event.begin();

    // ... business logic ...

    event.orderId = order.getId().toString();
    event.customerId = request.customerId().toString();
    event.itemCount = request.items().size();
    event.totalAmount = order.getTotal().doubleValue();
    event.processingTimeMs = Duration.between(start, Instant.now()).toMillis();
    event.commit();

    return response;
}
```

## Spring Boot Actuator Integration

Expose a JFR endpoint (Spring Boot 3.x):

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus,metrics,flyway
```

For on-demand profiling via an admin endpoint:

```java
@RestController
@RequestMapping("/admin/profiling")
@RequiredArgsConstructor
public class ProfilingController {

    private final JfrService jfrService;

    @PostMapping("/capture")
    public ResponseEntity<Resource> capture(
            @RequestParam(defaultValue = "30") int durationSeconds) throws Exception {
        Path jfrFile = jfrService.captureProfile(Duration.ofSeconds(durationSeconds));
        var resource = new FileSystemResource(jfrFile);
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        "attachment; filename=" + jfrFile.getFileName())
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .body(resource);
    }
}
```

Protect this endpoint — it should only be accessible to ops/admin roles.

## Docker Configuration

When running in Docker, pass JFR flags via `JAVA_OPTS`:

```dockerfile
ENV JAVA_OPTS="-XX:+UseZGC \
    -XX:StartFlightRecording=settings=default,maxsize=128m,dumponexit=true,filename=/tmp/jfr/recording.jfr"
```

Mount a volume so recordings survive container restarts:

```yaml
# docker-compose.yml
services:
  app:
    volumes:
      - jfr-data:/tmp/jfr
volumes:
  jfr-data:
```

## Analysis Workflow

1. **Capture**: Run JFR during load test or in production.
2. **Retrieve**: Copy `.jfr` file from the server/container.
3. **Analyze**: Open in JDK Mission Control (JMC) or use `jfr` CLI:

```bash
# Summary
jfr summary recording.jfr

# Print specific events
jfr print --events jdk.CPULoad recording.jfr
jfr print --events jdk.GarbageCollection recording.jfr
jfr print --events com.myorg.OrderProcessed recording.jfr

# Export to JSON for programmatic analysis
jfr print --json recording.jfr > recording.json
```

## What to Look For

| Symptom | JFR Events to Check |
|---|---|
| High CPU | `jdk.ExecutionSample` (hot methods), `jdk.CPULoad` |
| Memory pressure | `jdk.ObjectAllocationInNewTLAB`, `jdk.OldObjectSample` |
| GC pauses | `jdk.GarbageCollection`, `jdk.GCPhasePause` |
| Thread contention | `jdk.JavaMonitorWait`, `jdk.JavaMonitorEnter`, `jdk.ThreadPark` |
| Slow I/O | `jdk.SocketRead`, `jdk.SocketWrite`, `jdk.FileRead`, `jdk.FileWrite` |
| Class loading | `jdk.ClassLoad` (startup slowness) |

## JFR + Virtual Threads

Virtual threads introduce new events in Java 21:
- `jdk.VirtualThreadStart` / `jdk.VirtualThreadEnd`
- `jdk.VirtualThreadPinned` — critical: indicates a virtual thread is pinned to a carrier thread (usually due to `synchronized` block with I/O inside). Find these and refactor to `ReentrantLock`.

Enable these events in your JFR settings:

```xml
<!-- custom.jfc -->
<event name="jdk.VirtualThreadPinned">
    <setting name="enabled">true</setting>
    <setting name="threshold">20 ms</setting>
</event>
```

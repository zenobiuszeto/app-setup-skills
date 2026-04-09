# Security — Spring Security, OAuth2/OIDC, OWASP, and Penetration Testing

Enterprise security is non-negotiable. Every service must enforce authentication, authorisation, input validation, and transport security. This reference covers the full security stack from code to pen-test.

## Spring Security Configuration

### Dependency Setup

```groovy
// build.gradle
implementation 'org.springframework.boot:spring-boot-starter-security'
implementation 'org.springframework.boot:spring-boot-starter-oauth2-resource-server'
implementation 'org.springframework.security:spring-security-oauth2-jose'  // JWT support

// For CSRF / session-based apps that also expose APIs:
// implementation 'org.springframework.boot:spring-boot-starter-oauth2-client'
```

### JWT Resource Server (Stateless Microservice)

The standard enterprise pattern for microservices: every service is a stateless OAuth2 resource server that validates JWTs issued by a central identity provider (Keycloak, Okta, Azure AD, etc.).

```java
@Configuration
@EnableWebSecurity
@EnableMethodSecurity   // enables @PreAuthorize / @PostAuthorize
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .csrf(AbstractHttpConfigurer::disable)          // stateless — no CSRF needed
            .sessionManagement(sm -> sm
                .sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/actuator/health", "/actuator/info").permitAll()
                .requestMatchers("/actuator/**").hasRole("ADMIN")
                .requestMatchers(HttpMethod.GET, "/api/v1/**").hasAnyRole("USER", "ADMIN")
                .requestMatchers(HttpMethod.POST, "/api/v1/**").hasAnyRole("EDITOR", "ADMIN")
                .requestMatchers(HttpMethod.DELETE, "/api/v1/**").hasRole("ADMIN")
                .anyRequest().authenticated())
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthConverter())));

        return http.build();
    }

    @Bean
    public JwtAuthenticationConverter jwtAuthConverter() {
        var grantedAuthoritiesConverter = new JwtGrantedAuthoritiesConverter();
        grantedAuthoritiesConverter.setAuthoritiesClaimName("roles");
        grantedAuthoritiesConverter.setAuthorityPrefix("ROLE_");

        var converter = new JwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(grantedAuthoritiesConverter);
        return converter;
    }
}
```

```yaml
# application.yml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: ${OAUTH2_ISSUER_URI:https://auth.example.com/realms/my-realm}
          # issuer-uri triggers OIDC discovery — fetches JWKS automatically
          # For explicit JWKS endpoint:
          # jwk-set-uri: ${OAUTH2_JWKS_URI:https://auth.example.com/realms/my-realm/protocol/openid-connect/certs}
```

### Method-Level Security

Apply fine-grained authorisation at the service layer:

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class OrderService {

    @PreAuthorize("hasRole('ADMIN') or @orderSecurityService.isOwner(#id, authentication)")
    public OrderResponse findById(UUID id) { ... }

    @PreAuthorize("hasRole('EDITOR')")
    public OrderResponse create(CreateOrderRequest request) { ... }

    @PreAuthorize("hasRole('ADMIN')")
    @PostAuthorize("returnObject.customerId == authentication.name or hasRole('ADMIN')")
    public OrderResponse update(UUID id, UpdateOrderRequest request) { ... }

    @PreAuthorize("hasRole('ADMIN')")
    public void delete(UUID id) { ... }
}
```

```java
@Component
public class OrderSecurityService {

    private final OrderRepository orderRepository;

    public boolean isOwner(UUID orderId, Authentication auth) {
        return orderRepository.findById(orderId)
                .map(o -> o.getCustomerId().toString().equals(auth.getName()))
                .orElse(false);
    }
}
```

### Security Context Propagation

Propagate the security principal across async boundaries:

```java
@Configuration
@EnableAsync
public class AsyncSecurityConfig {

    @Bean
    public Executor taskExecutor() {
        // DelegatingSecurityContextExecutor propagates SecurityContext to async tasks
        return new DelegatingSecurityContextExecutorService(
                Executors.newVirtualThreadPerTaskExecutor());
    }
}
```

---

## Input Validation and Injection Prevention

### Bean Validation (First Line of Defence)

```java
public record CreateOrderRequest(
    @NotNull(message = "customerId is required")
    UUID customerId,

    @NotEmpty(message = "items cannot be empty")
    @Size(max = 100, message = "order cannot exceed 100 items")
    List<@Valid OrderItemRequest> items,

    @Size(max = 500, message = "notes cannot exceed 500 characters")
    @Pattern(regexp = "[\\w\\s.,!?-]*", message = "notes contains invalid characters")
    String notes
) {}
```

### SQL Injection Prevention

Always use Spring Data or parameterised JPQL/native queries. **Never concatenate user input into queries.**

```java
// SAFE — parameterised
@Query("SELECT o FROM Order o WHERE o.customerId = :customerId AND o.status = :status")
List<Order> findByCustomerAndStatus(@Param("customerId") UUID customerId,
                                    @Param("status") OrderStatus status);

// NEVER DO THIS:
// @Query("SELECT o FROM Order o WHERE o.status = '" + status + "'")
```

### CORS Configuration

Restrict cross-origin access explicitly. Avoid `allowedOrigins("*")` in production.

```java
@Configuration
public class CorsConfig {

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        var config = new CorsConfiguration();
        config.setAllowedOrigins(List.of(
            "https://app.example.com",
            "https://admin.example.com"
        ));
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
        config.setAllowedHeaders(List.of("Authorization", "Content-Type", "X-Request-ID"));
        config.setExposedHeaders(List.of("X-Request-ID", "X-Total-Count"));
        config.setMaxAge(3600L);
        config.setAllowCredentials(true);

        var source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", config);
        return source;
    }
}
```

---

## Transport Security

### TLS Configuration

```yaml
# application-prod.yml
server:
  ssl:
    enabled: true
    key-store: ${SSL_KEYSTORE_PATH}
    key-store-password: ${SSL_KEYSTORE_PASSWORD}
    key-store-type: PKCS12
    protocol: TLS
    enabled-protocols: TLSv1.3
```

### Security Headers (via Spring Security)

```java
http.headers(headers -> headers
    .contentSecurityPolicy(csp -> csp
        .policyDirectives("default-src 'self'; frame-ancestors 'none'"))
    .referrerPolicy(rp -> rp
        .policy(ReferrerPolicyHeaderWriter.ReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN))
    .permissionsPolicy(pp -> pp
        .policy("camera=(), microphone=(), geolocation=()"))
    .frameOptions(fo -> fo.deny())
    .xssProtection(xss -> xss.disable())    // CSP replaces X-XSS-Protection
    .httpStrictTransportSecurity(hsts -> hsts
        .includeSubDomains(true)
        .maxAgeInSeconds(31536000))
);
```

---

## Rate Limiting

Protect APIs from abuse with Redis-backed rate limiting:

```java
@Component
@RequiredArgsConstructor
public class RateLimitFilter extends OncePerRequestFilter {

    private final RateLimiter rateLimiter;

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String clientId = extractClientId(request);  // e.g., sub claim from JWT
        if (!rateLimiter.isAllowed(clientId, 100, Duration.ofMinutes(1))) {
            response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
            response.setHeader("Retry-After", "60");
            response.getWriter().write("{\"error\": \"Rate limit exceeded\"}");
            return;
        }
        filterChain.doFilter(request, response);
    }

    private String extractClientId(HttpServletRequest request) {
        // extract from JWT sub or API key header
        String auth = request.getHeader(HttpHeaders.AUTHORIZATION);
        // parse JWT and return subject claim
        return auth != null ? auth : request.getRemoteAddr();
    }
}
```

---

## Secrets Management

Never hardcode secrets. For enterprise deployments:

```yaml
# Use environment variables (standard, works everywhere)
spring:
  datasource:
    password: ${DB_PASSWORD}

# With HashiCorp Vault (enterprise recommended)
spring:
  cloud:
    vault:
      uri: ${VAULT_ADDR:https://vault.example.com}
      token: ${VAULT_TOKEN}
      kv:
        enabled: true
        backend: secret
        default-context: ${spring.application.name}
```

```groovy
// build.gradle — Vault integration
implementation 'org.springframework.cloud:spring-cloud-starter-vault-config'
```

---

## Security Audit Logging

Log security events for forensic analysis and compliance:

```java
@Component
@RequiredArgsConstructor
@Slf4j
public class SecurityAuditListener
        implements ApplicationListener<AbstractAuthenticationEvent> {

    @Override
    public void onApplicationEvent(AbstractAuthenticationEvent event) {
        if (event instanceof AuthenticationSuccessEvent success) {
            log.info("LOGIN_SUCCESS user={} ip={}",
                    success.getAuthentication().getName(),
                    getClientIp());
        } else if (event instanceof AbstractAuthenticationFailureEvent failure) {
            log.warn("LOGIN_FAILURE user={} reason={} ip={}",
                    failure.getAuthentication().getName(),
                    failure.getException().getMessage(),
                    getClientIp());
        }
    }
}
```

---

## OWASP Top 10 Mitigations Checklist

| OWASP Risk | Mitigation in Spring Boot |
|---|---|
| A01 Broken Access Control | `@PreAuthorize`, resource ownership checks, deny-by-default |
| A02 Cryptographic Failures | TLS 1.3 only, secrets in Vault/env, no plaintext secrets in code |
| A03 Injection | Parameterised queries, `@Valid` Bean Validation, no string concatenation |
| A04 Insecure Design | Threat modelling, defence-in-depth, principle of least privilege |
| A05 Security Misconfiguration | Security headers, CORS restriction, actuator locked down |
| A06 Vulnerable Components | `./gradlew dependencyCheckAnalyze` (OWASP Dependency Check) |
| A07 Auth Failures | OAuth2/OIDC, short-lived JWT, refresh token rotation |
| A08 Software Integrity | Sign Docker images, verify checksums, use Trivy in CI |
| A09 Logging Failures | Security audit log, centralised log aggregation, no PII in logs |
| A10 SSRF | Whitelist outbound URLs, use firewall egress rules |

---

## Penetration Testing — OWASP ZAP Integration

### Automated DAST in CI/CD

OWASP ZAP (Zed Attack Proxy) performs Dynamic Application Security Testing against a running instance of your app.

#### Docker-Based ZAP Scan

```bash
# Baseline scan — finds common issues quickly (<5 min)
docker run --rm \
  -v "$(pwd)/zap-reports:/zap/wrk" \
  ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
    -t https://dev.{service}.example.com \
    -r zap-report.html \
    -x zap-report.xml \
    -J zap-report.json \
    -I   # do not fail on warnings, only errors

# Full scan — more comprehensive, includes active attacks (~20-30 min)
docker run --rm \
  -v "$(pwd)/zap-reports:/zap/wrk" \
  ghcr.io/zaproxy/zaproxy:stable \
  zap-full-scan.py \
    -t https://uat.{service}.example.com \
    -r zap-full-report.html \
    -x zap-full-report.xml \
    -z "-config scanner.attackStrength=MEDIUM"
```

#### ZAP API Scan (OpenAPI/Swagger)

If your service exposes an OpenAPI spec:

```bash
docker run --rm \
  -v "$(pwd)/zap-reports:/zap/wrk" \
  ghcr.io/zaproxy/zaproxy:stable \
  zap-api-scan.py \
    -t https://dev.{service}.example.com/v3/api-docs \
    -f openapi \
    -r zap-api-report.html \
    -x zap-api-report.xml
```

#### ZAP Rules Configuration

Create `zap-rules.conf` to fine-tune what passes/fails CI:

```
# zap-rules.conf
# Format: rule_id  IGNORE/WARN/FAIL  [optional comment]

# WARN on suspicious items we track but don't block on
10021   WARN    (X-Content-Type-Options missing — handled by CDN)
10038   WARN    (Content Security Policy — relaxed in dev)

# FAIL CI on these — must be fixed before merging
10202   FAIL    (Absence of Anti-CSRF Tokens — critical)
40012   FAIL    (Cross-Site Scripting — critical)
40014   FAIL    (SQL Injection — critical)
90001   FAIL    (Insecure component — update dependencies)
```

```bash
docker run --rm \
  -v "$(pwd):/zap/wrk" \
  ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
    -t https://dev.{service}.example.com \
    -c zap-rules.conf \
    -r zap-report.html
```

### GitHub Actions — DAST Stage

```yaml
# .github/workflows/security-scan.yml
name: Security Scan

on:
  schedule:
    - cron: '0 2 * * *'   # nightly DAST against DEV
  workflow_dispatch:        # manual trigger for release candidates

jobs:
  dast-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: ZAP Baseline Scan
        uses: zaproxy/action-baseline@v0.12.0
        with:
          target: ${{ vars.DEV_BASE_URL }}
          rules_file_name: zap-rules.conf
          cmd_options: '-I'

      - name: Upload ZAP Report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: zap-report
          path: report_html.html
          retention-days: 30
```

### SAST — Static Application Security Testing

```yaml
# In CI workflow — runs on every PR
  sast-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: OWASP Dependency Check
        run: |
          ./gradlew dependencyCheckAnalyze
        env:
          NVD_API_KEY: ${{ secrets.NVD_API_KEY }}

      - name: Upload Dependency Check Report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: dependency-check-report
          path: build/reports/dependency-check-report.html

      - name: Trivy Container Scan
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ vars.DOCKER_REGISTRY }}/${{ github.repository }}:${{ github.sha }}
          format: sarif
          output: trivy-results.sarif
          severity: HIGH,CRITICAL
          exit-code: 1  # fail CI on HIGH/CRITICAL vulns

      - name: Upload Trivy SARIF
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: trivy-results.sarif
```

### build.gradle — Security Analysis Tools

```groovy
plugins {
    id 'org.owasp.dependencycheck' version '10.0.3'
}

dependencyCheck {
    failBuildOnCVSS = 7.0          // fail on HIGH (CVSS >= 7) vulns
    suppressionFile = 'dependency-check-suppressions.xml'
    nvd {
        apiKey = System.getenv('NVD_API_KEY') ?: ''
    }
    formats = ['HTML', 'JSON', 'SARIF']
}
```

---

## Security Testing with Spring Security Test

Unit-test secured endpoints without a real identity provider:

```java
@WebMvcTest(OrderController.class)
class OrderControllerSecurityTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    @WithMockUser(roles = "USER")
    void shouldAllowUserToGetOrder() throws Exception {
        mockMvc.perform(get("/api/v1/orders/{id}", UUID.randomUUID()))
               .andExpect(status().isOk());
    }

    @Test
    @WithMockUser(roles = "USER")
    void shouldForbidUserFromDeletingOrder() throws Exception {
        mockMvc.perform(delete("/api/v1/orders/{id}", UUID.randomUUID()))
               .andExpect(status().isForbidden());
    }

    @Test
    void shouldRejectUnauthenticatedRequest() throws Exception {
        mockMvc.perform(get("/api/v1/orders"))
               .andExpect(status().isUnauthorized());
    }

    @Test
    @WithMockUser(roles = "ADMIN")
    void shouldAllowAdminToDeleteOrder() throws Exception {
        // given
        doNothing().when(orderService).delete(any());
        // when / then
        mockMvc.perform(delete("/api/v1/orders/{id}", UUID.randomUUID()))
               .andExpect(status().isNoContent());
    }
}
```

For JWT-based tests in `@SpringBootTest`:

```java
// Helper — generate a test JWT
private String generateTestJwt(String subject, List<String> roles) {
    return Jwts.builder()
            .subject(subject)
            .claim("roles", roles)
            .issuer("https://test-auth.example.com")
            .expiration(Date.from(Instant.now().plus(1, ChronoUnit.HOURS)))
            .signWith(testPrivateKey)
            .compact();
}

@Test
void shouldReturnOrderForAuthenticatedUser() throws Exception {
    String jwt = generateTestJwt("user-123", List.of("USER"));

    mockMvc.perform(get("/api/v1/orders")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + jwt))
           .andExpect(status().isOk());
}
```

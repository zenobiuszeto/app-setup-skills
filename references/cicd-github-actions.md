# GitHub Actions CI/CD — Enterprise Pipeline

## Pipeline Architecture

The enterprise pipeline is split into multiple workflows with clear quality gates at each stage:

1. **CI (continuous integration)** — runs on every push and PR. Builds, unit tests, integration tests, code quality gates, SAST, and container scanning.
2. **CD (continuous delivery)** — triggered after CI passes on `main`. Promotes through Dev → UAT → Prod with manual approval gates, functional tests, regression tests, and DAST.

## CI Workflow

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, 'feature/**', 'hotfix/**', 'release/**']
  pull_request:
    branches: [main, 'release/**']

permissions:
  contents: read
  checks: write
  pull-requests: write
  security-events: write   # for uploading SARIF results

env:
  JAVA_VERSION: '21'
  GRADLE_OPTS: '-Dorg.gradle.caching=true -Dorg.gradle.parallel=true'

jobs:
  # ──────────────────────────────────────────────
  # Stage 1: Build + Unit Tests
  # ──────────────────────────────────────────────
  build-and-test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB: testdb
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U test"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - name: Set up JDK ${{ env.JAVA_VERSION }}
        uses: actions/setup-java@v4
        with:
          java-version: ${{ env.JAVA_VERSION }}
          distribution: temurin
          cache: gradle

      - name: Grant execute permission for Gradle wrapper
        run: chmod +x gradlew

      - name: Build
        run: ./gradlew build -x test

      - name: Run unit tests
        run: ./gradlew test

      - name: Run integration tests
        run: ./gradlew integrationTest
        env:
          SPRING_DATASOURCE_URL: jdbc:postgresql://localhost:5432/testdb
          SPRING_DATASOURCE_USERNAME: test
          SPRING_DATASOURCE_PASSWORD: test
          SPRING_DATA_REDIS_HOST: localhost

      - name: Generate JaCoCo coverage report
        run: ./gradlew jacocoTestReport jacocoTestCoverageVerification

      - name: Publish test results
        if: always()
        uses: mikepenz/action-junit-report@v4
        with:
          report_paths: '**/build/test-results/**/TEST-*.xml'

      - name: Upload coverage report
        uses: actions/upload-artifact@v4
        with:
          name: coverage-report
          path: build/reports/jacoco/test/html/

      - name: Upload build artifact
        if: github.ref == 'refs/heads/main'
        uses: actions/upload-artifact@v4
        with:
          name: app-jar
          path: build/libs/*.jar
          retention-days: 5

  # ──────────────────────────────────────────────
  # Stage 2: Code Quality Gates
  # ──────────────────────────────────────────────
  code-quality:
    needs: build-and-test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0    # required for SonarQube blame info

      - name: Set up JDK ${{ env.JAVA_VERSION }}
        uses: actions/setup-java@v4
        with:
          java-version: ${{ env.JAVA_VERSION }}
          distribution: temurin
          cache: gradle

      - name: Cache SonarQube packages
        uses: actions/cache@v4
        with:
          path: ~/.sonar/cache
          key: ${{ runner.os }}-sonar

      - name: Run Checkstyle
        run: ./gradlew checkstyleMain checkstyleTest

      - name: Run PMD
        run: ./gradlew pmdMain

      - name: Run SpotBugs
        run: ./gradlew spotbugsMain

      - name: SonarQube analysis
        run: ./gradlew test jacocoTestReport sonar
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}

      - name: SonarQube Quality Gate
        uses: sonarsource/sonarqube-quality-gate-action@master
        timeout-minutes: 5
        env:
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}

      - name: Upload SpotBugs report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: spotbugs-report
          path: build/reports/spotbugs/

  # ──────────────────────────────────────────────
  # Stage 3: Security Scanning (SAST)
  # ──────────────────────────────────────────────
  security-sast:
    needs: build-and-test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up JDK ${{ env.JAVA_VERSION }}
        uses: actions/setup-java@v4
        with:
          java-version: ${{ env.JAVA_VERSION }}
          distribution: temurin
          cache: gradle

      - name: OWASP Dependency Check
        run: ./gradlew dependencyCheckAnalyze
        env:
          NVD_API_KEY: ${{ secrets.NVD_API_KEY }}

      - name: Upload Dependency Check report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: dependency-check-report
          path: build/reports/dependency-check-report.html

      - name: Secrets scanning (Gitleaks)
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: CodeQL Analysis
        uses: github/codeql-action/init@v3
        with:
          languages: java

      - name: CodeQL Autobuild
        uses: github/codeql-action/autobuild@v3

      - name: CodeQL Analysis results
        uses: github/codeql-action/analyze@v3
        with:
          category: "/language:java"

  # ──────────────────────────────────────────────
  # Stage 4: Docker Build + Container Scan
  # ──────────────────────────────────────────────
  docker-build:
    needs: [build-and-test, code-quality, security-sast]
    if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/release/')
    runs-on: ubuntu-latest
    outputs:
      image-tag: ${{ steps.meta.outputs.tags }}
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ vars.DOCKER_REGISTRY }}
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}

      - name: Docker metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ vars.DOCKER_REGISTRY }}/${{ github.repository }}
          tags: |
            type=sha,prefix=
            type=raw,value=latest,enable={{is_default_branch}}
            type=semver,pattern={{version}}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          # Sign the image (requires cosign setup)
          # provenance: true
          # sbom: true

      - name: Trivy container vulnerability scan
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ vars.DOCKER_REGISTRY }}/${{ github.repository }}:${{ github.sha }}
          format: sarif
          output: trivy-results.sarif
          severity: HIGH,CRITICAL
          exit-code: 1   # fail CI on HIGH/CRITICAL vulnerabilities

      - name: Upload Trivy SARIF
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: trivy-results.sarif
```

## CD Workflow — Environment Promotion

```yaml
# .github/workflows/cd.yml
name: CD - Deploy

on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]

permissions:
  contents: read
  deployments: write

concurrency:
  group: deploy
  cancel-in-progress: false  # don't cancel in-flight deploys

env:
  IMAGE_TAG: ${{ github.sha }}

jobs:
  # ──────────────────────────────────────────────
  # Stage 1: Deploy to DEV (automatic)
  # ──────────────────────────────────────────────
  deploy-dev:
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    environment:
      name: dev
      url: https://dev.{service}.example.com
    steps:
      - uses: actions/checkout@v4

      - name: Deploy to DEV
        run: |
          echo "Deploying $IMAGE_TAG to DEV..."
          # kubectl set image deployment/{service} app=$IMAGE_TAG -n {service}-dev
          # OR: helm upgrade --install {service} helm/{service} --values values-dev.yaml --set image.tag=$IMAGE_TAG
        env:
          KUBECONFIG_DATA: ${{ secrets.DEV_KUBECONFIG }}

      - name: Smoke test DEV
        run: |
          sleep 10
          curl --fail --retry 5 --retry-delay 5 \
            https://dev.{service}.example.com/actuator/health

      - name: Run Gatling smoke suite
        run: |
          ./gradlew gatlingRun -Dgatling.simulationClass=simulations.SmokeSuite \
            -Dgatling.baseUrl=https://dev.{service}.example.com

  # ──────────────────────────────────────────────
  # Stage 2a: Functional Tests on DEV
  # ──────────────────────────────────────────────
  functional-tests-dev:
    needs: deploy-dev
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up JDK 21
        uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: temurin
          cache: gradle

      - name: Run functional tests (smoke + critical-path tags)
        run: ./gradlew functionalTest -Dcucumber.filter.tags="@smoke or @critical-path"
        env:
          TEST_BASE_URL: https://dev.{service}.example.com
          TEST_TOKEN_URL: ${{ vars.DEV_TOKEN_URL }}
          TEST_CLIENT_ID: ${{ vars.DEV_CLIENT_ID }}
          TEST_CLIENT_SECRET: ${{ secrets.DEV_CLIENT_SECRET }}

      - name: Publish functional test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: functional-test-report-dev
          path: build/reports/cucumber/

  # ──────────────────────────────────────────────
  # Stage 3: Deploy to UAT (manual approval required)
  # ──────────────────────────────────────────────
  deploy-uat:
    needs: functional-tests-dev
    runs-on: ubuntu-latest
    environment:
      name: uat
      url: https://uat.{service}.example.com
    steps:
      - uses: actions/checkout@v4

      - name: Deploy to UAT
        run: |
          echo "Deploying $IMAGE_TAG to UAT..."
        env:
          KUBECONFIG_DATA: ${{ secrets.UAT_KUBECONFIG }}

      - name: Smoke test UAT
        run: |
          sleep 10
          curl --fail --retry 5 --retry-delay 5 \
            https://uat.{service}.example.com/actuator/health

  # ──────────────────────────────────────────────
  # Stage 3a: Full Regression on UAT
  # ──────────────────────────────────────────────
  regression-tests-uat:
    needs: deploy-uat
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up JDK 21
        uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: temurin
          cache: gradle

      - name: Run full regression suite
        run: ./gradlew regressionTest functionalTest
        env:
          TEST_BASE_URL: https://uat.{service}.example.com
          TEST_TOKEN_URL: ${{ vars.UAT_TOKEN_URL }}
          TEST_CLIENT_ID: ${{ vars.UAT_CLIENT_ID }}
          TEST_CLIENT_SECRET: ${{ secrets.UAT_CLIENT_SECRET }}
          SPRING_PROFILES_ACTIVE: uat

      - name: Run Gatling regression suite
        run: |
          ./gradlew gatlingRun -Dgatling.simulationClass=simulations.RegressionSuite \
            -Dgatling.baseUrl=https://uat.{service}.example.com

      - name: Publish regression results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: regression-report-uat
          path: |
            build/reports/cucumber/
            build/reports/gatling/

  # ──────────────────────────────────────────────
  # Stage 3b: DAST — Security Scan on UAT
  # ──────────────────────────────────────────────
  dast-uat:
    needs: deploy-uat
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: ZAP API Scan (DAST)
        uses: zaproxy/action-api-scan@v0.7.0
        with:
          target: https://uat.{service}.example.com/v3/api-docs
          format: openapi
          rules_file_name: zap-rules.conf
          cmd_options: '-I'

      - name: Upload ZAP report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: zap-report-uat
          path: report_html.html
          retention-days: 30

  # ──────────────────────────────────────────────
  # Stage 4: Deploy to PROD (manual approval required)
  # ──────────────────────────────────────────────
  deploy-prod:
    needs: [regression-tests-uat, dast-uat]
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://{service}.example.com
    steps:
      - uses: actions/checkout@v4

      - name: Deploy to PROD
        run: |
          echo "Deploying $IMAGE_TAG to PROD..."
          # helm upgrade --install {service} helm/{service} --values values-prod.yaml --set image.tag=$IMAGE_TAG --wait
        env:
          KUBECONFIG_DATA: ${{ secrets.PROD_KUBECONFIG }}

      - name: Health check PROD
        run: |
          sleep 15
          curl --fail --retry 10 --retry-delay 5 \
            https://{service}.example.com/actuator/health

      - name: Run Gatling smoke suite against PROD
        run: |
          ./gradlew gatlingRun -Dgatling.simulationClass=simulations.SmokeSuite \
            -Dgatling.baseUrl=https://{service}.example.com

      - name: Notify deployment
        if: success()
        run: |
          echo "Successfully deployed $IMAGE_TAG to production"
          # Add Slack/Teams/PagerDuty notification here
```

## Environment Configuration

In your GitHub repository, configure environments under **Settings → Environments**:

| Environment | Protection Rules |
|---|---|
| `dev` | None — auto-deploys on CI success |
| `uat` | Required reviewers (QA lead / tech lead) |
| `production` | Required reviewers (2 approvers, including Release Manager) + wait timer (30 min) |

Each environment has its own secrets and variables so credentials are scoped.

## Secrets Checklist

| Secret | Scope | Purpose |
|---|---|---|
| `DOCKER_USERNAME` | Repository | Container registry auth |
| `DOCKER_PASSWORD` | Repository | Container registry auth |
| `SONAR_TOKEN` | Repository | SonarQube/SonarCloud analysis |
| `NVD_API_KEY` | Repository | OWASP Dependency Check NVD API |
| `DEV_KUBECONFIG` | dev env | K8s cluster access (dev) |
| `DEV_CLIENT_SECRET` | dev env | OAuth2 client for functional tests |
| `UAT_KUBECONFIG` | uat env | K8s cluster access (UAT) |
| `UAT_CLIENT_SECRET` | uat env | OAuth2 client for regression tests |
| `PROD_KUBECONFIG` | production env | K8s cluster access (prod) |

## Pipeline Quality Gates Summary

| Gate | Stage | Blocks Merge? | Blocks Deploy? |
|---|---|---|---|
| Unit tests pass | CI | ✅ | ✅ |
| Integration tests pass | CI | ✅ | ✅ |
| Line coverage ≥ 80% | CI | ✅ | ✅ |
| SonarQube Quality Gate | CI | ✅ | ✅ |
| Zero SpotBugs HIGH/CRITICAL | CI | ✅ | ✅ |
| Zero OWASP Dep Check HIGH | CI | ✅ | ✅ |
| No secrets in code (Gitleaks) | CI | ✅ | ✅ |
| Zero Trivy HIGH/CRITICAL CVEs | CI | ❌ | ✅ |
| Smoke tests pass (DEV) | CD | ❌ | ✅ |
| Functional tests pass (DEV) | CD | ❌ | ✅ (UAT gate) |
| Regression tests pass (UAT) | CD | ❌ | ✅ (PROD gate) |
| DAST ZAP scan clean (UAT) | CD | ❌ | ✅ (PROD gate) |

## Nightly Security Workflow

```yaml
# .github/workflows/nightly-security.yml
name: Nightly Security Scan

on:
  schedule:
    - cron: '0 2 * * *'   # 2 AM UTC daily
  workflow_dispatch:

jobs:
  full-dast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: ZAP Full Scan against DEV
        uses: zaproxy/action-full-scan@v0.10.0
        with:
          target: ${{ vars.DEV_BASE_URL }}
          rules_file_name: zap-rules.conf
          cmd_options: '-z "-config scanner.attackStrength=MEDIUM"'

      - name: Upload ZAP Full Report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: zap-full-report-${{ github.run_id }}
          path: report_html.html
          retention-days: 90

  dependency-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: temurin
          cache: gradle
      - name: OWASP Dependency Check (full NVD update)
        run: ./gradlew dependencyCheckUpdate dependencyCheckAnalyze
        env:
          NVD_API_KEY: ${{ secrets.NVD_API_KEY }}
```

## Reusable Deploy Action (DRY)

Extract deploy steps into a composite action at `.github/actions/deploy/action.yml`:

```yaml
name: Deploy Service
description: Deploy a Docker image to a target environment via Helm

inputs:
  environment:
    required: true
  image-tag:
    required: true
  kubeconfig:
    required: true
  values-file:
    required: true
  health-url:
    required: true
  namespace:
    required: true

runs:
  using: composite
  steps:
    - name: Set up Helm
      uses: azure/setup-helm@v4
      with:
        version: 'v3.15.4'

    - name: Configure kubectl
      shell: bash
      run: |
        echo "${{ inputs.kubeconfig }}" | base64 -d > /tmp/kubeconfig
        echo "KUBECONFIG=/tmp/kubeconfig" >> $GITHUB_ENV

    - name: Helm deploy
      shell: bash
      run: |
        helm upgrade --install ${{ inputs.environment }}-svc helm/{service} \
          --namespace ${{ inputs.namespace }} \
          --create-namespace \
          --values ${{ inputs.values-file }} \
          --set image.tag=${{ inputs.image-tag }} \
          --wait \
          --timeout 10m

    - name: Health check
      shell: bash
      run: |
        sleep 15
        curl --fail --retry 10 --retry-delay 5 ${{ inputs.health-url }}/actuator/health
```

Then each stage becomes:

```yaml
- uses: ./.github/actions/deploy
  with:
    environment: dev
    image-tag: ${{ env.IMAGE_TAG }}
    kubeconfig: ${{ secrets.DEV_KUBECONFIG }}
    values-file: helm/{service}/values-dev.yaml
    health-url: https://dev.{service}.example.com
    namespace: {service}-dev
```

## Gradle Task Separation

Split test tasks in `build.gradle` so CI can run unit, integration, regression, and functional tests independently:

```groovy
// Separate source sets for integration, regression, and functional tests
sourceSets {
    integrationTest {
        java.srcDir 'src/integrationTest/java'
        resources.srcDir 'src/integrationTest/resources'
        compileClasspath += sourceSets.main.output + sourceSets.test.output
        runtimeClasspath += sourceSets.main.output + sourceSets.test.output
    }
    functionalTest {
        java.srcDir 'src/functionalTest/java'
        resources.srcDir 'src/functionalTest/resources'
        compileClasspath += sourceSets.main.output
        runtimeClasspath += sourceSets.main.output
    }
}

configurations {
    integrationTestImplementation.extendsFrom testImplementation
    integrationTestRuntimeOnly.extendsFrom testRuntimeOnly
    functionalTestImplementation.extendsFrom testImplementation
    functionalTestRuntimeOnly.extendsFrom testRuntimeOnly
}

tasks.register('integrationTest', Test) {
    description = 'Runs integration tests.'
    group = 'verification'
    testClassesDirs = sourceSets.integrationTest.output.classesDirs
    classpath = sourceSets.integrationTest.runtimeClasspath
    useJUnitPlatform()
    shouldRunAfter test
}

tasks.register('regressionTest', Test) {
    description = 'Runs regression test suite.'
    group = 'verification'
    testClassesDirs = sourceSets.test.output.classesDirs
    classpath = sourceSets.test.runtimeClasspath
    useJUnitPlatform {
        includeTags 'regression'
        excludeTags 'slow'
    }
    shouldRunAfter integrationTest
}

tasks.register('functionalTest', Test) {
    description = 'Runs functional (BDD/REST) tests.'
    group = 'verification'
    testClassesDirs = sourceSets.functionalTest.output.classesDirs
    classpath = sourceSets.functionalTest.runtimeClasspath
    useJUnitPlatform()
    systemProperty 'cucumber.publish.quiet', 'true'
    shouldRunAfter regressionTest
}

check.dependsOn integrationTest
```

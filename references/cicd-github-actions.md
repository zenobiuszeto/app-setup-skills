# GitHub Actions CI/CD — Dev → UAT → Prod

## Pipeline Architecture

The pipeline is split into two workflows:

1. **CI (continuous integration)** — runs on every push and PR. Builds, tests, scans.
2. **CD (continuous delivery)** — triggered after CI passes on `main`. Promotes through Dev → UAT → Prod with manual approval gates.

## CI Workflow

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, 'feature/**', 'hotfix/**']
  pull_request:
    branches: [main]

permissions:
  contents: read
  checks: write
  pull-requests: write

env:
  JAVA_VERSION: '21'
  GRADLE_OPTS: '-Dorg.gradle.caching=true -Dorg.gradle.parallel=true'

jobs:
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

      - name: Publish test results
        if: always()
        uses: mikepenz/action-junit-report@v4
        with:
          report_paths: '**/build/test-results/**/TEST-*.xml'

      - name: Upload build artifact
        if: github.ref == 'refs/heads/main'
        uses: actions/upload-artifact@v4
        with:
          name: app-jar
          path: build/libs/*.jar
          retention-days: 5

  docker-build:
    needs: build-and-test
    if: github.ref == 'refs/heads/main'
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
            type=raw,value=latest

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
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
          # Replace with your actual deploy command:
          # docker compose -f docker-compose.dev.yml up -d
          # OR: ssh deploy@dev-server "docker pull $IMAGE && docker compose up -d"
          # OR: kubectl set image deployment/{service} app=$IMAGE_TAG
        env:
          DEPLOY_HOST: ${{ secrets.DEV_DEPLOY_HOST }}
          DEPLOY_KEY: ${{ secrets.DEV_SSH_KEY }}

      - name: Smoke test DEV
        run: |
          sleep 10
          curl --fail --retry 5 --retry-delay 5 \
            https://dev.{service}.example.com/actuator/health

      - name: Run Gatling smoke suite
        run: |
          ./gradlew gatlingRun -Dgatling.simulation=SmokeSuite \
            -Dgatling.baseUrl=https://dev.{service}.example.com

  # ──────────────────────────────────────────────
  # Stage 2: Deploy to UAT (manual approval)
  # ──────────────────────────────────────────────
  deploy-uat:
    needs: deploy-dev
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
          DEPLOY_HOST: ${{ secrets.UAT_DEPLOY_HOST }}
          DEPLOY_KEY: ${{ secrets.UAT_SSH_KEY }}

      - name: Smoke test UAT
        run: |
          sleep 10
          curl --fail --retry 5 --retry-delay 5 \
            https://uat.{service}.example.com/actuator/health

      - name: Run Gatling regression suite
        run: |
          ./gradlew gatlingRun -Dgatling.simulation=RegressionSuite \
            -Dgatling.baseUrl=https://uat.{service}.example.com

  # ──────────────────────────────────────────────
  # Stage 3: Deploy to PROD (manual approval)
  # ──────────────────────────────────────────────
  deploy-prod:
    needs: deploy-uat
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://{service}.example.com
    steps:
      - uses: actions/checkout@v4

      - name: Deploy to PROD
        run: |
          echo "Deploying $IMAGE_TAG to PROD..."
        env:
          DEPLOY_HOST: ${{ secrets.PROD_DEPLOY_HOST }}
          DEPLOY_KEY: ${{ secrets.PROD_SSH_KEY }}

      - name: Health check PROD
        run: |
          sleep 15
          curl --fail --retry 10 --retry-delay 5 \
            https://{service}.example.com/actuator/health

      - name: Notify deployment
        if: success()
        run: |
          echo "Successfully deployed $IMAGE_TAG to production"
          # Add Slack/Teams notification here
```

## Environment Configuration

In your GitHub repository, configure three environments under **Settings → Environments**:

| Environment | Protection Rules |
|---|---|
| `dev` | None — auto-deploys on CI success |
| `uat` | Required reviewers (QA lead / tech lead) |
| `production` | Required reviewers (2 approvers) + wait timer (optional) |

Each environment has its own secrets (`DEV_DEPLOY_HOST`, `UAT_SSH_KEY`, etc.) so credentials are scoped.

## Secrets Checklist

| Secret | Scope | Purpose |
|---|---|---|
| `DOCKER_USERNAME` | Repository | Container registry auth |
| `DOCKER_PASSWORD` | Repository | Container registry auth |
| `DEV_DEPLOY_HOST` | dev env | Target server address |
| `DEV_SSH_KEY` | dev env | SSH deploy key |
| `UAT_DEPLOY_HOST` | uat env | Target server address |
| `UAT_SSH_KEY` | uat env | SSH deploy key |
| `PROD_DEPLOY_HOST` | production env | Target server address |
| `PROD_SSH_KEY` | production env | SSH deploy key |

## Reusable Deploy Action (DRY)

If you prefer less duplication, extract deploy steps into a composite action at `.github/actions/deploy/action.yml`:

```yaml
name: Deploy Service
description: Deploy a Docker image to a target environment

inputs:
  environment:
    required: true
  image-tag:
    required: true
  deploy-host:
    required: true
  ssh-key:
    required: true
  health-url:
    required: true

runs:
  using: composite
  steps:
    - name: Deploy
      shell: bash
      run: |
        echo "Deploying ${{ inputs.image-tag }} to ${{ inputs.environment }}..."
        # Your actual deploy logic here

    - name: Health check
      shell: bash
      run: |
        sleep 10
        curl --fail --retry 10 --retry-delay 5 ${{ inputs.health-url }}/actuator/health
```

Then each stage becomes:

```yaml
- uses: ./.github/actions/deploy
  with:
    environment: dev
    image-tag: ${{ env.IMAGE_TAG }}
    deploy-host: ${{ secrets.DEV_DEPLOY_HOST }}
    ssh-key: ${{ secrets.DEV_SSH_KEY }}
    health-url: https://dev.{service}.example.com
```

## Gradle Task Separation

Split test tasks in `build.gradle` so CI can run unit and integration tests independently:

```groovy
// Separate source set for integration tests
sourceSets {
    integrationTest {
        java.srcDir 'src/integrationTest/java'
        resources.srcDir 'src/integrationTest/resources'
        compileClasspath += sourceSets.main.output + sourceSets.test.output
        runtimeClasspath += sourceSets.main.output + sourceSets.test.output
    }
}

configurations {
    integrationTestImplementation.extendsFrom testImplementation
    integrationTestRuntimeOnly.extendsFrom testRuntimeOnly
}

tasks.register('integrationTest', Test) {
    description = 'Runs integration tests.'
    group = 'verification'
    testClassesDirs = sourceSets.integrationTest.output.classesDirs
    classpath = sourceSets.integrationTest.runtimeClasspath
    useJUnitPlatform()
    shouldRunAfter test
}

check.dependsOn integrationTest
```

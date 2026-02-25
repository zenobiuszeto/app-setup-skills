# Code Quality — JaCoCo, SonarQube, SpotBugs, Checkstyle

Enterprise code quality is enforced automatically in CI. No PR should merge without passing all quality gates. This reference covers the full toolchain: coverage, static analysis, style, and the SonarQube quality gate.

## JaCoCo — Code Coverage

### Setup

```groovy
// build.gradle
plugins {
    id 'jacoco'
}

jacoco {
    toolVersion = '0.8.12'
}

tasks.named('test') {
    finalizedBy jacocoTestReport
}

jacocoTestReport {
    dependsOn test

    reports {
        xml.required = true   // required by SonarQube
        html.required = true
        csv.required = false
    }

    // Exclude generated/config classes from coverage
    afterEvaluate {
        classDirectories.setFrom(files(classDirectories.files.collect {
            fileTree(dir: it, exclude: [
                'com/**/config/**',
                'com/**/model/entity/**',
                'com/**/model/dto/**',
                'com/**/model/event/**',
                'com/**/*Application.class',
                'com/**/*Properties.class',
                'com/**/exception/ErrorResponse.class'
            ])
        }))
    }
}

jacocoTestCoverageVerification {
    violationRules {
        rule {
            element = 'CLASS'
            excludes = [
                '*.*Application',
                '*.config.*',
                '*.model.*'
            ]
            limits {
                counter = 'LINE'
                value = 'COVEREDRATIO'
                minimum = 0.80   // 80% line coverage minimum
            }
            limits {
                counter = 'BRANCH'
                value = 'COVEREDRATIO'
                minimum = 0.70   // 70% branch coverage minimum
            }
        }
    }
}

// Make check fail if coverage thresholds not met
check.dependsOn jacocoTestCoverageVerification
```

### Coverage Reports

```bash
# Run tests + generate coverage report
./gradlew test jacocoTestReport

# View report
open build/reports/jacoco/test/html/index.html

# Enforce coverage thresholds
./gradlew jacocoTestCoverageVerification
```

### Aggregate Coverage (Multi-Module)

In a multi-module Gradle project, aggregate coverage across all submodules:

```groovy
// root build.gradle (aggregating project)
plugins {
    id 'jacoco-report-aggregation'
}

dependencies {
    jacocoAggregation project(':order-service')
    jacocoAggregation project(':inventory-service')
    jacocoAggregation project(':payment-service')
}

reporting {
    reports {
        testCodeCoverageReport(JacocoCoverageReport) {
            testSuiteName = 'test'
        }
    }
}
```

---

## SonarQube — Code Quality Gate

SonarQube (or SonarCloud for GitHub-hosted projects) provides the single quality gate that determines whether code is fit to merge.

### Setup

```groovy
// build.gradle
plugins {
    id 'org.sonarqube' version '5.1.0.4882'
}

sonar {
    properties {
        property 'sonar.projectKey', '{org}_{service}'
        property 'sonar.projectName', '{service}'
        property 'sonar.host.url', System.getenv('SONAR_HOST_URL') ?: 'https://sonarcloud.io'
        property 'sonar.organization', '{org}'
        property 'sonar.sources', 'src/main/java'
        property 'sonar.tests', 'src/test/java,src/integrationTest/java'
        property 'sonar.java.coveragePlugin', 'jacoco'
        property 'sonar.coverage.jacoco.xmlReportPaths', 'build/reports/jacoco/test/jacocoTestReport.xml'
        property 'sonar.exclusions', [
            '**/model/entity/**',
            '**/model/dto/**',
            '**/model/event/**',
            '**/*Application.java',
            '**/config/**'
        ].join(',')
        property 'sonar.cpd.exclusions', '**/model/**'
    }
}
```

### GitHub Actions Integration

```yaml
# In .github/workflows/ci.yml
  sonar-analysis:
    needs: build-and-test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0    # required for accurate blame info

      - name: Set up JDK 21
        uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: temurin
          cache: gradle

      - name: Cache SonarQube packages
        uses: actions/cache@v4
        with:
          path: ~/.sonar/cache
          key: ${{ runner.os }}-sonar

      - name: Build, test, and analyze
        run: ./gradlew build test jacocoTestReport sonar --info
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}   # PR decoration
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}

      - name: Check Quality Gate
        uses: sonarsource/sonarqube-quality-gate-action@master
        timeout-minutes: 5
        env:
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

### Quality Gate Definition

Define your quality gate in SonarQube UI or via `sonar-project.properties`:

```properties
# Recommended enterprise quality gate conditions

# New code must have:
sonar.qualitygate.conditions=\
  new_reliability_rating=A,\
  new_security_rating=A,\
  new_maintainability_rating=A,\
  new_coverage>=80,\
  new_duplicated_lines_density<=3,\
  new_security_hotspots_reviewed=100
```

| Metric | Threshold | Rationale |
|---|---|---|
| New Bugs | 0 | No regressions on new code |
| New Vulnerabilities | 0 | Security non-negotiable |
| New Security Hotspots reviewed | 100% | All hotspots must be reviewed |
| New Code Coverage | ≥ 80% | Meaningful coverage for new features |
| New Code Duplications | ≤ 3% | Keep codebase DRY |
| New Maintainability Rating | A | Technical debt below 5% |

---

## SpotBugs — Static Bug Analysis

SpotBugs finds real bugs: null dereferences, infinite loops, bad serialisation, and more.

### Setup

```groovy
// build.gradle
plugins {
    id 'com.github.spotbugs' version '6.0.18'
}

spotbugs {
    toolVersion = '4.8.6'
    effort = 'max'
    reportLevel = 'medium'   // report MEDIUM and above
    excludeFilter = file('config/spotbugs-exclude.xml')
    ignoreFailures = false    // fail the build on findings
}

spotbugsMain {
    reports {
        html {
            required = true
            outputLocation = file('build/reports/spotbugs/main.html')
        }
        xml {
            required = true   // for CI integration
        }
    }
}

spotbugsTest {
    reports {
        html { required = true }
    }
}
```

### Exclusion Filter

```xml
<!-- config/spotbugs-exclude.xml -->
<FindBugsFilter>
    <!-- Exclude generated code -->
    <Match>
        <Class name="~.*\$.*" />
    </Match>

    <!-- Lombok-generated code -->
    <Match>
        <Bug pattern="EI_EXPOSE_REP,EI_EXPOSE_REP2" />
        <Class name="~.*Dto$" />
    </Match>

    <!-- False positives in JPA entities -->
    <Match>
        <Bug pattern="SE_NO_SERIALVERSIONID" />
        <Class name="~com\..*\.model\.entity\..*" />
    </Match>
</FindBugsFilter>
```

### Suppressing Individual Findings

```java
// Suppress a specific SpotBugs warning with justification
@SuppressFBWarnings(
    value = "NP_NULL_ON_SOME_PATH_FROM_RETURN_VALUE",
    justification = "findById always returns non-null in this context — validated upstream"
)
public Order getOrderById(UUID id) { ... }
```

---

## PMD — Code Style and Anti-patterns

```groovy
// build.gradle
plugins {
    id 'pmd'
}

pmd {
    toolVersion = '7.5.0'
    ruleSets = []             // disable all default rulesets
    ruleSetFiles = files('config/pmd-rules.xml')
    consoleOutput = true
    ignoreFailures = false
}

pmdMain {
    reports {
        html.required = true
        xml.required = true
    }
}
```

```xml
<!-- config/pmd-rules.xml -->
<?xml version="1.0"?>
<ruleset name="Enterprise Rules"
         xmlns="http://pmd.sourceforge.net/ruleset/2.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://pmd.sourceforge.net/ruleset/2.0.0 ruleset_2_0_0.xsd">

    <description>Enterprise PMD ruleset</description>

    <!-- Best Practices -->
    <rule ref="category/java/bestpractices.xml/UnusedImports"/>
    <rule ref="category/java/bestpractices.xml/UnusedLocalVariable"/>
    <rule ref="category/java/bestpractices.xml/UnusedPrivateField"/>
    <rule ref="category/java/bestpractices.xml/UnusedPrivateMethod"/>
    <rule ref="category/java/bestpractices.xml/UseCollectionIsEmpty"/>
    <rule ref="category/java/bestpractices.xml/AvoidReassigningParameters"/>

    <!-- Error Prone -->
    <rule ref="category/java/errorprone.xml/AvoidDecimalLiteralsInBigDecimalConstructor"/>
    <rule ref="category/java/errorprone.xml/DoNotCallGarbageCollectionExplicitly"/>
    <rule ref="category/java/errorprone.xml/EmptyCatchBlock"/>
    <rule ref="category/java/errorprone.xml/EqualsNull"/>
    <rule ref="category/java/errorprone.xml/NullAssignment"/>

    <!-- Performance -->
    <rule ref="category/java/performance.xml/BigIntegerInstantiation"/>
    <rule ref="category/java/performance.xml/UseIndexOfChar"/>
    <rule ref="category/java/performance.xml/UseStringBufferLength"/>

    <!-- Security -->
    <rule ref="category/java/security.xml"/>

    <!-- Design -->
    <rule ref="category/java/design.xml/CyclomaticComplexity">
        <properties>
            <property name="methodReportLevel" value="15"/>
        </properties>
    </rule>
    <rule ref="category/java/design.xml/TooManyMethods">
        <properties>
            <property name="maxmethods" value="20"/>
        </properties>
    </rule>
</ruleset>
```

---

## Checkstyle — Code Style Enforcement

```groovy
// build.gradle
plugins {
    id 'checkstyle'
}

checkstyle {
    toolVersion = '10.18.2'
    configFile = file('config/checkstyle.xml')
    ignoreFailures = false
    showViolations = true
}
```

```xml
<!-- config/checkstyle.xml — based on Google Java Style -->
<!DOCTYPE module PUBLIC "-//Checkstyle//DTD Checkstyle Configuration 1.3//EN"
    "https://checkstyle.org/dtds/configuration_1_3.dtd">
<module name="Checker">
    <property name="severity" value="error"/>

    <module name="TreeWalker">
        <!-- Imports -->
        <module name="AvoidStarImport"/>
        <module name="UnusedImports"/>
        <module name="IllegalImport">
            <property name="illegalPkgs" value="sun, com.sun"/>
        </module>

        <!-- Naming -->
        <module name="ConstantName"/>
        <module name="LocalVariableName"/>
        <module name="MethodName"/>
        <module name="TypeName"/>

        <!-- Code Size -->
        <module name="MethodLength">
            <property name="max" value="80"/>
        </module>
        <module name="ParameterNumber">
            <property name="max" value="7"/>
        </module>

        <!-- Whitespace / Braces -->
        <module name="NeedBraces"/>
        <module name="LeftCurly"/>
        <module name="RightCurly"/>

        <!-- Misc -->
        <module name="EqualsHashCode"/>
        <module name="MissingSwitchDefault"/>
        <module name="FallThrough"/>
        <module name="OneStatementPerLine"/>
        <module name="StringLiteralEquality"/>
    </module>

    <!-- File-level checks -->
    <module name="FileLength">
        <property name="max" value="500"/>
    </module>
    <module name="NewlineAtEndOfFile"/>
</module>
```

---

## Combining All Quality Tools

Run all quality checks together:

```bash
# Run all quality checks
./gradlew check

# Individual tools
./gradlew checkstyleMain
./gradlew pmdMain
./gradlew spotbugsMain
./gradlew test jacocoTestReport jacocoTestCoverageVerification
./gradlew sonar
```

### CI Quality Gate Order

```yaml
# .github/workflows/ci.yml — quality stage
  quality-gates:
    needs: build-and-test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set up JDK 21
        uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: temurin
          cache: gradle

      - name: Run code quality checks
        run: |
          ./gradlew checkstyleMain \
                    pmdMain \
                    spotbugsMain \
                    test \
                    jacocoTestReport \
                    jacocoTestCoverageVerification \
                    sonar
        env:
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}

      - name: Upload coverage report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverage-report
          path: build/reports/jacoco/test/html/

      - name: Upload SpotBugs report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: spotbugs-report
          path: build/reports/spotbugs/

      - name: Upload PMD report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: pmd-report
          path: build/reports/pmd/
```

---

## Baseline and Suppression Best Practices

- **Never suppress warnings silently** — always add a comment explaining *why*.
- **Use SpotBugs `@SuppressFBWarnings`** (not `@SuppressWarnings`) for SpotBugs findings; it captures the reason.
- **Track technical debt** — SonarQube assigns a time cost to each issue. Review the debt regularly.
- **Ratchet the thresholds upward** — start at 60% coverage, move to 80% as tests are added. Never lower a threshold once established.
- **Exclude only what you must** — generated code, DTOs, and configuration classes are reasonable exclusions. Business logic must be covered.

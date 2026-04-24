# Security Policy

## Supported Versions

Security fixes ship for the two most recent minor releases of the
`harness-one` core package. Older minors are best-effort.

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

<!-- TODO(owner): bump the table each time a new minor ships. -->

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security reports.**

The preferred channel is GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Fill in the advisory form — GitHub delivers the report privately to the
   maintainers.

If you cannot use GitHub Security Advisories, email
`security@harness-one.dev` instead.
<!-- TODO(owner): replace with a real security contact before public launch. -->

Please include: affected package + version, a minimal reproduction,
impact assessment, and any known mitigations.

## Response SLA

We aim to meet the following timelines:

- **Acknowledgement**: within **7 calendar days** of your initial report.
- **Triage & assessment**: within **14 days** of acknowledgement.
- **Fix or mitigation**: within **30 days** of acknowledgement for
  confirmed vulnerabilities, or a public schedule if a longer horizon is
  required.

Coordinated disclosure is the default. We will work with you on a public
advisory once a fix or mitigation is available.

## Safe Harbor

We will not pursue legal action against researchers who:

- Report in good faith via the channels above.
- Avoid privacy violations, service degradation, or data destruction.
- Give us reasonable time to remediate before public disclosure.

Activity consistent with this policy is authorized; we consider it to be
protected research and will not treat it as a violation of our terms.

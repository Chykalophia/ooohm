# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub:
[Report a vulnerability](https://github.com/Chykalophia/ooohm/security/advisories/new).
Don't open a public issue or pull request for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with it.
We aim to acknowledge reports within 3 business days and to agree on a fix and a
disclosure date with you before anything is published.

## Supported versions

OOOhm has no versioned releases yet. Fixes land on `main`. To pick one up, upgrade to
a known commit on `main` that includes it, following
[Upgrades](docs/deploy.md#14-upgrades-10-min) in `docs/deploy.md`.

## Scope

In scope: the OOOhm application and its build and deploy files in this repository
(`Dockerfile`, `deploy/`, `docker-compose.yml`, `vercel.json`).

Out of scope: vulnerabilities in a hosting provider, database or email service you
run OOOhm on, and findings that only work for an attacker who is already an OOOhm
admin. A way to become an admin, or to act as one, is in scope.

# Releasing

Two steps, in this order. The first one needs a human; after it, releases are CI-only.

## 1. First publish (once, in a real terminal)

`npm` cannot be configured as a trusted publisher for a package that does not exist yet, and a non-TTY shell
can never clear the 2FA challenge, so this step is manual:

```bash
cd dsh-cnblogs
npm publish --access public
```

Open the URL npm prints, authenticate with 2FA, and finish the flow it describes. A session/agent shell fails
here with `EOTP` — that is expected, not a packaging problem.

Verify from the registry, not from the terminal output:

```bash
npm view dsh-cnblogs version dist.tarball
```

## 2. Trusted publisher (once, in the browser)

Open <https://www.npmjs.com/package/dsh-cnblogs/access> → **Trusted Publisher** → **GitHub Actions**:

| Field | Value |
|---|---|
| Organization or user | `Niobium-41-nb` |
| Repository | `dsh-cnblogs` |
| Workflow filename | `publish.yml` |
| Environment name | *(leave empty)* |
| Allowed actions | ☑ `npm publish` |

Both text fields fail **silently** when wrong, because npm saves them without validating:

- the workflow filename must match byte-for-byte (`publish.yml`, with the extension, case-sensitive);
- **Allowed actions** must include `npm publish` — configurations created after 2026-09-03 default to
  `npm stage publish` only, and the workflow then fails with `ENEEDAUTH`.

## 3. Later releases (no human)

```bash
npm version patch            # or minor / major
git push origin master --follow-tags
git push origin v0.1.1       # tag push triggers .github/workflows/publish.yml
```

The workflow installs, builds, asks the registry whether that exact version exists, and publishes only when it
does not — so pushing a tag twice, or running it manually, is a safe no-op. It authenticates through OIDC
(`id-token: write`), stores no token, and needs a cloud-hosted runner.

## Checking a release

```bash
npm view dsh-cnblogs version
npm pack dsh-cnblogs@<version>   # inspect the real tarball: lib/, locale/, docs/, icon.svg, README, LICENSE
```

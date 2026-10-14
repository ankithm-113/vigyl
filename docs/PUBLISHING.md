# Publishing Vigyl

Releases are published by GitHub Actions, not from a laptop. There is no
`NPM_TOKEN` in this repository and there should never be one.

## Right now, for v0.2.0

The tag `v0.2.0` exists locally at `be91f41` and has **not** been pushed.
Pushing it runs the workflow, which will publish `@vigylx/daemon` and then stop
at `@vigylx/slm` with a 404, because that package has never existed and npm has
no trusted publisher for it.

So do the one-time setup below **first**, then push the tag. In order:

1. add an authenticator app to the npm account
2. `npm login`, then publish all four by hand (`daemon`, `slm`, `mcp-servers`,
   `cli` — in that order)
3. configure the trusted publisher on each of the four packages
4. `git push origin v0.2.0` — the workflow then finds everything already
   published, skips it, and confirms the versions line up
5. check it from a machine that has never seen Vigyl:
   `npm i -g @vigylx/cli && vigyl --version` should print `0.2.0`

Step 5 is not a formality. v0.1.0's clean-install check found two packaging
bugs in thirty seconds.

## Why it works this way

v0.1.0 went out with a bypass-2FA token, because the npm account's second
factor is a passkey and the npm CLI asks for a TOTP code a passkey cannot
produce. That route is a dead end twice over: npm removes bypass tokens for
publishing in **January 2027**, and a long-lived token that can publish is a
token that can be stolen.

Trusted publishing replaces it. The workflow mints a short-lived OIDC token that
npm verifies against a publisher *you* configured — this repository, this
workflow file. Nothing to rotate, nothing to leak, and no 2FA prompt, because
the proof is the workflow's identity rather than a secret it holds. Published
packages also get provenance automatically, so anyone can see which commit and
workflow run built the tarball.

## One-time setup

### 1. The two new packages need a manual publish first

`@vigylx/slm` and `@vigylx/mcp-servers` have never been published.
**npm only lets you configure a trusted publisher for a package that already
exists**, so there is no way to bootstrap a brand-new name through OIDC. This
is a one-time problem per package name.

You need a TOTP code for this, which means adding an authenticator app to the
npm account (Account → Two-factor authentication → add an authenticator app
alongside the passkey). That is worth doing once regardless: it is the way back
in if the passkey is ever lost.

```bash
npm login
npm publish -w packages/daemon      --access public
npm publish -w packages/slm         --access public
npm publish -w packages/mcp-servers --access public
npm publish -w packages/cli         --access public
```

**Publish in that order.** `@vigylx/cli` depends on `@vigylx/slm` and
`@vigylx/daemon`, so publishing the CLI first leaves a window where
`npm i -g @vigylx/cli` fails with E404 for everyone who tries it.

### 2. Configure the trusted publisher, on all four

On npmjs.com, for **each** of `@vigylx/daemon`, `@vigylx/slm`,
`@vigylx/mcp-servers` and `@vigylx/cli`:

> Package → Settings → Trusted publisher → GitHub Actions
>
> | Field | Value |
> |---|---|
> | Organization or user | `ankithm-113` |
> | Repository | `vigyl` |
> | Workflow filename | `publish.yml` |
> | Environment | *leave empty* |

The workflow filename must match exactly. A renamed workflow stops publishing
and the error does not say why.

### 3. Turn 2FA back on

If you disabled it to publish, re-enable it. Trusted publishing is unaffected by
account 2FA — that is the point.

## Every release after that

```bash
# 1. bump versions and commit (see the version checks in the workflow)
# 2. tag
git tag -a v0.2.0 -m "Vigyl v0.2.0"
git push origin v0.2.0
```

Pushing a `v*.*.*` tag runs `.github/workflows/publish.yml`, which:

1. builds and runs the whole test suite — a failing suite does not publish
2. checks the tag matches `package.json`
3. checks all four packages agree on the version
4. checks the `@vigylx` cross-references point at that version, since npm
   resolves them locally in a workspace but publishes them as real ranges
5. publishes `daemon → slm → mcp-servers → cli`, skipping anything already on
   the registry so a re-run after a partial failure finishes the job

## Checking it before tagging

Run the workflow by hand with **Dry run** ticked
(Actions → Publish → Run workflow). It does everything except publish, including
`npm publish --dry-run` for each package so you can read the tarball contents.
No credentials are involved.

## After publishing, always

```bash
npm view @vigylx/cli version          # should be the version you tagged
npm i -g @vigylx/cli && vigyl doctor  # on a machine that has never had it
```

An install from a different machine is the only check that catches a missing
dependency, a file left out of `files`, or a cross-reference pointing at a
version that does not exist. A published version cannot be replaced, so this is
cheaper before anyone else tries it.

## When it fails

**`npm error code ENEEDAUTH` or an OIDC error** — the trusted publisher is not
configured for that package, or the workflow filename does not match what npm
has. Check step 2 above.

**`npm error 404` on a package that exists** — the first publish of that name
has not happened yet. See step 1.

**The job publishes some packages and then fails** — safe. They go out in
dependency order, so a failure part-way leaves a consistent registry rather
than a CLI pointing at a sibling that is not there. Fix the cause and re-run;
already-published versions are skipped.

**A tag was pushed with the wrong version** — delete it, fix, tag again:

```bash
git push origin --delete v0.2.0
git tag -d v0.2.0
```

A published npm version cannot be replaced. If a bad one goes out, publish a
patch version; do not unpublish.

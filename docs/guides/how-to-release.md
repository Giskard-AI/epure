# How-To: Promote a Release (`dev -> main`)

In EPURE, `dev` is the active default integration branch and `main` is the **immutable release line** protected by the `epure-release-immutability` ruleset. Neither developers nor the `Agent App` can push directly to `main`.

Promoting a release is the **4th Mandatory Human Validation Gate** (Q101).

---

## 1. Prerequisites Before Promoting

Before triggering a release promotion, verify that:

1. All target `feature/* -> dev` Pull Requests have been squash-merged into `dev`.
2. The `CI` workflow on the latest `dev` commit is green.
3. The repository secrets `EPURE_RELEASE_APP_ID` and `EPURE_RELEASE_APP_PRIVATE_KEY` are configured, and `<owner>-epure-release` is listed as the Bypass Actor on `epure-release-immutability`.

---

## 2. Trigger the Release Promotion Workflow

You can trigger the release either from the GitHub web UI (**Actions** -> **Release Promote (dev -> main)** -> **Run workflow**) or via the `gh` CLI:

```bash
gh workflow run release-promote.yml \
  -R my-org/craft-calculator \
  -f version=v1.0.0
```

---

## 3. What `release-promote.yml` Executes

1. **Mints a Short-Lived Release App Token**: Signs an RS256 JWT using `EPURE_RELEASE_APP_ID` and `EPURE_RELEASE_APP_PRIVATE_KEY` to obtain a short-lived installation token for `<owner>-epure-release`.
2. **Verifies Fast-Forward Ancestry**: Checks that `main` is a strict ancestor of `dev` (`git merge-base --is-ancestor origin/main origin/dev`). If `main` has diverged, the workflow aborts immediately without forcing a push.
3. **Atomic Fast-Forward & Tag**:
   - Pushes `dev` to `refs/heads/main` (`git push origin dev:refs/heads/main`).
   - Creates and pushes the annotated tag `v1.0.0` pointing to the exact promoted SHA.
   - Publishes the GitHub Release notes generated from the Conventional Commits merged since the previous tag.
4. **Revokes the Ephemeral Token**: Immediately revokes the installation token in an `always()` cleanup step.

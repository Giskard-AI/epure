# How-To: Promote a Release (`dev -> main`)

In EPURE, `dev` is the integration branch and `main` is the **release line**. Neither developers nor the `Agent App` push to `main`: only the **Release App** (`<owner>-epure-release`) does, from the release workflow, inside the protected `release` environment.

Promoting a release is the **4th Mandatory Human Validation Gate** (Q101).

Both entry points run the same implementation, the reusable workflow `Giskard-AI/epure/.github/workflows/release-promote.yml`:

| Repository | Workflow to dispatch | Rulesets that must list the Release App as bypass actor |
| --- | --- | --- |
| Consumer repository bootstrapped by `/setup-repo` | `.github/workflows/release.yml` (**EPURE Controlled Release (dev -> main)**), a thin caller pinned to an EPURE commit SHA | `epure-release-immutability`, `epure-release-tags` |
| `Giskard-AI/epure` itself | `.github/workflows/release-promote.yml` (**Promote Dev to Main (Fast-Forward Release)**) | `Main basic protection`, `epure-branch-governance`, `epure-tag-immutability` |

Inputs: `semver_tag` (`vMAJOR.MINOR.PATCH`), `expected_dev_sha` (the full 40-character SHA of the `dev` head you reviewed) and, on `release-promote.yml`, the optional `ci_workflow` (default `ci.yml`, the workflow file whose run on `dev` must have succeeded).

---

## 1. One-Time Setup

1. **Create and install the Release App.** Stage 3 of `scripts/wizards/setup-github-apps-wizard.sh --repo <owner>/<repo>` creates `<owner>-epure-release` (repository permissions `Contents: Read and write`, `Metadata: Read-only`, no webhook), installs it on that repository only, and stores two **secrets** in the `release` environment: `EPURE_RELEASE_APP_ID` (numeric App ID) and `EPURE_RELEASE_APP_PRIVATE_KEY` (PEM). The wizard always runs all stages, including the Agent App; if you only need the Release App, follow the same steps by hand and set the secrets with `gh secret set <NAME> -R <owner>/<repo> --env release`.
2. **Add the Release App as bypass actor** (`actor_type: Integration`, `actor_id: <App ID>`, `bypass_mode: always`) on every ruleset that covers `main` and `v*` tags (see the table above). In consumer repositories, `node dist/cli/setup-repo.mjs --repo <owner>/<repo> --release-app-id <App ID> --apply --apply-github-settings` does it for `epure-release-immutability` and `epure-release-tags`. Elsewhere, add the actor with `gh api` while keeping the existing actors:

   ```bash
   gh api repos/<owner>/<repo>/rulesets/<ruleset-id> \
     | jq '{name, target, enforcement, conditions, rules,
            bypass_actors: (.bypass_actors + [{actor_id: <App ID>, actor_type: "Integration", bypass_mode: "always"}])}' \
     | gh api -X PUT repos/<owner>/<repo>/rulesets/<ruleset-id> --input -
   ```

3. **Protect the `release` environment** with at least one required reviewer and a deployment branch policy that only allows `dev`:

   ```bash
   gh api -X PUT repos/<owner>/<repo>/environments/release --input - <<'EOF'
   {
     "reviewers": [{"type": "User", "id": <reviewer-user-id>}],
     "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}
   }
   EOF
   gh api -X POST repos/<owner>/<repo>/environments/release/deployment-branch-policies \
     -f name=dev -f type=branch
   ```

---

## 2. Prerequisites Before Each Release

1. All target `feature/* -> dev` Pull Requests have been squash-merged into `dev`.
2. The `CI` workflow (`.github/workflows/ci.yml`) concluded `success` on the `dev` head.
3. You picked the next tag from the Conventional Commits since the previous tag (`fix:` -> PATCH, `feat:` -> MINOR, `!:` / `BREAKING CHANGE` -> MAJOR).

---

## 3. Trigger the Release

Dispatch the workflow **from `dev`** (the `release` environment rejects other refs), then approve the pending deployment in the **Actions** tab.

Consumer repository:

```bash
DEV_SHA="$(gh api repos/my-org/craft-calculator/branches/dev --jq .commit.sha)"
gh workflow run release.yml -R my-org/craft-calculator --ref dev \
  -f semver_tag=v1.0.0 -f expected_dev_sha="$DEV_SHA"
```

EPURE itself:

```bash
DEV_SHA="$(gh api repos/Giskard-AI/epure/branches/dev --jq .commit.sha)"
gh workflow run release-promote.yml -R Giskard-AI/epure --ref dev \
  -f semver_tag=v1.0.0 -f expected_dev_sha="$DEV_SHA"
```

---

## 4. What `release-promote.yml` Executes

1. **Validates before any write** and aborts with an `::error::` annotation when:
   - `semver_tag` does not match `vMAJOR.MINOR.PATCH` (no leading zeros);
   - `expected_dev_sha` is not a 40-character SHA equal to the current `origin/dev` head;
   - the tag already exists;
   - `origin/main` is not an ancestor of `expected_dev_sha` (no fast-forward possible);
   - the latest `CI` run for that SHA on `dev` did not conclude `success`;
   - `EPURE_RELEASE_APP_ID` or `EPURE_RELEASE_APP_PRIVATE_KEY` is missing from the `release` environment.
2. **Verifies Release App role separation** with `actions/verify-app-role` (`promote_dev_to_main` on `refs/heads/main`, from `release.yml` / `release-promote.yml`, environment `release`).
3. **Mints a short-lived installation token** with `actions/create-github-app-token`, scoped to this repository with `contents: write` only.
4. **Fast-forwards `main` and tags atomically**: creates the annotated tag on `expected_dev_sha` as `<owner>-epure-release[bot]`, then runs one `git push --atomic` of `<sha>:refs/heads/main` and `refs/tags/<tag>`. Both refs move or neither does; nothing is force-pushed, and the token is passed to `git` through the process environment only (never written to `.git/config`).
5. **Publishes the GitHub Release** with `gh release create --verify-tag --generate-notes --notes-start-tag <previous tag> --latest`.
6. **Revokes the token** in an `always()` step, even when an earlier step failed.

---

## 5. Re-Running After a Failure

Re-dispatch with the **same inputs**:

- **Failure before the push**: nothing was written; fix the cause and re-run.
- **Push done, release not published**: the workflow detects that the tag and `origin/main` already point to `expected_dev_sha`, skips the push (and the `dev` head check, since `dev` may have moved), and only publishes the GitHub Release.
- **Release already published**: the run ends with a notice and changes nothing.
- **Tag exists on another commit**: the run aborts. Release tags are immutable; choose the next version instead.

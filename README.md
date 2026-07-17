# ESPHome shared workflows

This repository contains workflows to be used by other repositories.

## Available Workflows

### Build Workflows
- `build.yml` - Build ESPHome firmware with configurable options
- `upload-to-gh-release.yml` - Upload firmware to GitHub releases
- `upload-to-r2.yml` - Upload firmware to R2 storage
- `promote-r2.yml` - Promote R2 releases
- `lock.yml` - Lock workflow

### Draft-Release Pipeline

Reusable workflows for the ready-made-project repositories' release pipeline
(draft a CalVer release, build into the draft, publish it, then push the
firmware to https://firmware.esphome.io/):
- `draft-calver-release.yml` - Create/update a CalVer (YY.M.N) draft release
  with release-drafter
- `build-to-draft-release.yml` - Build firmware and replace the draft
  release's assets
- `publish-draft-release.yml` - Patch manifest assets with the final release
  notes and publish the draft
- `publish-firmware-to-r2.yml` - Push a published release's firmware to R2
  and promote it


## Usage

See https://github.com/esphome/esphome-project-template for usage of these workflows.

## CI

Pull requests run `ci.yml`, which calls the reusable workflows from the PR's
own checkout (`uses: ./.github/workflows/...`) against the ESPHome configs in
`tests/`. It builds single-artifact, combined, and combined-single-file
scenarios, verifies the downloaded artifact layout, and exercises
`upload-to-gh-release.yml` against a draft release that is deleted afterwards.
The R2 workflows are not run end-to-end (they need Cloudflare secrets), but
they consume artifacts the same way the verified workflows do.

`ci-draft-release.yml` smoke-tests `build-to-draft-release.yml` (factory
config auto-discovery plus the nested `build.yml` call). The draft-release
jobs themselves are not exercised in CI: they only run for `workflow_run`
events in consumer repositories and need a live draft release. The same goes
for `draft-calver-release.yml`, `publish-draft-release.yml` and
`publish-firmware-to-r2.yml`, which need a consumer repository's releases,
GitHub App credentials and Cloudflare secrets.

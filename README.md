# ESPHome shared workflows

This repository contains workflows to be used by other repositories.

## Available Workflows

### Build Workflows
- `build.yml` - Build ESPHome firmware with configurable options
- `upload-to-gh-release.yml` - Upload firmware to GitHub releases
- `upload-to-r2.yml` - Upload firmware to R2 storage
- `promote-r2.yml` - Promote R2 releases
- `lock.yml` - Lock workflow


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

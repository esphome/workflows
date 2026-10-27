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
  with release-drafter, and empty its assets so the build workflows that run
  afterwards start from a clean draft
- `build-to-draft-release.yml` - Build firmware and replace the draft
  release's assets. Repositories that publish several combined manifests from
  one release pass `groups` and still call it once — see
  [Grouped builds](#grouped-builds)
- `publish-draft-release.yml` - Patch manifest assets with the final release
  notes and publish the draft
- `publish-firmware-to-r2.yml` - Push a published release's firmware to R2
  and promote it


## Usage

See https://github.com/esphome/esphome-project-template for usage of these workflows.

### Grouped builds

By default `build-to-draft-release.yml` publishes one manifest per built file.
Pass `combined-name` to merge every file into a single manifest instead:

```yaml
jobs:
  build:
    uses: esphome/workflows/.github/workflows/build-to-draft-release.yml@<ref>
    permissions:
      contents: write
    with:
      esphome-version: 2026.5.3
      files: esp32-generic.yaml
      combined-name: esp32-generic
```

A repository that publishes **several** combined manifests from the same
release passes `groups` — a JSON array of `{"name": ..., "files": [...]}` — and
still calls the workflow **once**:

```yaml
jobs:
  build:
    uses: esphome/workflows/.github/workflows/build-to-draft-release.yml@<ref>
    permissions:
      contents: write
    with:
      esphome-version: 2026.5.3
      groups: |
        [
          {"name": "esp-web-tools", "files": ["esp-web-tools/esp32.yaml", "esp-web-tools/esp8266.yaml"]},
          {"name": "esphome-web", "files": ["esphome-web/esp32.factory.yaml"]}
        ]
```

Each group builds into its own combined manifest, and every group's assets are
uploaded to the same draft release. One group may use an empty name, meaning
"publish these files as one manifest each" — for repositories that ship a
combined group alongside standalone devices:

```yaml
      groups: |
        [
          {"name": "esp32-generic", "files": ["esp32-generic/esp32-generic.factory.yaml"]},
          {"name": "", "files": ["gl-inet/gl-s10.factory.yaml", "wt32/wt32-eth01.factory.yaml"]}
        ]
```

Group these in one call rather than calling the workflow once per group.
Removing the draft's "assets pending" warning is a claim that the whole
release is built, and only one job can make it: split across a call per group,
whichever call finished first would strip the warning while the others were
still compiling, inviting a maintainer to publish a release missing a group.
One call also keeps a single upload job — `upload-to-gh-release.yml` takes
every artifact in the run, so two calls in one workflow would upload each
other's artifacts and race on identical asset names.

Per-group `files` is required. The `*.factory.yaml` auto-discovery (`files`
left empty) globs the whole repository, so it only makes sense for the
single-group form; inside `groups` it would sweep one group's configs into
another. `groups` is therefore mutually exclusive with `files` and
`combined-name`.

### Naming firmware after the YAML file

Firmware files and artifacts are named after `esphome.name` plus the chip
variant, so two configs that share a device name (for example hardware
revisions with the same hostname) collide. Pass `name-from-file: true` to name
them after the YAML file instead. The name is the file name without its
`.yaml`/`.yml` extension and without a trailing `.factory`; the chip variant is
still appended to the firmware files, and the manifest paths are rewritten to
match:

```yaml
jobs:
  build:
    uses: esphome/workflows/.github/workflows/build-to-draft-release.yml@<ref>
    permissions:
      contents: write
    with:
      esphome-version: 2026.5.3
      name-from-file: true
      files: |
        my-device-rev-a.factory.yaml
        my-device-rev-b.factory.yaml
```

With both files declaring `name: my-device` on an ESP32-C3, this publishes
`my-device-rev-a-esp32c3.factory.bin` and `my-device-rev-b-esp32c3.factory.bin`
(plus a manifest each) instead of two files named `my-device-esp32c3.factory.bin`.
`build.yml` accepts the same input.

### Excluding files from discovery

`exclude-files` drops matching files from the build after `files` or
auto-discovery has settled, so a repository can keep discovering every
`*.factory.yaml` while skipping a config it builds separately. Patterns are
globs matched against the whole repository-relative path, and `*` spans `/`:

```yaml
jobs:
  build:
    uses: esphome/workflows/.github/workflows/build-to-draft-release.yml@<ref>
    permissions:
      contents: write
    with:
      esphome-version: 2026.5.3
      # Discover every *.factory.yaml except the minimal variant, which is
      # built on its own elsewhere. No need to list the kept configs.
      exclude-files: "*.minimal.factory.yaml"
```

`exclude-files` is mutually exclusive with `groups`, which already lists each
group's files explicitly.

### Draft asset lifecycle

`build-to-draft-release.yml` never deletes the draft's assets; it only adds
them. `draft-calver-release.yml` empties the draft when release-drafter
re-applies the release notes (and with them the "assets pending" warning),
which happens before the build workflows are triggered.

That placement is deliberate. It is the only point where deleting every asset
is unambiguous: nothing is building yet, so anything still attached is from an
earlier build of the same draft. A clean running alongside the builds cannot
tell a stale asset from one another build has just uploaded.

Consequently a repository must use **both** halves of the pipeline. A
repository whose Release Drafter workflow does not call
`draft-calver-release.yml` never empties its draft, and assets for a device
that is later renamed or removed will linger on it.

## CI

Pull requests run `ci.yml`, which calls the reusable workflows from the PR's
own checkout (`uses: ./.github/workflows/...`) against the ESPHome configs in
`tests/`. It builds single-artifact, combined, combined-single-file,
and name-from-file scenarios, verifies the downloaded artifact layout, and exercises
`upload-to-gh-release.yml` against a draft release that is deleted afterwards.
The R2 workflows are not run end-to-end (they need Cloudflare secrets), but
they consume artifacts the same way the verified workflows do.

`ci-draft-release.yml` smoke-tests `build-to-draft-release.yml`: factory
config auto-discovery with `name-from-file` (with an `exclude-files` pattern
that must drop one of the discovered configs) plus the nested `build.yml` call,
and a `groups`
call that checks each group produces its own combined manifest without
absorbing another group's builds. The draft-release jobs themselves are not
exercised
in CI: they only run for `workflow_run` events in consumer repositories and
need a live draft release. The same goes
for `draft-calver-release.yml`, `publish-draft-release.yml` and
`publish-firmware-to-r2.yml`, which need a consumer repository's releases,
GitHub App credentials and Cloudflare secrets.

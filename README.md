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

## Secrets file

The `secrets.yaml` file can be injected into the build as a GitHub Action secret.

To do so, create a file like something below:

```yaml
wifi_ssid: MyWiFi
wifi_password: mywifipassword

# For more on this, see docs: https://esphome.io/components/api.html#configuration-variables
encryption_key: "QQXcWdXZzCuNT3tTtU33nTiqvxkbR1nWIf4lh6W8MA0="
```

Then base64 encode it and upload it the environment provided with the name `ESPHOME_SECRETS_YAML` and the value base64 encoded.

On macOS, to base64 encode quickly:

```
pbpaste | base64 | pbcopy
```

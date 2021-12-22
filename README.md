# ESPHome shared workflows

This repository contains workflows to be used by other repositories.


## Build and publish firmware with GitHub Pages and ESP Web Tools

```yaml
name: Build example

on:
  push:
    branches:
      - main

jobs:
  build:
    uses: esphome/build-action/.github/workflows/build.yml@main
    with:
      files: esp32.yml,esp8266.yml
```

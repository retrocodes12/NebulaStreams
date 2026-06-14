# Nebula Sports webOS

Thin webOS wrapper for Nebula Sports.

Build:

```bash
npx -y -p @webos-tools/cli ares-package webos/nebula-sports -o dist/webos
```

Install on TV with Developer Mode enabled:

```bash
ares-install --device <tv-name> dist/webos/com.nebulastreams.sports_1.0.1_all.ipk
```

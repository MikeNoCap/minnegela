#!/usr/bin/env bash
# Regenerate the CDI GPU spec for rootless podman. Re-run after a driver upgrade.
#
# Ubuntu 24.04 ships podman 4.9, whose CDI parser predates the spec the
# nvidia-container-toolkit >= 1.20 boot service writes to /var/run/cdi
# (cdiVersion 0.7.0, additionalGids field). Podman silently skips the
# unparseable file, so we keep a compatible copy in /etc/cdi (which the box
# made writable by the deploy user). Drop this workaround if podman >= 5.
set -euo pipefail
nvidia-ctk cdi generate 2>/dev/null | python3 -c "
import sys, yaml
def strip(o):
    if isinstance(o, dict):
        o.pop('additionalGids', None)
        for v in o.values(): strip(v)
    elif isinstance(o, list):
        for v in o: strip(v)
s = yaml.safe_load(sys.stdin)
strip(s)
s['cdiVersion'] = '0.6.0'
yaml.safe_dump(s, sys.stdout, default_flow_style=False)
" > /etc/cdi/nvidia.yaml
echo "wrote /etc/cdi/nvidia.yaml"

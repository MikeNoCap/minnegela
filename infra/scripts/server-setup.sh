#!/usr/bin/env bash
# One-time system setup for the Minnegela server (Ubuntu 24.04, Pascal GPU).
# Run as root from anywhere:  sudo infra/scripts/server-setup.sh
# Idempotent: safe to re-run. Reboots at the end if the NVIDIA driver isn't loaded yet.
#
# Interactive moments to stay at the terminal for:
#  1. `tailscale up` prints a login URL and waits for you to open it.
#  2. With Secure Boot enabled, the driver install asks you to create a MOK
#     password; at the NEXT BOOT pick "Enroll MOK" at the console and enter it.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
TARGET_USER="${SUDO_USER:-russ}"
export NEEDRESTART_MODE=a # restart services without prompting
# Wait up to 10 min for the dpkg lock instead of failing (unattended-upgrades
# often runs right after an apt update).
APT="apt-get -o DPkg::Lock::Timeout=600"

echo "== 1/6 podman + rootless plumbing =="
# The ookla/speedtest-cli repo has no noble release (404) and fails apt update; disable it.
for f in /etc/apt/sources.list.d/*; do
  if [ -f "$f" ] && grep -q "packagecloud.io/ookla" "$f"; then
    mv "$f" "$f.disabled"
    echo "disabled dead apt repo: $f"
  fi
done
$APT update
$APT install -y podman uidmap slirp4netns fuse-overlayfs

echo "== 2/6 tailscale =="
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

echo "== 3/6 rootless bits: caddy on :80, containers survive logout/boot =="
echo 'net.ipv4.ip_unprivileged_port_start=80' > /etc/sysctl.d/99-minnegela.conf
sysctl -p /etc/sysctl.d/99-minnegela.conf
loginctl enable-linger "$TARGET_USER"
sudo -u "$TARGET_USER" XDG_RUNTIME_DIR="/run/user/$(id -u "$TARGET_USER")" \
  systemctl --user enable podman-restart.service 2>/dev/null \
  || echo "note: podman-restart user service not enabled yet; harmless, retry after reboot"

echo "== 4/6 NVIDIA driver (Pascal: 580 is the last supporting branch; pinned) =="
if mokutil --sb-state 2>/dev/null | grep -qi enabled; then
  cat <<'MSG'
  *** Secure Boot is ENABLED. ***
  The install will ask you to create a MOK password. At the next boot, be at
  the box's physical console: a blue "MOK management" screen appears; choose
  "Enroll MOK" and enter that password, or the driver will not load.
  (Alternative: disable Secure Boot in the BIOS and re-run this script.)
MSG
fi
if nvidia-smi >/dev/null 2>&1; then
  echo "driver already loaded, skipping install"
elif apt-cache show nvidia-driver-580 >/dev/null 2>&1; then
  $APT install -y nvidia-driver-580
  apt-mark hold nvidia-driver-580 || true
else
  echo "nvidia-driver-580 not in apt; falling back to the distro recommendation:"
  $APT install -y ubuntu-drivers-common
  ubuntu-drivers list || true
  ubuntu-drivers install
fi

echo "== 5/6 nvidia-container-toolkit + CDI spec at every boot =="
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  > /etc/apt/sources.list.d/nvidia-container-toolkit.list
$APT update
$APT install -y nvidia-container-toolkit

# podman's `nvidia.com/gpu=all` devices need /etc/cdi/nvidia.yaml; regenerate it
# each boot (driver updates change it). Newer toolkits ship a refresh unit.
if [ -f /usr/lib/systemd/system/nvidia-cdi-refresh.service ]; then
  systemctl enable nvidia-cdi-refresh.path 2>/dev/null || systemctl enable nvidia-cdi-refresh.service || true
else
  cat > /etc/systemd/system/nvidia-cdi.service <<'UNIT'
[Unit]
Description=Generate NVIDIA CDI spec for container GPU access
After=systemd-modules-load.service

[Service]
Type=oneshot
ExecStartPre=/usr/bin/nvidia-smi
ExecStart=/usr/bin/nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable nvidia-cdi.service
fi

echo "== 6/6 summary =="
echo "podman:      $(podman --version 2>/dev/null || echo MISSING)"
echo "tailscale:   $(tailscale ip -4 2>/dev/null | head -1 || echo 'not up')"
echo "secure boot: $(mokutil --sb-state 2>/dev/null || echo unknown)"

if nvidia-smi >/dev/null 2>&1; then
  echo "NVIDIA driver loaded; generating CDI spec now."
  nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
  echo "All done. No reboot needed."
else
  echo "Rebooting in 15s to load the NVIDIA driver (Ctrl-C to cancel)."
  sleep 15
  reboot
fi

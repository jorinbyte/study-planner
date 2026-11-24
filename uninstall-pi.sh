#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# StudyFlow — Raspberry Pi Uninstaller
# Usage: sudo ./uninstall-pi.sh          (keeps your data/ folder)
#        sudo ./uninstall-pi.sh --purge  (also deletes /etc/studyflow.env & data/)
# ============================================================================

SERVICE_NAME="studyflow"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PURGE=0

if [[ "${1:-}" == "--purge" ]]; then
  PURGE=1
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Re-running with sudo..."
  exec sudo bash "$0" "$@"
fi

echo "Stopping and removing ${SERVICE_NAME}.service..."
systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true
rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload

if [[ "${PURGE}" -eq 1 ]]; then
  echo "Purging /etc/${SERVICE_NAME}.env and ${SCRIPT_DIR}/data..."
  rm -f "/etc/${SERVICE_NAME}.env"
  rm -rf "${SCRIPT_DIR}/data"
else
  echo "Service removed. Your database & uploads in ${SCRIPT_DIR}/data were preserved."
fi

echo "StudyFlow uninstalled."

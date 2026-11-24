#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# StudyFlow — Raspberry Pi 5 Installer (LAN-accessible systemd service on :8080)
# Usage: sudo ./install-pi.sh
# ============================================================================

PORT="${PORT:-8080}"
HOST="${HOST:-0.0.0.0}"
SERVICE_NAME="studyflow"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Re-running with sudo..."
  exec sudo PORT="${PORT}" HOST="${HOST}" bash "$0" "$@"
fi

RUN_USER="${SUDO_USER:-$(stat -c '%U' "${SCRIPT_DIR}")}"
if [[ -z "${RUN_USER}" || "${RUN_USER}" == "root" ]]; then
  RUN_USER="root"
fi
RUN_GROUP="$(id -gn "${RUN_USER}")"

echo "============================================================"
echo "  Installing StudyFlow on Raspberry Pi"
echo "  Directory : ${SCRIPT_DIR}"
echo "  User      : ${RUN_USER}:${RUN_GROUP}"
echo "  Address   : http://${HOST}:${PORT} (LAN visible)"
echo "============================================================"

# 1. Verify Python 3 is available
if ! command -v python3 >/dev/null 2>&1; then
  echo "[1/5] python3 not found — installing via apt..."
  apt-get update -qq
  apt-get install -y python3
else
  echo "[1/5] Found $(python3 --version)"
fi

PYTHON_BIN="$(command -v python3)"

# 2. Prepare data directory with proper permissions
echo "[2/5] Preparing data directory..."
mkdir -p "${SCRIPT_DIR}/data/uploads"
chown -R "${RUN_USER}:${RUN_GROUP}" "${SCRIPT_DIR}/data"
chmod +x "${SCRIPT_DIR}/server.py" "${SCRIPT_DIR}/start.sh" "${SCRIPT_DIR}/install-pi.sh" "${SCRIPT_DIR}/uninstall-pi.sh" 2>/dev/null || true

# 3. Create optional environment file (keeps user overrides across upgrades)
ENV_FILE="/etc/${SERVICE_NAME}.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[3/5] Creating ${ENV_FILE}..."
  cat > "${ENV_FILE}" <<EOF
# StudyFlow environment configuration
HOST=${HOST}
PORT=${PORT}
# Optional: you can also configure your Gemini API key in the web UI Settings page
# GEMINI_API_KEY=
EOF
  chmod 640 "${ENV_FILE}"
  chown root:"${RUN_GROUP}" "${ENV_FILE}"
else
  echo "[3/5] Keeping existing ${ENV_FILE}"
fi

# 4. Install and enable systemd service
echo "[4/5] Installing systemd service (${SERVICE_NAME}.service)..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=StudyFlow — Bachelor Study Planner & Gemini AI Companion
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
WorkingDirectory=${SCRIPT_DIR}
EnvironmentFile=-${ENV_FILE}
ExecStart=${PYTHON_BIN} -u ${SCRIPT_DIR}/server.py --host ${HOST} --port ${PORT}
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"
systemctl restart "${SERVICE_NAME}.service"

# 5. Open firewall port if UFW is active
if command -v ufw >/dev/null 2>&1; then
  if ufw status | grep -qi "Status: active"; then
    echo "[5/5] UFW firewall is active — allowing TCP port ${PORT}..."
    ufw allow "${PORT}/tcp" comment "StudyFlow Study Planner" >/dev/null
  else
    echo "[5/5] UFW installed but inactive — no firewall rule needed."
  fi
else
  echo "[5/5] No UFW firewall detected."
fi

# Wait briefly and check health endpoint
sleep 1.5
if command -v curl >/dev/null 2>&1; then
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    HEALTH_OK="OK"
  else
    HEALTH_OK="STARTING"
  fi
else
  HEALTH_OK="STARTED"
fi

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PI_HOST="$(hostname 2>/dev/null || echo 'raspberrypi')"

echo ""
echo "============================================================"
echo "  StudyFlow installed & running! (Status: ${HEALTH_OK})"
echo "------------------------------------------------------------"
echo "  Open from any device on your Wi-Fi / LAN:"
if [[ -n "${LAN_IP}" ]]; then
  echo "    -> http://${LAN_IP}:${PORT}"
fi
echo "    -> http://${PI_HOST}.local:${PORT}"
echo "    -> http://127.0.0.1:${PORT}  (on the Pi itself)"
echo "------------------------------------------------------------"
echo "  Useful commands:"
echo "    sudo systemctl status ${SERVICE_NAME}"
echo "    sudo systemctl restart ${SERVICE_NAME}"
echo "    sudo journalctl -u ${SERVICE_NAME} -f"
echo "    sudo ./uninstall-pi.sh"
echo "============================================================"
